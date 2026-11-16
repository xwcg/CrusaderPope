/**
 * The picture chooser of a card's picture statement (LineAct 'picture': a decision's `reference = "gfx/…dds"`, a
 * 1.19 `picture = "…"`): the pictures of the current one's folder (the mods' first) with a filter, or "From an image
 * file…": a PNG / DDS of one's own, cropped to the current picture's size (ImageCropDialog), saved into the active mod
 * as DDS (main asset:picture) beside the game's. The choice is written into the statement (one replace).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GalleryFile, ImageSource, LineSource, PickedImage } from '../../../shared/api';
import { api } from '../api';
import { GameImg } from '../img';
import { fold, foldHas } from '../../../shared/fold';
import { ImageCropDialog } from './ImageCrop';
import { reportChange } from '../changes';
import { runScriptEdit } from '../scriptEdits';
import { errorText } from './ModDialogs';
import '../styles/edit.css';
import { tr } from '../../../shared/i18n';

export function PictureChooser(props: { statement: string; now: string; replace: LineSource; width?: number; height?: number; entry?: string; onClose: () => void; }): React.JSX.Element
{
    const { now, replace, onClose } = props;
    const folder = now.slice(0, now.lastIndexOf('/'));
    const [all, setAll] = useState<GalleryFile[] | null>(null);
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [cropping, setCropping] = useState<PickedImage | null>(null);
    const input = useRef<HTMLInputElement>(null);
    // (the size an image of one's own is made at: the current picture's; a decision's are 1100×440)
    const out = { w: props.width ?? 1100, h: props.height ?? 440 };

    useEffect(() =>
    {
        let alive = true;
        void api.filesIn('images', folder).then(
            (l) => alive && setAll(l),
            (e) => alive && setProblem(errorText(e))
        );
        return () =>
        {
            alive = false;
        };
    }, [folder]);

    const shown = useMemo(() =>
    {
        const words = fold(q)
            .split(/\s+/)
            .filter(Boolean);
        return (all ?? [])
            .filter((f) => !f.removed && words.every((w) => foldHas(f.file, w)))
            .sort((a, b) => Number(!!b.mod) - Number(!!a.mod) || a.file.localeCompare(b.file));
    }, [all, q]);

    /** the statement written again with the picture's path (its quotes as the game writes them) */
    const write = async (path: string): Promise<void> =>
    {
        if (path === now)
            return onClose();

        setBusy(true);
        onClose();
        await runScriptEdit({ op: 'replace', at: replace, text: `${props.statement} = "${path}"` }, tr('Changed the picture')).catch((e) => setProblem(errorText(e)));
    };

    const fromFile = async (): Promise<void> =>
    {
        setProblem(null);

        try
        {
            const pic = await api.pickImage(tr('A picture ({w}×{h}, as the one it replaces)', { w: out.w, h: out.h }));

            if (pic)
                setCropping(pic);
        }
        catch (e)
        {
            setProblem(errorText(e));
        }
    };

    const importPicture = async (source: ImageSource): Promise<void> =>
    {
        setCropping(null);

        if (busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const r = await api.importPicture(folder, props.entry ?? 'picture', source);

            if (!r)
                return;

            reportChange({ kind: 'ok', text: tr('New picture {path}', { path: r.path }), details: r.notes, file: r.files[0], undo: r.step });
            await write(r.path);
        }
        catch (e)
        {
            setProblem(errorText(e));
        }
        finally
        {
            setBusy(false);
        }
    };

    if (cropping)
        return (
            <ImageCropDialog
                image={cropping}
                out={out}
                title={tr('Picture: crop & rotate')}
                note={tr('The frame keeps the shape of the picture it replaces ({w}×{h}). Saved in your mod as DDS (BC1) in {folder}.', { w: out.w, h: out.h, folder })}
                onDone={(png) => void importPicture({ png, name: cropping.name })}
                onAsIs={() => void importPicture({ file: cropping.file })}
                onCancel={() => setCropping(null)}
            />
        );

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div
                className="scene-chooser"
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        onClose();

                    if (e.key === 'Enter' && shown[0] && document.activeElement === input.current)
                        void write(shown[0].name);
                }}
            >
                <div className="sc-head">
                    <h3>
                        {tr('Picture')}
                        <em>{folder}</em>
                    </h3>
                    <input ref={input} autoFocus value={q} placeholder={tr('Filter by file name…')} onChange={(e) => setQ(e.target.value)} />
                    <button className="primary" disabled={busy} onClick={() => void fromFile()} title={tr('A PNG (made into DDS BC1 like the game\'s pictures) or a DDS — saved in your mod beside the game\'s')}>
                        {tr('From an image file…')}
                    </button>
                    <button onClick={onClose}>{tr('Cancel')}</button>
                </div>
                {problem && <div className="ne-problem">{problem}</div>}
                <div className="sc-grid">
                    {!all && !problem && <div className="ne-note">…</div>}
                    {shown.map((f) => (
                        <button key={f.name} className={'sc-tile' + (f.name === now ? ' current' : '')} title={f.name} onClick={() => void write(f.name)}>
                            <GameImg path={f.name} size={240} />
                            <span>
                                {f.file.replace(/\.\w+$/, '')}
                                {f.mod && <em>{tr('· mod')}</em>}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

type ChooserProps = Omit<Parameters<typeof PictureChooser>[0], 'onClose'>;

let opener: ((p: ChooserProps) => void) | null = null;

/** Opens the picture chooser (✎ on a picture line, its "🖼 change…"): PictureLayer, mounted once in App.tsx, shows it. */
export function openPictureChooser(p: ChooserProps): void
{
    opener?.(p);
}

export function PictureLayer(): React.JSX.Element | null
{
    const [shown, setShown] = useState<ChooserProps | null>(null);

    useEffect(() =>
    {
        opener = setShown;
        return () =>
        {
            opener = null;
        };
    }, []);

    return shown ? <PictureChooser {...shown} onClose={() => setShown(null)} /> : null;
}
