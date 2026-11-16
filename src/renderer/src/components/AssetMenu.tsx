import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AssetOverride, ImageSource, PickedImage } from '../../../shared/api';
import { createPortal } from 'react-dom';
import { imgUrl } from '../img';
import { ImageCropDialog } from './ImageCrop';
import { api } from '../api';
import type { Navigate } from '../App';
import { reportChange } from '../changes';
import { useActiveMod } from '../modStore';
import { pushNotice, type NoticeAction } from '../notices';
import { errorText } from './ModDialogs';
import { MODS_ROUTE } from './ModsView';
import '../styles/edit.css';

import { tr } from '../../../shared/i18n';
const base = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/**
 * An asset's ⋯ menu (textures, meshes, an .asset's pdxmesh; docs/mods.md "Replacing assets"): export its file as it
 * is, a texture as PNG, a mesh as glTF for Blender; replace it in the active mod with a file of one's own, converted
 * to the asset's format and saved under its path and name, whatever the file is called. Clicks stay in the menu (tiles
 * around it open the asset).
 */
export function AssetMenu(props: { path: string; pdxmesh?: string; navigate: Navigate; className?: string; }): React.JSX.Element
{
    const { path, pdxmesh, navigate } = props;
    const mesh = /\.(mesh|asset)$/i.test(path);
    const active = useActiveMod();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    // the active mod's own file for the asset (read when the menu opens); the removal asks with a second click
    const [own, setOwn] = useState<AssetOverride | null>(null);
    const [confirm, setConfirm] = useState(false);
    const box = useRef<HTMLSpanElement>(null);
    // the menu is drawn over everything (a portal, fixed): scrolling panes don't cut it off; kept inside the window
    const pop = useRef<HTMLSpanElement>(null);
    const [at, setAt] = useState<{ left: number; top: number; } | null>(null);

    useLayoutEffect(() =>
    {
        const b = box.current?.getBoundingClientRect();
        const p = pop.current;

        if (!open || !b || !p)
            return;

        const w = p.offsetWidth;
        const h = p.offsetHeight;
        const left = Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8));
        const below = b.bottom + 4;
        const top = below + h > window.innerHeight - 8 && b.top - 4 - h >= 8 ? b.top - 4 - h : Math.max(8, Math.min(below, window.innerHeight - h - 8));
        setAt((o) => (o && o.left === left && o.top === top ? o : { left, top }));
    });

    useEffect(() =>
    {
        if (!open)
            return;

        setConfirm(false);
        let alive = true;
        void api.assetOverride(path, pdxmesh).then(
            (o) => alive && setOwn(o),
            () => alive && setOwn(null)
        );
        return () =>
        {
            alive = false;
        };
    }, [open, path, pdxmesh, active.id]);

    useEffect(() =>
    {
        if (!open)
            return;

        const onDown = (e: MouseEvent): void =>
        {
            if (!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node))
                setOpen(false);
        };
        // (the menu stays where it opened: scrolling what is under it closes it)
        const onScroll = (e: Event): void =>
        {
            if (!pop.current?.contains(e.target as Node))
                setOpen(false);
        };
        window.addEventListener('scroll', onScroll, true);
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
            setAt(null);
        };
    }, [open]);

    const run = (fn: () => Promise<void>) => (): void =>
    {
        setOpen(false);
        setBusy(true);
        void fn().finally(() => setBusy(false));
    };

    const exportAs = (as: 'original' | 'png' | 'gltf') =>
        run(async () =>
        {
            try
            {
                const r = await api.exportAsset(path, as, pdxmesh);

                if (!r)
                    return;

                pushNotice({
                    kind: 'ok',
                    title: as === 'gltf' ? tr('Exported for Blender') : as === 'png' ? tr('Exported as PNG') : tr('Exported'),
                    text: r.file,
                    details: as === 'gltf' ? [tr('In Blender: File › Import › glTF 2.0; bring it back with “Replace with a file…” or “Import from Blender…”.'), ...(r.gltf?.warnings ?? []).map((w) => '⚠ ' + w)] : undefined,
                    actions: [{ label: tr('Reveal'), run: () => void api.revealFile(r.file) }]
                });
            }
            catch (e)
            {
                pushNotice({ kind: 'error', title: tr('Export failed'), text: errorText(e) });
            }
        });

    // (a texture: the picked image in the crop & rotate dialog, at the texture's own size)
    const [cropping, setCropping] = useState<{ pic: PickedImage; w: number; h: number; } | null>(null);
    const pickTexture = run(async () =>
    {
        try
        {
            const pic = await api.pickImage(tr('Replace {name} — saved under that name, converted to its format', { name: base(path) }));

            if (!pic)
                return;

            const size = await new Promise<{ w: number; h: number; }>((resolve) =>
            {
                const el = new Image();
                el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
                el.onerror = () => resolve({ w: 0, h: 0 });
                el.src = imgUrl(path);
            });

            // (the texture's size unknown: the picked image's own, cropped freely at its proportions)
            if (!size.w || !size.h)
            {
                const el = new Image();
                const url = URL.createObjectURL(new Blob([pic.data as BlobPart], { type: pic.mime }));
                await new Promise((r) => ((el.onload = r), (el.onerror = r), (el.src = url)));
                URL.revokeObjectURL(url);
                size.w = el.naturalWidth || 1024;
                size.h = el.naturalHeight || 1024;
            }

            setCropping({ pic, ...size });
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Not replaced'), details: [errorText(e)] });
        }
    });

    const replaceWith = (source?: ImageSource) =>
        run(async () =>
        {
            setCropping(null);
            await replaceNow(source);
        });

    const replace = run(async () =>
    {
        await replaceNow();
    });

    const replaceNow = async (source?: ImageSource): Promise<void> =>
    {
        try
        {
            const r = await api.replaceAsset(path, pdxmesh, source);

            if (!r)
                return;

            const actions: NoticeAction[] = [{ label: tr('Reveal'), run: () => void api.revealFile(r.files[0].abs) }];

            if (!r.reindex)
                actions.push({ label: tr('Open the Mods page'), run: () => navigate({ type: MODS_ROUTE }) });

            reportChange({
                kind: 'ok',
                text: tr('Replaced {file} with {source}', { file: base(r.files[0]?.rel ?? path), source: base(r.source) }),
                mod: r.mod.name,
                where: r.files[0]?.rel,
                details: [
                    ...r.files.map((f) => `${f.rel}: ${f.what}`),
                    ...r.notes,
                    ...r.warnings.map((w) => '⚠ ' + w),
                    ...(r.reindex ? [] : [tr('{name} is not in the loaded mod list: the explorer does not show the change.', { name: r.mod.name })])
                ],
                actions,
                undo: r.step
            });
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Not replaced'), details: [errorText(e)] });
        }
    };

    const removeOverride = run(async () =>
    {
        try
        {
            const r = await api.removeAssetOverride(path, pdxmesh);
            reportChange({
                kind: 'ok',
                text: tr('Removed the override of {base}', { base: base(r.rel) }),
                mod: r.mod,
                where: r.rel,
                details: [tr('The file is in the recycle bin; the game\'s (or an earlier mod\'s) {base} counts again.', { base: base(r.rel) }), ...(r.loaded ? [] : [tr('{mod} is not in the loaded mod list: the explorer does not show the change.', { mod: r.mod })])],
                undo: r.step
            });
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Not removed'), details: [errorText(e)] });
        }
    });

    const noMod = !active.mod ? tr('Set an active mod first (Mods page: New mod…, or a mod’s ⋯ → Set as active mod).') : !active.mod.editable ? tr('{name} can’t be edited here (only unpacked mods in your mod folder).', { name: active.mod.name }) : undefined;
    const items: { label: string; title: string; go: () => void; disabled?: string; }[] = mesh
        ? [
            { label: tr('Export for Blender (glTF)…'), title: tr('The mesh as glTF 2.0 with its textures as PNG — for Blender'), go: exportAs('gltf') },
            { label: tr('Export the .mesh file…'), title: tr('The game’s file as it is'), go: exportAs('original') },
            { label: tr('Replace with a file…'), title: tr('A .mesh, or a glTF / GLB from Blender — saved in {mod} under this mesh’s path and name', { mod: active.mod?.name ?? tr('the active mod') }), go: replace, disabled: noMod }
        ]
        : [
            { label: tr('Export as PNG…'), title: tr('The texture decoded to a PNG image (all channels, full size)'), go: exportAs('png') },
            { label: tr('Export the file (.{pop})…', { pop: path.split('.').pop() }), title: tr('The game’s file as it is'), go: exportAs('original') },
            { label: tr('Replace with a file…'), title: tr('A PNG, DDS, JPEG or WebP — cropped and turned if wanted, converted to this texture’s format and saved in {mod} under its path and name', { mod: active.mod?.name ?? tr('the active mod') }), go: pickTexture, disabled: noMod }
        ];

    return (
        <span className={'asset-menu' + (props.className ? ' ' + props.className : '')} ref={box} onClick={(e) => e.stopPropagation()}>
            <button className={'am-btn' + (open ? ' on' : '')} title={mesh ? tr('Export or replace this mesh') : tr('Export or replace this texture')} disabled={busy} onClick={() => setOpen(!open)}>
                {busy ? '…' : '⋯'}
            </button>
            {open &&
                createPortal(
                    <span className="am-pop" ref={pop} onClick={(e) => e.stopPropagation()} style={at ? { left: at.left, top: at.top } : { visibility: 'hidden', left: 0, top: 0 }}>
                        {items.map((i) => (
                            <button key={i.label} className="am-item" title={i.disabled ?? i.title} disabled={!!i.disabled} onClick={i.go}>
                                {i.label}
                            </button>
                        ))}
                        {own?.file && (
                            <button
                                className={'am-item danger' + (confirm ? ' confirm' : '')}
                                title={tr('Deletes {file} (to the recycle bin): the game’s file counts again', { file: own.file })}
                                onClick={confirm ? removeOverride : () => setConfirm(true)}
                            >
                                {confirm ? tr('Really remove it from {mod}? Click again', { mod: own.mod }) : tr('Remove the override from {mod}…', { mod: own.mod })}
                            </button>
                        )}
                        {active.mod && !noMod && <small className="am-note">{own?.file ? tr('{mod} has its own {base}', { mod: own.mod, base: base(own.rel) }) : tr('Replacing writes into {name}', { name: active.mod.name })}</small>}
                    </span>,
                    document.body
                )}
            {cropping &&
                createPortal(
                    <ImageCropDialog
                        image={cropping.pic}
                        out={{ w: cropping.w, h: cropping.h }}
                        title={tr('Replace {base}: crop & rotate', { base: base(path) })}
                        note={tr('The frame keeps the texture\'s shape ({w}×{h}); the result is converted to its format and saved in {mod} under its path and name.', { w: cropping.w, h: cropping.h, mod: active.mod?.name ?? tr('the active mod') })}
                        onDone={(png) => replaceWith({ png, name: cropping.pic.name })()}
                        onAsIs={() => replaceWith({ file: cropping.pic.file })()}
                        onCancel={() => setCropping(null)}
                    />,
                    document.body
                )}
        </span>
    );
}
