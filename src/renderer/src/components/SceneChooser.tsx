import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { EventBackgroundInfo, EventStory, ImageSource, LineSource, PickedImage } from '../../../shared/api';
import { parseSnippet, printScript, type SNode } from '../../../shared/scriptCatalog';
import { pickStatement } from '../picker/pickStatement';
import { EditCtx } from './editCtx';
import { RichText } from './rich';
import { ImageCropDialog } from './ImageCrop';
import { api } from '../api';
import { reportChange } from '../changes';
import { GameImg } from '../img';
import { reportEditError, runScriptEdit } from '../scriptEdits';
import { errorText } from './ModDialogs';
import '../styles/edit.css';

/** The script that shows background `ref` (`condition`: only when it holds). */
const statement = (ref: string, condition?: string): string => printScript([{ k: 'override_background', op: '=', kids: [...(condition ? [{ k: 'trigger', op: '=', kids: parseSnippet(condition) }] : []), { k: 'reference', op: '=', v: ref }] }]);

/** A scene statement with another background, its condition kept. */
function withReference(text: string, ref: string): string
{
    const n = parseSnippet(text)[0];

    if (!n?.kids)
        return statement(ref);

    const kids: SNode[] = n.kids.some((c) => c.k === 'reference') ? n.kids.map((c) => (c.k === 'reference' ? { ...c, v: ref } : c)) : [...n.kids, { k: 'reference', op: '=', v: ref }];
    return printScript([{ ...n, kids }]);
}

/**
 * Sets one of the event's scenes (docs/mods.md, "Event scenes"): `target` (default its first `override_background`)
 * shows `ref` instead, its condition kept; without one it is written after the event's `theme` (before its `title`,
 * else at the end); null removes the target — the next scene, or the theme's, shows.
 */
export async function setEventBackground(story: EventStory, ref: string | null, target = story.backgroundSrc): Promise<void>
{
    try
    {
        if (ref === null)
        {
            if (target)
                await runScriptEdit({ op: 'remove', at: target }, story.scenes.length > 1 ? 'Removed a scene' : `Scene: the theme’s own${story.themeKey ? ` (${story.themeKey})` : ''}`);

            return;
        }

        const what = `Scene: ${ref}`;

        if (target)
        {
            const cur = await api.scriptText(target);

            if (cur.problem)
                throw new Error(cur.problem);

            await runScriptEdit({ op: 'replace', at: target, text: withReference(cur.text, ref) }, what);
        }
        else
            await insertScene(story, statement(ref), what);
    }
    catch (e)
    {
        reportEditError('Scene not changed')(e);
    }
}

/** Writes a new scene statement: after the event's `theme`, before its `title`, else at the end of the event. */
async function insertScene(story: EventStory, text: string, what: string): Promise<void>
{
    if (story.themeSrc)
        await runScriptEdit({ op: 'insert', at: story.themeSrc, text }, what);
    else if (story.titleSrc)
        await runScriptEdit({ op: 'insert', at: story.titleSrc, where: 'before', text }, what);
    else if (story.src)
        await runScriptEdit({ op: 'insert', at: story.src, where: 'inside', text }, what);
}

/**
 * Adds a scene shown when `condition` holds: before the event's first scene without a condition (which would catch
 * every case), else after its last scene, else where a first scene goes.
 */
async function addScene(story: EventStory, ref: string, condition: string, summary?: string): Promise<void>
{
    const text = statement(ref, condition);
    const what = `Scene ${ref}${summary ? ` when ${summary.charAt(0).toLowerCase()}${summary.slice(1)}` : ''}`;

    try
    {
        const plain = story.scenes.find((x) => !x.when && x.src);
        const last = story.scenes[story.scenes.length - 1]?.src;

        if (plain)
            await runScriptEdit({ op: 'insert', at: plain.src!, where: 'before', text }, what);
        else if (last)
            await runScriptEdit({ op: 'insert', at: last, text }, what);
        else
            await insertScene(story, text, what);
    }
    catch (e)
    {
        reportEditError('No scene added')(e);
    }
}

