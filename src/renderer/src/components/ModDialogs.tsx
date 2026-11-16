import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DeleteModPlan, ModInfo, ModsState, NewModRequest } from '../../../shared/api';
import { descriptorTextProblem, folderFromName, modFolderProblem, supportedVersionFor, versionMatches } from '../../../shared/modRules';
import { api } from '../api';
import { errorText } from '../errors';
import { Select } from './Select';

import { tr, trn } from '../../../shared/i18n';
import { fold, foldHas } from '../../../shared/fold';
// Pieces of the Mods view (ModsView.tsx): mod facts, thumbnails, dialogs.

export const SOURCE_LABEL: Record<ModInfo['source'], string> = { steam: tr('Steam Workshop'), pdx: tr('Paradox Mods'), local: tr('Local') };

/** Tags the launcher and the Workshop offer for CK3 mods. */
// (the launcher's own tag names: written into descriptors as they are, never translated)
const STANDARD_TAGS = [
    tr('Alternative History'),
    tr('Balance'),
    tr('Bookmarks'),
    tr('Character Focuses'),
    tr('Character Interactions'),
    tr('Culture'),
    tr('Decisions'),
    tr('Events'),
    tr('Fixes'),
    tr('Gameplay'),
    tr('Graphics'),
    tr('Historical'),
    tr('Map'),
    tr('Portraits'),
    tr('Religion'),
    tr('Schemes'),
    tr('Sound'),
    tr('Total Conversion'),
    tr('Translation'),
    tr('Utilities'),
    tr('Warfare')
];

// (errorText moved to ../errors.ts; MergeDialog and MigrateDialog still import it from here)
export { errorText };

export function StatusChip({ mod }: { mod: ModInfo; }): React.JSX.Element
{
    if (mod.status === 'missing')
        return <span className="chip bad" title={tr('Neither the mod\'s folder nor its zip exists')}>{tr('Missing')}</span>;

    if (mod.archive && !mod.root)
        return (
            <span className="chip" title={tr('Packed: ') + mod.archive}>
                {tr('Packed')}</span>
        );

    return (
        <span className="chip" title={tr('Unpacked: ') + mod.root}>
            {tr('Unpacked')}</span>
    );
}

/** The game version the mod supports; warns when it does not fit the installed game. */
export function SupportedChip({ mod, game }: { mod: ModInfo; game?: string; }): React.JSX.Element
{
    const sv = mod.supportedVersion;

    if (!sv)
        return <span className="chip" title={tr('The descriptor names no supported game version')}>{tr('game ?')}</span>;

    const fits = versionMatches(sv, game);
    return (
        <span className={'chip' + (fits === false ? ' warn' : '')} title={fits === false ? tr('Made for game version {sv}; the installed game is {game}', { sv, game }) : tr('Supports game version {sv}', { sv })}>
            {fits === false ? '⚠ ' : ''}{tr('game {sv}', { sv })}
        </span>
    );
}

/** Whether the mod warrants a warning in a list: missing files or made for another game version. */
export function modWarning(mod: ModInfo | undefined, game?: string): string | undefined
{
    if (!mod)
        return tr('not found');

    if (mod.status === 'missing')
        return tr('files missing');

    if (versionMatches(mod.supportedVersion, game) === false)
        return tr('other game version');

    return undefined;
}

// thumbnails come through IPC as data URLs (they can live anywhere on disk); one request per image per session
const thumbs = new Map<string, Promise<string | null>>();

