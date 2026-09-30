import { useEffect, useRef, useState } from 'react';
import type { EntityListItem, TypeSummary } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { dismissNotice, pushNotice } from '../notices';
import { DuplicateEntryDialog, DuplicateEventDialog, singular } from './NewEntry';
import { errorText } from './ModDialogs';
import '../styles/edit.css';

/** Copies a text and says so briefly. */
function copy(text: string, what: string): void
{
    void navigator.clipboard.writeText(text).then(
        () =>
        {
            const id = pushNotice({ kind: 'info', text: `Copied ${what}: ${text}` });
            setTimeout(() => dismissNotice(id), 2500);
        },
        (e) => pushNotice({ kind: 'error', text: 'Not copied: ' + errorText(e) })
    );
}

/**
 * The entry list's context menu (right click on an entry — docs/app-architecture.md, "Explorer"): Open; Duplicate…
 * (into the active mod: events under a new id, others under a new key — NewEntry.tsx); Copy ID, the script reference
 * (`trait:brave`, when the type has a prefix), the name in game, the file location; Open in VS Code, Reveal the file
 * (the winning definition, looked up when chosen).
 */
export function EntryContextMenu(props: { type: TypeSummary; item: EntityListItem; x: number; y: number; onClose: () => void; navigate: Navigate; }): React.JSX.Element
{
    const { type, item, onClose } = props;
    const box = useRef<HTMLDivElement>(null);
    const [dialog, setDialog] = useState<'duplicate' | null>(null);
    // (kept inside the window)
    const [pos, setPos] = useState({ left: props.x, top: props.y });

    useEffect(() =>
    {
        const r = box.current?.getBoundingClientRect();

        if (r)
            setPos({ left: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)) });
    }, [props.x, props.y]);

    useEffect(() =>
    {
        if (dialog)
            return;

        const onDown = (e: MouseEvent): void =>
        {
            if (!box.current?.contains(e.target as Node))
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
    }, [dialog, onClose]);

    /** The winning definition's file and line (the last one no mod hides). */
    const where = async (): Promise<{ abs: string; rel: string; line: number; } | null> =>
    {
        const d = await api.detail(type.id, item.name);
        const win = d && [...d.defs].reverse().find((x) => !x.origin?.hiddenBy);
        return win ? { abs: win.absPath, rel: win.file, line: win.line } : null;
    };
    const run = (f: () => void | Promise<void>) => (): void =>
    {
        onClose();
        void Promise.resolve(f()).catch((e) => pushNotice({ kind: 'error', text: errorText(e) }));
    };
    const noFile = (): void =>
    {
        pushNotice({ kind: 'info', text: `${item.name} has no definition in a file.` });
    };

    if (dialog === 'duplicate')
        return type.id === 'events' ?
            <DuplicateEventDialog source={item.name} onClose={onClose} onOpen={(t, n) => props.navigate({ type: t, name: n })} /> :
            <DuplicateEntryDialog type={type} source={item.name} onClose={onClose} onOpen={(t, n) => props.navigate({ type: t, name: n })} />;

    const removed = item.mod?.state === 'removed';
    return (
        <div className="ctx-menu" ref={box} style={pos} onContextMenu={(e) => e.preventDefault()}>
            <div className="am-note">{item.name}</div>
            <button className="am-item" onClick={run(() => props.navigate({ type: type.id, name: item.name }))}>
                Open
            </button>
            <button className="am-item" disabled={removed || item.defs === 0} title={`A copy under a new ${type.id === 'events' ? 'id' : 'key'} in the active mod, to change freely`} onClick={() => setDialog('duplicate')}>
                Duplicate {singular(type.label)}…
            </button>
            <div className="am-sep" />
            <button className="am-item" onClick={run(() => copy(item.name, 'the ID'))}>
                Copy ID
            </button>
            {type.refPrefix && (
                <button className="am-item" title="How script names it" onClick={run(() => copy(`${type.refPrefix}:${item.name}`, 'the reference'))}>
                    Copy reference <code>{type.refPrefix}:…</code>
                </button>
            )}
            {item.display && (
                <button className="am-item" onClick={run(() => copy(item.display!, 'the name'))}>
                    Copy name in game
                </button>
            )}
            <button
                className="am-item"
                disabled={item.defs === 0}
                onClick={run(async () =>
                {
                    const w = await where();

                    if (w)
                        copy(`${w.rel}:${w.line}`, 'the location');
                    else
                        noFile();
                })}
            >
                Copy file location
            </button>
            <div className="am-sep" />
            <button
                className="am-item"
                disabled={item.defs === 0}
                onClick={run(async () =>
                {
                    const w = await where();

                    if (w)
                        await api.openFile(w.abs, w.line);
                    else
                        noFile();
                })}
            >
                Open in VS Code
            </button>
            <button
                className="am-item"
                disabled={item.defs === 0}
                onClick={run(async () =>
                {
                    const w = await where();

                    if (w)
                        await api.revealFile(w.abs);
                    else
                        noFile();
                })}
            >
                Reveal file
            </button>
        </div>
    );
}
