import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { hideChangeBar, useChangeBar, type Change } from '../changes';
import { undoEdit } from '../scriptEdits';
import '../styles/edit.css';

const ICON: Record<Change['kind'], string> = { ok: '✓', info: '↶', error: '⚠' };

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * The change bar (changes.ts): one line fixed at the bottom of the window with the last change — what, where, Undo, Open —
 * replaced by the next one; "N changes" lists the session's changes (click: open the file there).
 */
export function ChangeBar(): React.JSX.Element | null
{
    const { current: c, history, hidden } = useChangeBar();
    const [list, setList] = useState(false);
    const box = useRef<HTMLDivElement>(null);

    // the list closes on a click elsewhere and on Esc
    useEffect(() =>
    {
        if (!list)
            return;

        const onDown = (e: MouseEvent): void =>
        {
            if (!box.current?.contains(e.target as Node))
                setList(false);
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                setList(false);
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [list]);

    // the app makes room for the bar (app.css: --change-bar-h)
    const shown = !!c && !hidden;
    useEffect(() =>
    {
        document.documentElement.style.setProperty('--change-bar-h', shown ? '34px' : '0px');
    }, [shown]);

    if (!c || hidden)
        return null;

    const open = (x: Change): void =>
    {
        if (x.file)
            void api.openFile(x.file, x.line);
    };
    return (
        <div className={'change-bar ' + c.kind} ref={box}>
            <span className="cb-icon">{ICON[c.kind]}</span>
            <span className="cb-text" title={[c.text, ...(c.details ?? [])].join('\n')}>
                <b>{c.text}</b>
                {c.where && (
                    <button className="cb-where" title="Open in VS Code" onClick={() => open(c)}>
                        {c.where}
                    </button>
                )}
                {c.mod && <span className="cb-mod">{c.mod}</span>}
                {c.details && c.details.length > 0 && <span className="cb-details">{c.details.join(' · ')}</span>}
            </span>
            <span className="cb-actions">
                {c.undo !== undefined && (
                    <button title="Undo this change (Ctrl+Z in the view: the last change)" onClick={() => void undoEdit(c.undo)}>
                        Undo
                    </button>
                )}
                {c.file && <button onClick={() => open(c)}>Open in VS Code</button>}
                {c.actions?.map((a) => (
                    <button key={a.label} onClick={a.run}>
                        {a.label}
                    </button>
                ))}
                {history.length > 0 && (
                    <button className={'cb-count' + (list ? ' on' : '')} title="This session’s changes" onClick={() => setList(!list)}>
                        {history.length} {history.length === 1 ? 'change' : 'changes'} ▾
                    </button>
                )}
                <button className="ghost cb-close" title="Hide until the next change" onClick={hideChangeBar}>
                    ✕
                </button>
            </span>
            {list && (
                <div className="cb-list">
                    {history.map((x) => (
                        <button key={x.id} className={'cb-item ' + x.kind} disabled={!x.file} title={[x.text, x.where, ...(x.details ?? [])].filter(Boolean).join('\n')} onClick={() => open(x)}>
                            <span className="cb-time">{time(x.at)}</span>
                            <span className="cb-item-text">{x.text}</span>
                            {/* (the file's name and line: the folder is in the tooltip) */}
                            {x.where && <span className="cb-item-where">{x.where.slice(x.where.lastIndexOf('/') + 1)}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