export function ModThumb({ mod, size = 'normal' }: { mod?: ModInfo; size?: 'normal' | 'small'; }): React.JSX.Element
{
    const [url, setUrl] = useState<string | null>(null);
    const key = mod?.thumbnail ? mod.id + '\u0000' + mod.thumbnail : '';
    useEffect(() =>
    {
        setUrl(null);

        if (!key || !mod)
            return;

        let p = thumbs.get(key);

        if (!p)
        {
            p = api.modThumbnail(mod.id).catch(() => null);
            thumbs.set(key, p);
        }

        let alive = true;
        void p.then((u) => alive && setUrl(u));
        return () =>
        {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const initials = (mod?.name ?? '?')
        .split(/\s+/)
        .map((w) => w[0])
        .filter((c) => c && /[\p{L}\p{N}]/u.test(c))
        .slice(0, 2)
        .join('')
        .toUpperCase();
    return <div className={'mod-thumb ' + size}>{url ? <img src={url} alt="" draggable={false} /> : <span>{initials || '?'}</span>}</div>;
}

/** Modal frame in the app's dialog style; Escape and a click outside close it. */
export function Modal(props: { title: string; wide?: boolean; onClose: () => void; children: ReactNode; }): React.JSX.Element
{
    const { onClose } = props;
    useEffect(() =>
    {
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={props.title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={'modal mods-modal' + (props.wide ? ' wide' : '')}>
                <h2>{props.title}</h2>
                {props.children}
            </div>
        </div>
    );
}

/**
 * Deleting a mod of one's own (docs/mods.md "Deleting a mod"): what goes and what it's taken out of, then a box to tick
 * before Delete works, as it is destructive (the folder goes to the Recycle Bin).
 */
export function DeleteModDialog(props: { mod: ModInfo; onDelete: () => void; onClose: () => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<DeleteModPlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sure, setSure] = useState(false);

    useEffect(() =>
    {
        void api.deleteModPlan(props.mod.id).then(setPlan, (e) => setError(errorText(e)));
    }, [props.mod.id]);

    return (
        <Modal title={tr('Delete “{name}”?', { name: props.mod.name })} onClose={props.onClose}>
            <div className="mods-confirm">
                {!plan && !error && <p className="dim">{tr('Reading the mod…')}</p>}
                {error && <p className="warn-text">{error}</p>}
                {plan && (
                    <>
                        <p>{tr('These go to the Recycle Bin:')}</p>
                        <ul>
                            <li><code>{plan.folder}</code> {trn('({n} file)', '({n} files)', plan.files)}</li>
                            {plan.descriptor && <li><code>{plan.descriptor}</code></li>}
                        </ul>
                        {(plan.lists.length > 0 || plan.gameList || plan.active) && (
                            <p>
                                {[
                                    plan.lists.length ? tr('It is taken out of: {lists}.', { lists: plan.lists.join(', ') }) : '',
                                    plan.gameList ? tr('The game’s list (dlc_load.json) no longer names it (a backup first).') : '',
                                    plan.active ? tr('It is no longer the active mod.') : ''
                                ].filter(Boolean).join(' ')}
                            </p>
                        )}
                        {plan.playsets.length > 0 && <p className="warn-text">{tr('Launcher playsets naming it keep it as missing — remove it there: {playsets}.', { playsets: plan.playsets.join(', ') })}</p>}
                        <p className="dim">{tr('Its undo steps go too.')}</p>
                        <label className="delete-sure">
                            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />{' '}
                            {tr('I understand that “{name}” and its files are deleted.', { name: plan.name })}
                        </label>
                    </>
                )}
            </div>
            <div className="actions">
                <button onClick={props.onClose}>{tr('Cancel')}</button>
                <button
                    className="danger"
                    disabled={!plan || !sure}
                    onClick={() =>
                    {
                        props.onClose();
                        props.onDelete();
                    }}
                >
                    {tr('Delete')}
                </button>
            </div>
        </Modal>
    );
}

export function ConfirmDialog(props: { title: string; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void; children: ReactNode; }): React.JSX.Element
{
    return (
        <Modal title={props.title} onClose={props.onClose}>
            <div className="mods-confirm">{props.children}</div>
            <div className="actions">
                <button onClick={props.onClose}>{tr('Cancel')}</button>
                <button
                    className={props.danger ? 'danger' : 'primary'}
                    autoFocus
                    onClick={() =>
                    {
                        props.onClose();
                        props.onConfirm();
                    }}
                >
                    {props.confirm}
                </button>
            </div>
        </Modal>
    );
}

export function PromptDialog(props: { title: string; label: string; initial: string; confirm: string; onConfirm: (value: string) => void; onClose: () => void; }): React.JSX.Element
{
    const [value, setValue] = useState(props.initial);
    const ok = value.trim() !== '';
    const submit = (): void =>
    {
        if (!ok)
            return;

        props.onClose();
        props.onConfirm(value.trim());
    };
    return (
        <Modal title={props.title} onClose={props.onClose}>
            <div className="field">
                <label>{props.label}</label>
                <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                    spellCheck={false}
                />
            </div>
            <div className="actions">
                <button onClick={props.onClose}>{tr('Cancel')}</button>
                <button className="primary" disabled={!ok} onClick={submit}>
                    {props.confirm}
                </button>
            </div>
        </Modal>
    );
}

/** Searchable picker over every discovered mod; adding keeps it open. */
export function AddModsDialog(props: { state: ModsState; listName: string; inList: Set<string>; onAdd: (id: string) => void; onClose: () => void; }): React.JSX.Element
{
    const [q, setQ] = useState('');
    const game = props.state.gameVersion;
    const mods = useMemo(() =>
    {
        const f = fold(q.trim());
        return props.state.mods
            .filter((m) => !f || [m.name, m.id, m.version ?? '', SOURCE_LABEL[m.source], ...m.tags].some((s) => foldHas(s, f)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [props.state.mods, q]);
    return (
        <Modal title={tr('Add mods to “{listName}”', { listName: props.listName })} wide onClose={props.onClose}>
            <input className="mods-search" autoFocus placeholder={tr('Search {modsCount} mods by name, tag, source…', { modsCount: props.state.mods.length })} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            <div className="mods-picker">
                {mods.length === 0 && <div className="list-empty">{tr('No mods match.')}</div>}
                {mods.map((m) =>
                {
                    const added = props.inList.has(m.id.toLowerCase());
                    return (
                        <div key={m.id} className={'picker-row' + (added ? ' added' : '')} onClick={() => !added && props.onAdd(m.id)} title={m.id}>
                            <ModThumb mod={m} size="small" />
                            <div className="pr-main">
                                <div className="pr-name">
                                    {m.name}
                                    {m.version && <span className="mr-version">v{m.version}</span>}
                                </div>
                                <div className="mr-chips">
                                    <span className="chip">{SOURCE_LABEL[m.source]}</span>
                                    <StatusChip mod={m} />
                                    <SupportedChip mod={m} game={game} />
                                </div>
                            </div>
                            {added ? <span className="pr-added">{tr('In the list')}</span> : <button onClick={() => props.onAdd(m.id)}>{tr('Add')}</button>}
                        </div>
                    );
                })}
            </div>
            <div className="actions">
                <span className="hint" style={{ flex: 1 }}>
                    {tr('Added mods go to the end of the load order, enabled.')}</span>
                <button className="primary" onClick={props.onClose}>
                    {tr('Done')}</button>
            </div>
        </Modal>
    );
}

/** Where a new mod goes: '' = no list, 'new' = a new list named after it, else a custom list's ref. */
export type NewModTarget = string;

export function NewModDialog(props: {
    state: ModsState;
    /** preselected list ('' / 'new' / custom ref) */
    defaultTarget: NewModTarget;
    onCreate: (req: NewModRequest, target: NewModTarget) => Promise<void>;
    onClose: () => void;
}): React.JSX.Element
{
    const game = props.state.gameVersion;
    const [name, setName] = useState('');
    const [folder, setFolder] = useState('');
    const [folderEdited, setFolderEdited] = useState(false);
    const [version, setVersion] = useState('1.0');
    const [supported, setSupported] = useState(supportedVersionFor(game));
    const [tags, setTags] = useState<string[]>([]);
    const [otherTags, setOtherTags] = useState('');
    const [target, setTarget] = useState<NewModTarget>(props.defaultTarget);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => nameRef.current?.focus(), []);

    const folderValue = folderEdited ? folder : folderFromName(name);
    const taken = props.state.mods.some((m) => m.id.toLowerCase() === `mod/${folderValue}.mod`.toLowerCase());
    const allTags = [...tags, ...otherTags.split(',').map((t) => t.trim())].filter(Boolean);
    const problem = (name.trim() ? undefined : tr('Enter a name.')) ??
        descriptorTextProblem('Name', name) ??
        modFolderProblem(folderValue) ??
        (taken ? tr('mod/{folder}.mod exists already.', { folder: folderValue }) : undefined) ??
        descriptorTextProblem('Version', version) ??
        (supported.trim() && !/^v?[0-9*]+(\.[0-9*]+){0,3}$/i.test(supported.trim()) ? tr('Supported version: numbers or * separated by dots, like 1.19.*') : undefined) ??
        allTags.map((t) => descriptorTextProblem('Tags', t)).find(Boolean);
    const customs = props.state.lists.filter((l) => l.kind === 'custom');
    const fits = versionMatches(supported, game);

    const create = async (): Promise<void> =>
    {
        if (problem || busy)
            return;

        setBusy(true);
        setError(null);

        try
        {
            await props.onCreate({ name: name.trim(), folder: folderValue, version: version.trim(), supportedVersion: supported.trim(), tags: [...new Set(allTags)] }, target);
            props.onClose();
        }
        catch (e)
        {
            setError(errorText(e));
        }
        finally
        {
            setBusy(false);
        }
    };

    return (
        <Modal title={tr('New mod')} onClose={props.onClose}>
            <div className="field">
                <label>{tr('Name')}</label>
                <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('My Mod')} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && void create()} />
            </div>
            <div className="field">
                <label>{tr('Folder')}</label>
                <div className="row folder-row">
                    <span className="affix">{props.state.userDir.replace(/[\\/]+$/, '')}\mod\</span>
                    <input
                        value={folderValue}
                        onChange={(e) =>
                        {
                            setFolder(e.target.value);
                            setFolderEdited(true);
                        }}
                        spellCheck={false}
                    />
                </div>
                <span className="hint">
                    {tr('Creates the folder with its descriptor.mod, and mod\\{folderValue}.mod for the game and the launcher.', { folderValue: folderValue || '…' })}</span>
            </div>
            <div className="field-pair">
                <div className="field">
                    <label>{tr('Version')}</label>
                    <input value={version} onChange={(e) => setVersion(e.target.value)} spellCheck={false} />
                </div>
                <div className="field">
                    <label>{tr('Supported game version')}</label>
                    <input value={supported} onChange={(e) => setSupported(e.target.value)} spellCheck={false} />
                    <span className={'hint' + (fits === false ? ' warn-text' : '')}>
                        {game ? tr('The installed game is {game}{mismatch}.', { game, mismatch: fits === false ? tr(' — this does not match it') : '' }) : tr('Game version unknown.')}
                    </span>
                </div>
            </div>
            <div className="field">
                <label>{tr('Tags')}</label>
                <div className="tag-picks">
                    {STANDARD_TAGS.map((t) => (
                        <button key={t} className={'tag-pick' + (tags.includes(t) ? ' on' : '')} onClick={() => setTags((v) => (v.includes(t) ? v.filter((x) => x !== t) : [...v, t]))}>
                            {t}
                        </button>
                    ))}
                </div>
                <input value={otherTags} onChange={(e) => setOtherTags(e.target.value)} placeholder={tr('Other tags, comma separated')} spellCheck={false} />
            </div>
            <div className="field">
                <label>{tr('Add to a mod list')}</label>
                <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="new">{tr('A new list “{name}” (the game plus this mod)', { name: name.trim() || 'the mod’s name' })}</option>
                    {customs.map((l) => (
                        <option key={l.ref} value={l.ref}>
                            {l.name}
                            {props.state.selected === l.ref ? tr(' (loaded in the explorer)') : ''}
                        </option>
                    ))}
                    <option value="">{tr('Don’t add it to a list')}</option>
                </Select>
                <span className="hint">{tr('The mod becomes the active mod (the one being edited). Writing a list with it to a launcher playset registers it in the launcher too.')}</span>
            </div>
            {(error || (problem && name.trim())) && <div className="mods-error">{error ?? problem}</div>}
            <div className="actions">
                <button onClick={props.onClose}>{tr('Cancel')}</button>
                <button className="primary" disabled={!!problem || busy} onClick={() => void create()}>
                    {busy ? tr('Creating…') : tr('Create mod')}
                </button>
            </div>
        </Modal>
    );
}