/** "＋ scene when…": the condition from the picker, then the scene from the chooser. */
export function AddSceneButton({ story }: { story: EventStory; }): React.JSX.Element
{
    const [cond, setCond] = useState<{ text: string; summary?: string; } | null>(null);
    return (
        <>
            <button
                className="ghost small"
                title="Another scene, shown when a condition holds (override_background with a trigger: the first whose condition holds shows)"
                onClick={(e) =>
                {
                    const r = e.currentTarget.getBoundingClientRect();
                    void pickStatement({ kind: 'trigger', scope: 'character', title: 'a scene: shown when…', at: { x: r.left, y: r.bottom + 4 } }).then((c) =>
                    {
                        if (c?.text.trim())
                            setCond({ text: c.text, summary: c.summary });
                    });
                }}
            >
                ＋ scene when…
            </button>
            {cond && <SceneChooser story={story} add={cond} onClose={() => setCond(null)} />}
        </>
    );
}

/**
 * The event's scenes when it has several or conditional ones (`EventStory.scenes`): picture, "If …:" / "Always", the
 * background — written in the active mod with "change…", ↑ ↓ (their order: the first whose condition holds shows) and
 * ✕; "Otherwise: the theme's" when every one has a condition.
 */
export function SceneList({ story, editable }: { story: EventStory; editable: boolean; }): React.JSX.Element | null
{
    const ed = useContext(EditCtx);
    const [changing, setChanging] = useState<LineSource | null>(null);
    const scenes = story.scenes;

    if (scenes.length < 2 && !scenes.some((x) => x.when))
        return null;

    const swap = (a?: LineSource, b?: LineSource): void =>
    {
        if (a && b)
            void runScriptEdit({ op: 'swap', at: a, with: b }, 'Moved a scene').catch(reportEditError('Not moved'));
    };
    return (
        <div className="ev2-scenes">
            {scenes.map((x, i) => (
                <div key={i} className="ev2-scene-row">
                    <GameImg path={x.image} size={120} />
                    <div className="ev2-scene-what">
                        <div className="ev2-when">
                            <RichText rich={x.when ?? [i ? 'Otherwise:' : 'Always:']} />
                            {editable && ed?.sectionAdd(x.triggerSrc, 'Scene: shown when', 'condition')}
                        </div>
                        <span className="ev2-scene-ref">{x.ref ?? '(no reference)'}</span>
                    </div>
                    {editable && x.src && (
                        <span className="ev2-tools">
                            <button className="ghost small" title="Show another background here" onClick={() => setChanging(x.src!)}>
                                change…
                            </button>
                            {i > 0 && (
                                <button className="ghost small" title="Up: checked before the scene above" onClick={() => swap(x.src, scenes[i - 1].src)}>
                                    ↑
                                </button>
                            )}
                            {i < scenes.length - 1 && (
                                <button className="ghost small" title="Down: checked after the scene below" onClick={() => swap(x.src, scenes[i + 1].src)}>
                                    ↓
                                </button>
                            )}
                            <button className="ghost small" title="Remove this scene" onClick={() => void setEventBackground(story, null, x.src)}>
                                ✕
                            </button>
                        </span>
                    )}
                </div>
            ))}
            {scenes.every((x) => x.when) && (
                <div className="ev2-when ev2-scene-else">
                    Otherwise: the theme’s scene{story.themeKey ? ` (${story.themeKey})` : ''}
                </div>
            )}
            {changing && <SceneChooser story={story} target={changing} onClose={() => setChanging(null)} />}
        </div>
    );
}

/** The event card's "Change scene…" on its picture (or in place of it): opens the chooser. */
export function SceneButton({ story }: { story: EventStory; }): React.JSX.Element
{
    const [open, setOpen] = useState(false);
    return (
        <>
            <button className="scene-change" title="Choose the picture behind the event (its background), or use an image of your own" onClick={() => setOpen(true)}>
                🖼 Change scene…
            </button>
            {open && <SceneChooser story={story} onClose={() => setOpen(false)} />}
        </>
    );
}

/**
 * The scene chooser: every event background (the mods' first, then the most used) with a filter; "From an image
 * file…" makes a new one from a PNG / DDS (main asset:eventScene) and shows it; "Theme's own" removes the event's.
 */
