/**
 * "Merge into one mod…" of a mod list (docs/mods.md, "Merging mods"): the list's enabled mods in its load order, what
 * could resolve differently once they are one mod, a name and folder; then the merged mod, in a new custom list.
 */
import { useEffect, useState } from 'react';
import type { MergePlan, MergeResult, MigrationProgress, ModsState } from '../../../shared/api';
import { tr, trn } from '../../../shared/i18n';
import { folderFromName, modFolderProblem } from '../../../shared/modRules';
import { api } from '../api';
import { errorText, Modal } from './ModDialogs';
import { TaskProgress } from './TaskProgress';

export function MergeDialog(props: { state: ModsState; listRef: string; onDone: (next: ModsState) => void; onClose: () => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<MergePlan | null>(null);
    const [name, setName] = useState('');
    const [folder, setFolder] = useState('');
    const [folderEdited, setFolderEdited] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<MigrationProgress | null>(null);
    const [cancelling, setCancelling] = useState(false);
    const [result, setResult] = useState<MergeResult | null>(null);

    useEffect(() =>
    {
        void api.mergePlan(props.listRef).then((p) =>
        {
            setPlan(p);
            setName((n) => n || tr('{list} (merged)', { list: p.list }));
        }, (e) => setError(errorText(e)));
    }, [props.listRef]);
    useEffect(() => api.onModsProgress(setProgress), []);

    const folderValue = folderEdited ? folder : folderFromName(name);
    const taken = props.state.mods.some((m) => m.id.toLowerCase() === `mod/${folderValue}.mod`.toLowerCase());
    const problem = (name.trim() ? undefined : tr('Enter a name.')) ?? modFolderProblem(folderValue) ?? (taken ? tr('mod/{folder}.mod exists already.', { folder: folderValue }) : undefined);

    const merge = async (): Promise<void> =>
    {
        if (problem || busy)
            return;

        setBusy(true);
        setError(null);
        setCancelling(false);
        setProgress(null);

        try
        {
            setResult(await api.mergeMods({ ref: props.listRef, name: name.trim(), folder: folderValue }));
            props.onDone(await api.modsState());
        }
        catch (e)
        {
            setError(errorText(e));
        }
        finally
        {
            setBusy(false);
            setProgress(null);
        }
    };

    return (
        <Modal title={tr('Merge into one mod')} wide onClose={() => !busy && props.onClose()}>
            <p className="hint">{tr('The enabled mods of the list, in its load order, copied into one new mod — as the game layers them: a later mod’s file replaces an earlier one’s of the same path, its replace_path folders hide the earlier ones’. The mods themselves stay as they are.')}</p>
            {!plan && !error && <div className="dim">{tr('Reading the mods…')}</div>}
            {plan && (
                <>
                    <ol className="merge-mods">
                        {plan.mods.map((m) => (
                            <li key={m.id}>
                                {m.name}
                                <span className="dim">{m.version ? ` v${m.version}` : ''}{m.supportedVersion ? ` · ${tr('game {version}', { version: m.supportedVersion })}` : ''}</span>
                            </li>
                        ))}
                    </ol>
                    {plan.replacePaths.length > 0 && <div className="hint" style={{ marginBottom: 12 }}>{tr('replace_path in the merged mod: {list}', { list: plan.replacePaths.join(', ') })}</div>}
                    <div className="field">
                        <label>{tr('Name')}</label>
                        <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} disabled={busy || !!result} />
                    </div>
                    <div className="field">
                        <label>{tr('Folder')}</label>
                        <div className="row folder-row">
                            <span className="affix">{props.state.userDir.replace(/[\\/]+$/, '')}\mod\</span>
                            <input
                                value={folderValue}
                                disabled={busy || !!result}
                                onChange={(e) =>
                                {
                                    setFolder(e.target.value);
                                    setFolderEdited(true);
                                }}
                                spellCheck={false}
                            />
                        </div>
                        {problem && name && <span className="hint warn-text">{problem}</span>}
                    </div>
                </>
            )}
            {busy && <TaskProgress progress={progress} />}
            {result && (
                <div className="migrate-result">
                    <div>{tr('Merged into {name} ({folder}); the list “{list}” holds it — load it in the explorer when you want it.', { name: result.mod.name, folder: result.mod.folder, list: result.list })}</div>
                    <div>{trn('{n} file', '{n} files', result.files)} · {trn('{n} left out (replaced by a later mod)', '{n} left out (replaced by a later mod)', result.replaced)}</div>
                </div>
            )}
            {error && <div className="save-error">{error}</div>}
            <div className="actions">
                <span style={{ flex: 1 }} />
                {busy ?
                    (
                        <button
                            disabled={cancelling}
                            onClick={() =>
                            {
                                setCancelling(true);
                                void api.cancelModsTask();
                            }}>
                            {cancelling ? tr('Stopping…') : tr('Cancel')}</button>
                    ) :
                    <button onClick={props.onClose}>{result ? tr('Close') : tr('Cancel')}</button>}
                {!result && (
                    <button className="primary" disabled={busy || !plan || !!problem} onClick={() => void merge()}>
                        {busy ? tr('Merging…') : tr('Merge')}</button>
                )}
            </div>
        </Modal>
    );
}
