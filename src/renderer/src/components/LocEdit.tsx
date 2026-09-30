import { useEffect, useRef, useState } from 'react';
import type { EntityKey } from '../../../shared/api';
import { api } from '../api';
import { pickStatement } from '../picker/pickStatement';
import { reportChange } from '../changes';
import { reportEditError } from '../scriptEdits';
import '../styles/edit.css';

/**
 * A localization text shown in an entry written in the active mod (an event's title, a description, an option's name, a
 * card's name and description, a line's text — Line.locKey: "✎ text", `label`) with ✎ to change it in place
 * (docs/mods.md, "Editing in place": `api.editLoc` — the mod's own line, else an override in its replace folder). Shows
 * the text as written (with its [data functions] and $values$); Enter saves a one-line text, Ctrl+Enter a description
 * (or any text with line breaks), Esc cancels. An empty text reads "(no text yet)". "⟨⟩ Code…" (Ctrl+Space) inserts one of
 * the game's text codes at the cursor — the statement picker in mode 'loc': a character's name, pronoun, faith … (you
 * or a scope of the entry, `of`), a concept link, an icon, formatting (around the selected text).
 */
export function LocEditable(props: { locKey?: string; editable: boolean; multiline?: boolean; empty?: boolean; of?: EntityKey; label?: string; children: React.ReactNode; }): React.JSX.Element
{
    const { locKey, editable } = props;
    const [open, setOpen] = useState(false);
    const [text, setText] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

    useEffect(() =>
    {
        if (!open || !locKey)
            return;

        let alive = true;
        setText(null);
        void api.locEntry(locKey).then((e) =>
        {
            if (!alive)
                return;

            // (line breaks are written as \n)
            setText((e?.text ?? '').replace(/\\n/g, '\n'));
            setTimeout(() => field.current?.focus(), 0);
        });
        return () =>
        {
            alive = false;
        };
    }, [open, locKey]);

    if (!editable || !locKey)
        return <>{props.children}</>;

    // (a text with line breaks gets the text area also where one line is expected: an input would drop them)
    const multiline = props.multiline || !!text?.includes('\n');
    const save = async (): Promise<void> =>
    {
        if (text === null || busy)
            return;

        setBusy(true);

        try
        {
            const r = await api.editLoc(locKey, text);
            reportChange({ kind: 'ok', text: `Changed the text of ${locKey}`, mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
            setOpen(false);
        }
        catch (e)
        {
            reportEditError('Text not changed')(e);
        }
        finally
        {
            setBusy(false);
        }
    };
    /** A code from the picker at the cursor (a formatting pair around the selection), the cursor after it. */
    const insertCode = async (at?: { x: number; y: number; }): Promise<void> =>
    {
        const el = field.current;

        if (!el || text === null)
            return;

        const start = el.selectionStart ?? text.length;
        const end = el.selectionEnd ?? start;
        const scopes = props.of ? await api.locScopes(props.of.type, props.of.name).catch(() => [] as string[]) : [];
        const r = await pickStatement({ kind: 'loc', scopes, title: locKey, at });

        if (!r)
            return;

        const selected = text.slice(start, end);
        const ins = r.caret !== undefined ? r.text.slice(0, r.caret) + selected + r.text.slice(r.caret) : r.text;
        const next = text.slice(0, start) + ins + text.slice(end);
        setText(next);
        // (after the code — inside a formatting pair when nothing was selected)
        const pos = start + (r.caret !== undefined && !selected ? r.caret : ins.length);
        setTimeout(() =>
        {
            el.focus();
            el.setSelectionRange(pos, pos);
        }, 0);
    };
    const onKey = (e: React.KeyboardEvent): void =>
    {
        e.stopPropagation();

        if (e.key === ' ' && e.ctrlKey)
        {
            e.preventDefault();
            const r = (e.target as HTMLElement).getBoundingClientRect();
            void insertCode({ x: r.left, y: r.bottom + 4 });
            return;
        }

        if (e.key === 'Escape')
            setOpen(false);
        else if (e.key === 'Enter' && (e.ctrlKey || !multiline))
        {
            e.preventDefault();
            void save();
        }
    };
    return (
        <span className="loc-editable">
            {props.empty ? <span className="loc-empty">(no text yet)</span> : props.children}
            {!open && (
                <button className={'ghost loc-edit-btn' + (props.label ? ' labelled' : '')} title={`Change the text (${locKey})`} onClick={(e) => (e.stopPropagation(), setOpen(true))}>
                    ✎{props.label ? ' ' + props.label : ''}
                </button>
            )}
            {open && (
                <span className="loc-editor" onClick={(e) => e.stopPropagation()}>
                    {text === null ?
                        <span className="loc-key">Reading {locKey}…</span> :
                        multiline ?
                        <textarea ref={field} rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} /> :
                        <input ref={field} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />}
                    <span className="loc-actions">
                        <code className="loc-key">{locKey}</code>
                        <button
                            title="Insert a text code at the cursor: a name, pronoun, faith …, a concept link, an icon, formatting (Ctrl+Space)"
                            disabled={text === null}
                            onClick={(e) =>
                            {
                                const r = e.currentTarget.getBoundingClientRect();
                                void insertCode({ x: r.left, y: r.bottom + 4 });
                            }}
                        >
                            ⟨⟩ Code…
                        </button>
                        <button onClick={() => setOpen(false)}>Cancel</button>
                        <button className="primary" disabled={text === null || busy} onClick={() => void save()}>
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                        <small>{multiline ? 'Ctrl+Enter saves' : 'Enter saves'} · Ctrl+Space inserts a code · Esc cancels</small>
                    </span>
                </span>
            )}
        </span>
    );
}
