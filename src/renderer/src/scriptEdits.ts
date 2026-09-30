/**
 * Edits of the active mod's script from the renderer (docs/mods.md, "Editing in place"): each runs in the main
 * process (checked, written, undoable) and is reported in the change bar (changes.ts) with Undo — the bar outlasts
 * the view, which reloads when the index has taken the file in. Every change the app makes to a mod is one undo step
 * (main: mods/undo.ts, kept across restarts): the bar's Undo undoes that one, Ctrl+Z the mod's last.
 */
import type { ScriptEditRequest, ScriptEditResult } from '../../shared/api';
import { api } from './api';
import { reportChange } from './changes';
import { errorText } from './components/ModDialogs';

/** Runs an edit and reports it (the change bar, with Undo); throws with the reason it was refused. */
export async function runScriptEdit(req: ScriptEditRequest, what: string): Promise<ScriptEditResult>
{
    const r = await api.editScript({ ...req, label: req.label ?? what });
    reportChange({ kind: 'ok', text: what, mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
    return r;
}

/** Undoes a change of the mod (`step`, else the active mod's last one), reported in the change bar. */
export async function undoEdit(step?: number): Promise<void>
{
    try
    {
        const r = await api.undoChange(step);

        if (!r)
        {
            reportChange({ kind: 'info', text: 'Nothing to undo', details: ['What the app writes into the mod can be undone — also after a restart.'] });
            return;
        }

        // (a file changed since: nothing written — the change stays until forgotten, the next undo reaches it again)
        if (r.refused)
        {
            const id = r.id;
            reportChange({
                kind: 'error',
                text: `Not undone: ${r.label}`,
                mod: r.mod?.name,
                details: [r.refused],
                actions: [{
                    label: 'Forget this change',
                    run: () => void api.forgetChange(id).then(() => reportChange({ kind: 'info', text: `Forgotten: ${r.label}`, mod: r.mod?.name, details: ['It stays as it is in the files; the next undo takes the change before it.'] }))
                }]
            });
            return;
        }

        reportChange({
            kind: 'info',
            text: `Undone: ${r.label}`,
            mod: r.mod?.name,
            where: r.rel && (r.line ? `${r.rel}:${r.line}` : r.rel),
            file: r.file,
            line: r.line,
            // (Undo again: the one before)
            undo: r.next?.id,
            // (a picked statement's new entries go with it: the files they made removed again, the others taken back)
            details: [
                ...(r.removed.length ? [`Removed again: ${r.removed.join(', ')}`] : []),
                ...(r.also.length ? [`Also taken back: ${r.also.join(', ')}`] : []),
                ...(r.next ? [`Next to undo: ${r.next.label}${r.left > 1 ? ` (${r.left} changes in all)` : ''}`] : [])
            ]
        });
    }
    catch (e)
    {
        reportChange({ kind: 'error', text: 'Not undone', details: [errorText(e)] });
    }
}

/** Reports an edit that was refused (the change bar). */
export const reportEditError = (title: string) => (e: unknown): void => reportChange({ kind: 'error', text: title, details: [errorText(e)] });
