/**
 * The 3D map (docs/map.md, "3D map"): the terrain from the heightmap with the mode's colours on it (map3d.ts), the
 * game's camera (map3dCamera.ts), names (map3dLabels.ts). Loads the terrain's rasters (built on first use: api.mapTerrain).
 */
import { useEffect, useRef, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import { api } from '../../api';
import { imgUrl } from '../../img';
import { Map3D, RASTER_RIVERS, type Terrain } from './map3d';
import { drawLabels3d } from './map3dLabels';
import { attachOverlays } from './map3dOverlays';
import type { Groups, Mode, Style } from './model';
import { fetchRaster } from './raster';
import { track } from '../../pending';
import { hook } from '../../testApi';
import '../../styles/map3d.css';

export interface Map3DProps
{
    info: MapInfo;
    ids: Uint16Array;
    groups: Groups;
    mode: Mode;
    style: Style;
    /** the selected province, the hovered one (−1: none) */
    sel: number;
    hover: number;
    /** a province under the pointer (−1: none; x/y relative to the view's element) */
    onHover: (p: number, x: number, y: number) => void;
    /** a click on a province (−1: none) */
    onSelect: (p: number) => void;
    /** map pixels to bring into view (x0 y0 x1 y1), changed to move there */
    focus?: [number, number, number, number];
}

/** A picture from ck3://img, or null when it cannot be loaded. */
function loadImage(path: string, w: number): Promise<HTMLImageElement | null>
{
    return track(
        new Promise((resolve) =>
        {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = imgUrl(path, w);
        })
    );
}

export function Map3DView(props: Map3DProps): React.JSX.Element
{
    const { info, ids, groups, style } = props;
    const box = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const labels = useRef<HTMLCanvasElement>(null);
    const [terrain, setTerrain] = useState<Terrain | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [map, setMap] = useState<Map3D | null>(null);
    // the props the event handlers and frames read
    const live = useRef(props);
    live.current = props;
    const focused = useRef<[number, number, number, number] | undefined>(undefined);
    const pointer = useRef<{ x: number; y: number; hovered: number; drag?: { button: number; turn: boolean; x0: number; y0: number; moved: boolean; }; } | null>(null);
    // the compass's needle (turned with the view on every frame, not through React)
    const needle = useRef<HTMLSpanElement>(null);

    // the terrain's rasters (the first time builds them)
    useEffect(() =>
    {
        let on = true;
        setError(null);
        setTerrain(null);
        api
            .mapTerrain()
            .then(async (t) =>
            {
                if (!t)
                    throw new Error('The loaded game files have no heightmap');

                const [h, r] = await Promise.all([
                    fetchRaster(`${t.key}-height.bin`), // (the rivers raster only when the shader draws them: the smooth lines are an overlay, map3dOverlays.ts)
                    RASTER_RIVERS && t.rivers
                        ? fetchRaster(`${t.key}-rivers.bin`)
                        : null
                ]);

                if (on)
                    setTerrain({ info: t, heights: new Uint16Array(h), rivers: r && new Uint8Array(r) });
            })
            .catch((e: Error) => on && setError(e.message));
        return () =>
        {
            on = false;
        };
    }, [info.key]);

    /** The province under a canvas point (−1: none). */
    const provinceAt = (m: Map3D, x: number, y: number): number =>
    {
        const at = m.pick(x, y);

        if (!at)
            return -1;

        const { info: i, ids: r } = live.current;
        return r[Math.floor(at[1]) * i.width + Math.floor(at[0])] ?? -1;
    };

    // the scene (the camera stays through dates, modes and styles)
    useEffect(() =>
    {
        const cv = canvas.current;

        if (!cv || !terrain)
            return;

        let m: Map3D;

        try
        {
            m = new Map3D(cv, live.current.info, live.current.ids, terrain);
        }
        catch (e)
        {
            setError((e as Error).message);
            return;
        }

        attachOverlays(m, live.current.info, terrain);
        focused.current = live.current.focus;

        if (focused.current)
            m.cam.focus(focused.current, true);
        else
            m.cam.overview();

        const scene = { camera: m.cam.camera, zoom: 0, largeNames: terrain.info.camera.largeNames, surface: (x: number, z: number) => m.surface(x, z) };
        m.onFrame = () =>
        {
            const l = live.current;
            scene.zoom = m.cam.zoom;

            if (needle.current)
                needle.current.style.transform = `rotate(${m.cam.heading}rad)`;

            if (labels.current)
                drawLabels3d(labels.current, scene, l.info, l.ids, l.groups, l.style);

            // (the camera moved under a still pointer: what is under it now)
            const pt = pointer.current;

            if (pt && !pt.drag)
            {
                const p = provinceAt(m, pt.x, pt.y);

                if (p !== pt.hovered)
                    live.current.onHover(pt.hovered = p, pt.x, pt.y);
            }
        };
        m.invalidate();
        // (a hover from the 2D view is elsewhere here)
        live.current.onHover(-1, 0, 0);
        const ro = new ResizeObserver(() => m.resize());
        ro.observe(cv);
        setMap(m);
        // the test API (testApi.ts: its loads count as in flight) and scripts/drive.mjs eval steps: the live view
        track(m.loaded);
        const unhook = hook('map3d', m);
        const w = window as unknown as { __map3d?: Map3D; };
        w.__map3d = m;
        return () =>
        {
            ro.disconnect();
            unhook();

            if (w.__map3d === m)
                w.__map3d = undefined;

            setMap(null);
            m.dispose();
        };
    }, [terrain]);

    // (a new date reads the raster again)
    useEffect(() =>
    {
        map?.setIds(ids);
    }, [map, ids]);

    // the water's colour map
    useEffect(() =>
    {
        const path = terrain?.info.waterImage;

        if (!map || !path)
            return;

        let on = true;
        void loadImage(path, 2048).then((img) => on && img && map.setWater(img));
        return () =>
        {
            on = false;
        };
    }, [map, terrain]);

    // what is under the colours
    useEffect(() =>
    {
        if (!map)
            return;

        const path = style === 'paper' ? info.paperImage : style === 'terrain' ? info.terrainImage : undefined;

        if (!path)
            return map.setStyle(style, null);

        let on = true;
        void loadImage(path, 4096).then((img) => on && map.setStyle(style, img));
        return () =>
        {
            on = false;
        };
    }, [map, style, info.paperImage, info.terrainImage]);

    useEffect(() =>
    {
        map?.setGroups(live.current.info, groups);
    }, [map, groups]);

    useEffect(() =>
    {
        map?.setHighlight(props.hover >= 0 ? groups.of[props.hover] + 1 : 0, props.sel >= 0 ? groups.of[props.sel] + 1 : 0);
    }, [map, groups, props.hover, props.sel]);

    useEffect(() =>
    {
        if (!map || !props.focus || props.focus === focused.current)
            return;

        focused.current = props.focus;
        map.cam.focus(props.focus);
        map.invalidate();
    }, [map, props.focus]);

    const local = (e: { clientX: number; clientY: number; }): [number, number] =>
    {
        const r = box.current!.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };
    const onDown = (e: React.PointerEvent): void =>
    {
        if (e.button > 2)
            return;

        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const [x, y] = local(e);
        // (the right or middle button turns and tilts; the left one with Shift or Alt too — touchpads)
        pointer.current = { x, y, hovered: -1, drag: { button: e.button, turn: e.button !== 0 || e.shiftKey || e.altKey, x0: x, y0: y, moved: false } };
        live.current.onHover(-1, x, y);
    };
    const onMove = (e: React.PointerEvent): void =>
    {
        if (!map)
            return;

        const [x, y] = local(e);
        const pt = pointer.current ?? { x, y, hovered: -1 };
        const d = pt.drag;

        if (d)
        {
            if (!d.moved && Math.abs(x - d.x0) + Math.abs(y - d.y0) > 3)
                d.moved = true;

            if (d.moved)
            {
                if (d.turn)
                    map.cam.rotate(x - pt.x, y - pt.y);
                else
                    map.cam.pan([pt.x, pt.y], [x, y]);

                map.invalidate();
            }
        }
        else
        {
            const p = provinceAt(map, x, y);

            if (p !== pt.hovered)
                live.current.onHover(pt.hovered = p, x, y);
            else if (p >= 0)
                live.current.onHover(p, x, y);
        }

        pt.x = x;
        pt.y = y;
        pointer.current = pt;
    };
    const onUp = (e: React.PointerEvent): void =>
    {
        const d = pointer.current?.drag;

        if (pointer.current)
            pointer.current.drag = undefined;

        if (!map || !d || d.moved || e.button !== 0 || d.button !== 0 || d.turn)
            return;

        const [x, y] = local(e);
        live.current.onSelect(provinceAt(map, x, y));
    };
    const onWheel = (e: React.WheelEvent): void =>
    {
        if (!map)
            return;

        const [x, y] = local(e);
        map.cam.wheel(e.deltaY, x, y);
        map.invalidate();
    };

    return (
        <div
            className="map3d"
            ref={box}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onWheel={onWheel}
            onPointerLeave={() =>
            {
                pointer.current = null;
                live.current.onHover(-1, 0, 0);
            }}
            onContextMenu={(e) => e.preventDefault()}
        >
            <canvas ref={canvas} />
            <canvas ref={labels} className="map-labels" />
            {!map && <div className="map-status">{error ?? (terrain ? 'Preparing the terrain…' : 'Reading the terrain (the first time builds it from the heightmap)…')}</div>}
            {map && <div className="map3d-hint">Drag: move · wheel: zoom · right drag or Shift + drag: turn and tilt, all the way round</div>}
            {map && (
                <button
                    className="map3d-compass"
                    title="North up (and the tilt from above)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={() =>
                    {
                        map.cam.resetNorth();
                        map.invalidate();
                    }}
                >
                    <span ref={needle}>
                        <b>N</b>
                    </span>
                </button>
            )}
        </div>
    );
}
