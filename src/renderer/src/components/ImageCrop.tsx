import { useEffect, useMemo, useRef, useState } from 'react';
import type { PickedImage } from '../../../shared/api';
import '../styles/edit.css';

/**
 * Crop and rotate an image before it goes into the mod (docs/mods.md, "Crop and rotate"): a new event scene, a
 * replaced texture. The crop frame keeps the target's proportions (a scene 1592×848, a texture its own size) — drag
 * it, drag a corner to size it; ⟲ ⟳ turn by 90°, "Straighten" by up to 30°, ⇆ mirrors. The result is drawn at the
 * target size (black where the turned image leaves corners empty) and handed back as PNG; "Use as is" skips it.
 */
export function ImageCropDialog(props: {
    image: PickedImage;
    /** the size the result is made at */
    out: { w: number; h: number; };
    title: string;
    note?: string;
    onDone: (png: Uint8Array) => void;
    onAsIs: () => void;
    onCancel: () => void;
}): React.JSX.Element
{
    const { image, out } = props;
    const aspect = out.w / out.h;
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [quarter, setQuarter] = useState(0);
    const [fine, setFine] = useState(0);
    const [flip, setFlip] = useState(false);
    const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number; } | null>(null);
    const [busy, setBusy] = useState(false);
    const canvas = useRef<HTMLCanvasElement>(null);
    const drag = useRef<{ mode: 'move' | 'corner'; corner?: number; x0: number; y0: number; c0: { x: number; y: number; w: number; h: number; }; } | null>(null);

    useEffect(() =>
    {
        const url = URL.createObjectURL(new Blob([image.data as BlobPart], { type: image.mime }));
        const el = new Image();
        el.onload = () => setImg(el);
        el.src = url;
        return () => URL.revokeObjectURL(url);
    }, [image]);

    const rad = ((quarter * 90 + fine) * Math.PI) / 180;
    // the turned image's bounding box ("stage"): crop coordinates are in it
    const stage = useMemo(() =>
    {
        if (!img)
            return { w: 1, h: 1 };

        const c = Math.abs(Math.cos(rad));
        const s = Math.abs(Math.sin(rad));
        return { w: img.naturalWidth * c + img.naturalHeight * s, h: img.naturalWidth * s + img.naturalHeight * c };
    }, [img, rad]);

    // the largest frame of the target's proportions, centred (again after each turn)
    useEffect(() =>
    {
        if (!img)
            return;

        const w = Math.min(stage.w, stage.h * aspect);
        const h = w / aspect;
        setCrop({ x: (stage.w - w) / 2, y: (stage.h - h) / 2, w, h });
    }, [img, stage.w, stage.h, aspect]);

    const VIEW = { w: 860, h: 480 };
    const scale = Math.min(VIEW.w / stage.w, VIEW.h / stage.h);

    const drawImage = (ctx: CanvasRenderingContext2D): void =>
    {
        if (!img)
            return;

        ctx.translate(stage.w / 2, stage.h / 2);
        ctx.rotate(rad);
        ctx.scale(flip ? -1 : 1, 1);
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    };

    useEffect(() =>
    {
        const cv = canvas.current;

        if (!cv || !img || !crop)
            return;

        cv.width = Math.round(stage.w * scale);
        cv.height = Math.round(stage.h * scale);
        const ctx = cv.getContext('2d')!;
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.save();
        ctx.scale(scale, scale);
        ctx.imageSmoothingQuality = 'high';
        drawImage(ctx);
        ctx.restore();
        // outside the frame: dimmed
        const r = { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale };
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, cv.width, r.y);
        ctx.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
        ctx.fillRect(0, r.y, r.x, r.h);
        ctx.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);
        ctx.strokeStyle = '#e0c27c';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        // thirds
        ctx.strokeStyle = 'rgba(224, 194, 124, 0.35)';
        ctx.lineWidth = 1;

        for (let i = 1; i < 3; i++)
        {
            ctx.beginPath();
            ctx.moveTo(r.x + (r.w * i) / 3, r.y);
            ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
            ctx.moveTo(r.x, r.y + (r.h * i) / 3);
            ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
            ctx.stroke();
        }

        ctx.fillStyle = '#e0c27c';

        for (const [cx, cy] of corners(r))
            ctx.fillRect(cx - 5, cy - 5, 10, 10);
    });

    const corners = (r: { x: number; y: number; w: number; h: number; }): [number, number][] => [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h]
    ];

    /** A frame kept inside the stage (moved back in; a corner drag: shrunk to fit). */
    const clamp = (c: { x: number; y: number; w: number; h: number; }): { x: number; y: number; w: number; h: number; } =>
    {
        let { w, h } = c;

        if (w > stage.w)
            (w = stage.w), (h = w / aspect);

        if (h > stage.h)
            (h = stage.h), (w = h * aspect);

        const x = Math.min(Math.max(0, c.x), stage.w - w);
        const y = Math.min(Math.max(0, c.y), stage.h - h);
        return { x, y, w, h };
    };

    const onDown = (e: React.PointerEvent<HTMLCanvasElement>): void =>
    {
        if (!crop)
            return;

        const b = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - b.left;
        const py = e.clientY - b.top;
        const r = { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale };
        const corner = corners(r).findIndex(([cx, cy]) => Math.abs(px - cx) < 10 && Math.abs(py - cy) < 10);

        if (corner >= 0)
            drag.current = { mode: 'corner', corner, x0: px, y0: py, c0: crop };
        else if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
            drag.current = { mode: 'move', x0: px, y0: py, c0: crop };
        else
            return;

        try
        {
            e.currentTarget.setPointerCapture(e.pointerId);
        }
        catch
        {
            // (no capture: the drag still follows while the pointer stays on the picture)
        }
    };

    const onMove = (e: React.PointerEvent<HTMLCanvasElement>): void =>
    {
        const d = drag.current;

        if (!d)
            return;

        const b = e.currentTarget.getBoundingClientRect();
        const dx = (e.clientX - b.left - d.x0) / scale;
        const dy = (e.clientY - b.top - d.y0) / scale;
        const c = d.c0;

        if (d.mode === 'move')
        {
            setCrop(clamp({ ...c, x: c.x + dx, y: c.y + dy }));
            return;
        }

        // (a corner: the opposite one stays; the frame keeps its proportions)
        const left = d.corner === 0 || d.corner === 2;
        const top = d.corner === 0 || d.corner === 1;
        const ax = left ? c.x + c.w : c.x;
        const ay = top ? c.y + c.h : c.y;
        let w = Math.max(20, left ? c.w - dx : c.w + dx, (top ? c.h - dy : c.h + dy) * aspect);
        w = Math.min(w, left ? ax : stage.w - ax, (top ? ay : stage.h - ay) * aspect);
        const h = w / aspect;
        setCrop({ x: left ? ax - w : ax, y: top ? ay - h : ay, w, h });
    };

    const finish = async (): Promise<void> =>
    {
        if (!img || !crop || busy)
            return;

        setBusy(true);
        const cv = document.createElement('canvas');
        cv.width = out.w;
        cv.height = out.h;
        const ctx = cv.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, out.w, out.h);
        ctx.imageSmoothingQuality = 'high';
        ctx.scale(out.w / crop.w, out.h / crop.h);
        ctx.translate(-crop.x, -crop.y);
        drawImage(ctx);
        const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
        setBusy(false);

        if (blob)
            props.onDone(new Uint8Array(await blob.arrayBuffer()));
    };

    const reset = (): void =>
    {
        setQuarter(0);
        setFine(0);
        setFlip(false);
    };

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
            <div
                className="crop-dialog"
                tabIndex={-1}
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        props.onCancel();

                    if (e.key === 'Enter')
                        void finish();
                }}
            >
                <div className="sc-head">
                    <h3>{props.title}</h3>
                    <span className="ne-note">
                        {image.name}
                        {img ? ` · ${img.naturalWidth}×${img.naturalHeight}` : ''} → {out.w}×{out.h}
                    </span>
                </div>
                <div className="crop-stage" style={{ width: VIEW.w, height: VIEW.h }}>
                    {img ? <canvas ref={canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} /> : <span className="ne-note">…</span>}
                </div>
                <div className="crop-tools">
                    <button title="Turn left by 90°" onClick={() => setQuarter((q) => (q + 3) % 4)}>
                        ⟲ 90°
                    </button>
                    <button title="Turn right by 90°" onClick={() => setQuarter((q) => (q + 1) % 4)}>
                        ⟳ 90°
                    </button>
                    <button className={flip ? 'on' : ''} title="Mirror left–right" onClick={() => setFlip((f) => !f)}>
                        ⇆ Mirror
                    </button>
                    <label className="crop-fine" title="Turn by a little, to straighten a horizon">
                        Straighten
                        <input type="range" min={-30} max={30} step={0.5} value={fine} onChange={(e) => setFine(Number(e.target.value))} />
                        <span>{fine > 0 ? '+' : ''}{fine}°</span>
                    </label>
                    <button className="ghost small" onClick={reset}>
                        Reset
                    </button>
                </div>
                {props.note && <div className="ne-note">{props.note}</div>}
                <div className="ne-actions">
                    <button onClick={props.onCancel}>Cancel</button>
                    <button title="The file as it is — not cropped (converted as usual)" onClick={props.onAsIs}>
                        Use as is
                    </button>
                    <button className="primary" disabled={!img || busy} onClick={() => void finish()}>
                        {busy ? 'Cropping…' : 'Crop & use'}
                    </button>
                </div>
            </div>
        </div>
    );
}
