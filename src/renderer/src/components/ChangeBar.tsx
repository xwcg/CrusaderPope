import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { hideChangeBar, useChangeBar, type Change } from '../changes';
import { redoEdit, undoEdit } from '../scriptEdits';
import '../styles/edit.css';

import { tr } from '../../../shared/i18n';
const ICON: Record<Change['kind'], string> = { ok: '✓', info: '↶', error: '⚠' };

// (today: the time; an earlier day (a change kept from before a restart): the date too)
const time = (ms: number): string =>
{
    const d = new Date(ms);
    const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t}`;
};

/**
 * The change bar (changes.ts): one line fixed at the bottom of the window with the last change (what, where, Undo, Open),
 * replaced by the next one; "N changes" lists the session's changes (click: open the file there).
 */
export function ChangeBar(): React.JSX.Element | null
{
    const { current: c, history, hidden } = useChangeBar();
    const [list, setList] = useState(false);
    // (the mod's kept changes (also from before a restart) and the undone ones that can come back: asked when the list opens)
    const [kept, setKept] = useState<Awaited<ReturnType<typeof api.listChanges>> | null>(null);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() =>
    {
        if (list)
            void api.listChanges().then(setKept, () => setKept(null));
    }, [list, c?.id]);

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
                    <button className="cb-where" title={tr('Open in VS Code')} onClick={() => open(c)}>
                        {c.where}
                    </button>
                )}
                {c.mod && <span className="cb-mod">{c.mod}</span>}
                {c.details && c.details.length > 0 && <span className="cb-details">{c.details.join(' · ')}</span>}
            </span>
            <span className="cb-actions">
                {c.undo !== undefined && (
                    <button title={tr('Undo this change (Ctrl+Z in the view: the last change)')} onClick={() => void undoEdit(c.undo)}>
                        {tr('Undo')}</button>
                )}
                {c.file && <button onClick={() => open(c)}>{tr('Open in VS Code')}</button>}
                {c.actions?.map((a) => (
                    <button key={a.label} onClick={a.run}>
                        {a.label}
                    </button>
                ))}
                <button className={'cb-count' + (list ? ' on' : '')} title={tr('The mod’s changes the app keeps (also from before a restart): undo or redo any of them')} onClick={() => setList(!list)}>
                    {tr('Changes ▾')}
                </button>
                <button className="ghost cb-close" title={tr('Hide until the next change')} onClick={hideChangeBar}>
                    ✕
                </button>
            </span>
            {list && (
                <div className="cb-list">
                    {kept?.redos.map((x) => (
                        <div key={'r' + x.id} className="cb-item undone">
                            <span className="cb-time">{time(x.at)}</span>
                            <span className="cb-item-text">{tr('{label} (undone)', { label: x.label })}</span>
                            <button className="ghost small" onClick={() => void redoEdit(x.id).then(() => setList(false))}>{tr('Redo')}</button>
                        </div>
                    ))}
                    {(kept?.steps ?? []).map((x) =>
                    {
                        // (this session's notice of the step: where it wrote, to open)
                        const seen = history.find((h) => h.undo === x.id);
                        return (
                            <div key={x.id} className="cb-item ok" title={[x.label, seen?.where, ...(seen?.details ?? [])].filter(Boolean).join('\n')}>
                                <span className="cb-time">{time(x.at)}</span>
                                <button className="ghost cb-item-text" disabled={!seen?.file} onClick={() => seen && open(seen)}>{x.label}</button>
                                {seen?.where && <span className="cb-item-where">{seen.where.slice(seen.where.lastIndexOf('/') + 1)}</span>}
                                <button className="ghost small" onClick={() => void undoEdit(x.id).then(() => setList(false))}>{tr('Undo')}</button>
                            </div>
                        );
                    })}
                    {kept && !kept.steps.length && !kept.redos.length && <div className="cb-item">{tr('No kept changes of the active mod.')}</div>}
                </div>
            )}
        </div>
    );
}
