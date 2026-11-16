/**
 * Edits of the active mod's script from the renderer (docs/mods.md, "Editing in place"): each runs in the main
 * process (checked, written, undoable) and is reported in the change bar (changes.ts) with Undo; the bar outlasts
 * the view, which reloads when the index has taken the file in. Every change the app makes to a mod is one undo step
 * (main: mods/undo.ts, kept across restarts): the bar's Undo undoes that one, Ctrl+Z the mod's last.
 */
import type { EntryCreate, LineSource, ScriptEditRequest, ScriptEditResult } from '../../shared/api';
import { rewrittenKept, type NotKept } from '../../shared/scriptFormat';
import { api } from './api';
import { reportChange } from './changes';
import { errorText } from './errors';

import { tr } from '../../shared/i18n';
/**
 * The new entries a picked condition made (PickResult.creates), for the request that writes the statement (one undo
 * step takes the entries and the statement back) and as a note for the change bar's text. A text key made with the
 * statement (`loc`: a new text version's empty key, textVariants.ts) is written but not named in the note.
 */
export const createsOf = (creates?: EntryCreate[]): { creates?: EntryCreate[]; note: string; } =>
{
    const named = creates?.filter((c) => c.what !== 'loc') ?? [];
    return creates?.length ? { creates, note: named.length ? tr(' (new: {creates})', { creates: named.map((c) => c.key).join(', ') }) : '' } : { note: '' };
};

/** Runs an edit and reports it (the change bar, with Undo); throws with the reason it was refused. */
export async function runScriptEdit(req: ScriptEditRequest, what: string): Promise<ScriptEditResult>
{
    const r = await api.editScript({ ...req, label: req.label ?? what });

    // (a loaded save's entry: the save's own undo, docs/saves.md)
    if (r.save)
    {
        reportChange({ kind: 'ok', text: what, mod: r.mod.name, details: r.notes, actions: [{ label: tr('Undo'), run: () => void undoSaveEdit() }] });
        return r;
    }

    reportChange({ kind: 'ok', text: what, mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
    return r;
}

/** Undoes the loaded save's last change (made through the usual editors), reported in the change bar. */
export async function undoSaveEdit(): Promise<void>
{
    try
    {
        const r = await api.undoSaveEdit();
        reportChange(r ? { kind: 'info', text: tr('Undone in the save: {label}', { label: r.label }), details: [tr('{n} changes of the save not written yet', { n: r.pending })] } : { kind: 'info', text: tr('Nothing to undo in the save') });
    }
    catch (e)
    {
        reportChange({ kind: 'error', text: tr('Not undone'), details: [errorText(e)] });
    }
}

/** Undoes a change of the mod (`step`, else the active mod's last one), reported in the change bar. */
export async function undoEdit(step?: number): Promise<void>
{
    try
    {
        const r = await api.undoChange(step);

        if (!r)
        {
            reportChange({ kind: 'info', text: tr('Nothing to undo'), details: [tr('What the app writes into the mod can be undone — also after a restart.')] });
            return;
        }

        // (a file changed since: nothing written; the change stays until forgotten, the next undo reaches it again)
        if (r.refused)
        {
            const id = r.id;
            reportChange({
                kind: 'error',
                text: tr('Not undone: {label}', { label: r.label }),
                mod: r.mod?.name,
                details: [r.refused],
                actions: [{
                    label: tr('Forget this change'),
                    run: () => void api.forgetChange(id).then(() => reportChange({ kind: 'info', text: tr('Forgotten: {label}', { label: r.label }), mod: r.mod?.name, details: [tr('It stays as it is in the files; the next undo takes the change before it.')] }))
                }]
            });
            return;
        }

        reportChange({
            kind: 'info',
            text: tr('Undone: {label}', { label: r.label }),
            mod: r.mod?.name,
            where: r.rel && (r.line ? `${r.rel}:${r.line}` : r.rel),
            file: r.file,
            line: r.line,
            // (Undo again: the one before; Redo: this one back)
            undo: r.next?.id,
            ...(r.redo !== undefined ? { actions: [{ label: tr('Redo'), run: () => void redoEdit(r.redo) }] } : {}),
            // (a picked statement's new entries go with it: the files they made removed again, the others taken back)
            details: [
                ...(r.removed.length ? [tr('Removed again: {removed}', { removed: r.removed.join(', ') })] : []),
                ...(r.also.length ? [tr('Also taken back: {also}', { also: r.also.join(', ') })] : []),
                ...(r.next ? [tr('Next to undo: {label}{more}', { label: r.next.label, more: r.left > 1 ? tr(' ({left} changes in all)', { left: r.left }) : '' })] : [])
            ]
        });
    }
    catch (e)
    {
        reportChange({ kind: 'error', text: tr('Not undone'), details: [errorText(e)] });
    }
}

/** Redoes an undone change (`step`, else the active mod's last undone one), reported in the change bar. */
export async function redoEdit(step?: number): Promise<void>
{
    try
    {
        const r = await api.redoChange(step);

        if (!r)
        {
            reportChange({ kind: 'info', text: tr('Nothing to redo'), details: [tr('An undone change can be redone until the next change is made.')] });
            return;
        }

        if (r.refused)
        {
            reportChange({ kind: 'error', text: tr('Not redone: {label}', { label: r.label }), mod: r.mod?.name, details: [r.refused] });
            return;
        }

        reportChange({ kind: 'ok', text: tr('Redone: {label}', { label: r.label }), mod: r.mod?.name, where: r.rel && (r.line ? `${r.rel}:${r.line}` : r.rel), file: r.file, line: r.line, undo: r.id, details: r.left ? [tr('{left} more to redo', { left: r.left })] : undefined });
    }
    catch (e)
    {
        reportChange({ kind: 'error', text: tr('Not redone'), details: [errorText(e)] });
    }
}

/** Reports an edit that was refused (the change bar). */
export const reportEditError = (title: string) => (e: unknown): void => reportChange({ kind: 'error', text: title, details: [errorText(e)] });

/**
 * Why a change was not written where keepWritten() could not keep the written comments (docs/mods.md, "Comments next
 * to a statement"). `editor`: the script editor opens at the text as written (the picker's Change path).
 */
export function notKeptText(why: NotKept | undefined, editor: boolean): string
{
    if (editor)
        return why === 'inside' ? tr('Not changed: a comment inside what the change replaces would be lost — change it here as script') : tr('Not changed: the change could not be fitted around the comments as written — change it here as script');

    return why === 'inside' ? tr('A comment inside what the change replaces would be lost: nothing was written. Change it as script.') : tr('The change could not be fitted around the comments as written: nothing was written. Change it as script.');
}

/**
 * The text of a statement the app rewrote from its parsed form (an event's text versions, scenes, portraits:
 * printScript), with the written statement's comments kept (rewrittenKept; a comment next to a part the rewrite
 * dropped goes with it, main's change-bar note names it). `at`'s text is read first; throws, nothing written, where a
 * comment would be lost or the file changed.
 */
export async function rewrittenText(at: LineSource, make: (text: string) => string): Promise<string>
{
    const cur = await api.scriptText(at);

    if (cur.problem)
        throw new Error(cur.problem);

    const kept = rewrittenKept(cur.text, make(cur.text), cur.indent);

    if (kept.text === null)
        throw new Error(notKeptText(kept.why, false));

    return kept.text;
}