function SceneChooser({ story, onClose, target, add }: { story: EventStory; onClose: () => void; target?: LineSource; add?: { text: string; summary?: string; }; }): React.JSX.Element
{
    const [all, setAll] = useState<EventBackgroundInfo[] | null>(null);
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() =>
    {
        let alive = true;
        void api.eventBackgrounds().then(
            (l) => alive && setAll(l),
            (e) => alive && setProblem(errorText(e))
        );
        return () =>
        {
            alive = false;
        };
    }, []);

    const shown = useMemo(() =>
    {
        const words = q.toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
        return (all ?? [])
            .filter((b) => b.image && words.every((w) => b.name.toLowerCase().includes(w) || b.environment?.toLowerCase().includes(w)))
            .sort((a, b) => Number(!!b.mod) - Number(!!a.mod) || b.refs - a.refs || a.name.localeCompare(b.name));
    }, [all, q]);

    const choose = async (ref: string | null): Promise<void> =>
    {
        if (busy)
            return;

        setBusy(true);
        onClose();

        if (add)
        {
            if (ref)
                await addScene(story, ref, add.text, add.summary);
        }
        else
            await setEventBackground(story, ref, target);
    };

    // (the picked image, in the crop & rotate dialog)
    const [cropping, setCropping] = useState<PickedImage | null>(null);

    const fromFile = async (): Promise<void> =>
    {
        if (busy)
            return;

        setProblem(null);

        try
        {
            const pic = await api.pickImage(`A scene image for ${story.key.name} (the game's are 1592×848)`);

            if (pic)
                setCropping(pic);
        }
        catch (e)
        {
            setProblem(errorText(e));
        }
    };

    const importScene = async (source: ImageSource): Promise<void> =>
    {
        setCropping(null);

        if (busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const r = await api.importEventScene(story.key.type, story.key.name, source);

            if (!r)
                return;

            reportChange({ kind: 'ok', text: `New scene ${r.reference}`, details: r.notes, file: r.files[0], undo: r.step });
            onClose();

            if (add)
                await addScene(story, r.reference, add.text, add.summary);
            else
                await setEventBackground(story, r.reference, target);
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
                out={{ w: 1592, h: 848 }}
                title={`Scene of ${story.key.name}: crop & rotate`}
                note="Event scenes are 1592×848 — the frame keeps that shape. Saved in the mod as DDS (BC1) and registered as the event's background."
                onDone={(png) => void importScene({ png, name: cropping.name })}
                onAsIs={() => void importScene({ file: cropping.file })}
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
                        void choose(shown[0].name);
                }}
            >
                <div className="sc-head">
                    <h3>
                        Scene of {story.key.name}
                        {add && <em>— shown when {add.summary ?? 'the condition holds'}</em>}
                    </h3>
                    <input ref={input} autoFocus value={q} placeholder="Filter: throne, feast, battle…" onChange={(e) => setQ(e.target.value)} />
                    <button className="primary" disabled={busy} onClick={() => void fromFile()} title="A PNG (made into DDS BC1 like the game's scenes, 1592×848) or a DDS — saved in the mod as a new background">
                        From an image file…
                    </button>
                    {!add && (target ?? story.backgroundSrc) && (
                        <button disabled={busy} onClick={() => void choose(null)} title={story.scenes.length > 1 ? 'Remove this scene: the next one, or the theme’s, shows' : 'Remove the event’s own background: its theme’s scene shows'}>
                            {story.scenes.length > 1 ? 'Remove this scene' : `Theme’s own${story.themeKey ? ` (${story.themeKey})` : ''}`}
                        </button>
                    )}
                    <button onClick={onClose}>Cancel</button>
                </div>
                {problem && <div className="ne-problem">{problem}</div>}
                <div className="sc-grid">
                    {!all && !problem && <div className="ne-note">…</div>}
                    {shown.map((b) => (
                        <button key={b.name} className={'sc-tile' + (b.name === story.background ? ' current' : '')} title={`${b.name}${b.environment ? ` — lighting: ${b.environment}` : ''} · used ${b.refs}×`} onClick={() => void choose(b.name)}>
                            <GameImg path={b.image} size={240} />
                            <span>
                                {b.name}
                                {b.mod && <em>· {b.mod.state === 'added' ? 'mod' : b.mod.state === 'same' ? 'copied' : 'changed'}</em>}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
