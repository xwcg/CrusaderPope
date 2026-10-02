import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModInfo, ModsState, NewModRequest } from '../../../shared/api';
import { descriptorTextProblem, folderFromName, modFolderProblem, supportedVersionFor, versionMatches } from '../../../shared/modRules';
import { api } from '../api';
import { Select } from './Select';

// Pieces of the Mods view (ModsView.tsx): mod facts, thumbnails, dialogs.

export const SOURCE_LABEL: Record<ModInfo['source'], string> = { steam: 'Steam Workshop', pdx: 'Paradox Mods', local: 'Local' };

/** Tags the launcher and the Workshop offer for CK3 mods. */
const STANDARD_TAGS = [
    'Alternative History',
    'Balance',
    'Bookmarks',
    'Character Focuses',
    'Character Interactions',
    'Culture',
    'Decisions',
    'Events',
    'Fixes',
    'Gameplay',
    'Graphics',
    'Historical',
    'Map',
    'Portraits',
    'Religion',
    'Schemes',
    'Sound',
    'Total Conversion',
    'Translation',
    'Utilities',
    'Warfare'
];

/** An IPC error without Electron's "Error invoking remote method …" wrapper. */
export function errorText(e: unknown): string
{
    const m = e instanceof Error ? e.message : String(e);
    return m.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '');
}

export function StatusChip({ mod }: { mod: ModInfo; }): React.JSX.Element
{
    if (mod.status === 'missing')
        return <span className="chip bad" title="Neither the mod's folder nor its zip exists">Missing</span>;

    if (mod.archive && !mod.root)
        return (
            <span className="chip" title={'Packed: ' + mod.archive}>
                Packed
            </span>
        );

    return (
        <span className="chip" title={'Unpacked: ' + mod.root}>
            Unpacked
        </span>
    );
}

/** The game version the mod supports; warns when it does not fit the installed game. */
export function SupportedChip({ mod, game }: { mod: ModInfo; game?: string; }): React.JSX.Element
{
    const sv = mod.supportedVersion;

    if (!sv)
        return <span className="chip" title="The descriptor names no supported game version">game ?</span>;

    const fits = versionMatches(sv, game);
    return (
        <span className={'chip' + (fits === false ? ' warn' : '')} title={fits === false ? `Made for game version ${sv}; the installed game is ${game}` : `Supports game version ${sv}`}>
            {fits === false ? '⚠ ' : ''}game {sv}
        </span>
    );
}

/** Whether the mod warrants a warning in a list: missing files or made for another game version. */
export function modWarning(mod: ModInfo | undefined, game?: string): string | undefined
{
    if (!mod)
        return 'not found';

    if (mod.status === 'missing')
        return 'files missing';

    if (versionMatches(mod.supportedVersion, game) === false)
        return 'other game version';

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
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={'modal mods-modal' + (props.wide ? ' wide' : '')}>
                <h2>{props.title}</h2>
                {props.children}
            </div>
        </div>
    );
}

export function ConfirmDialog(props: { title: string; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void; children: ReactNode; }): React.JSX.Element
{
    return (
        <Modal title={props.title} onClose={props.onClose}>
            <div className="mods-confirm">{props.children}</div>
            <div className="actions">
                <button onClick={props.onClose}>Cancel</button>
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
                <button onClick={props.onClose}>Cancel</button>
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
        const f = q.trim().toLowerCase();
        return props.state.mods
            .filter((m) => !f || [m.name, m.id, m.version ?? '', SOURCE_LABEL[m.source], ...m.tags].some((s) => s.toLowerCase().includes(f)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [props.state.mods, q]);
    return (
        <Modal title={`Add mods to “${props.listName}”`} wide onClose={props.onClose}>
            <input className="mods-search" autoFocus placeholder={`Search ${props.state.mods.length} mods by name, tag, source…`} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            <div className="mods-picker">
                {mods.length === 0 && <div className="list-empty">No mods match.</div>}
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
                            {added ? <span className="pr-added">In the list</span> : <button onClick={() => props.onAdd(m.id)}>Add</button>}
                        </div>
                    );
                })}
            </div>
            <div className="actions">
                <span className="hint" style={{ flex: 1 }}>
                    Added mods go to the end of the load order, enabled.
                </span>
                <button className="primary" onClick={props.onClose}>
                    Done
                </button>
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
    const problem = (name.trim() ? undefined : 'Enter a name.') ??
        descriptorTextProblem('Name', name) ??
        modFolderProblem(folderValue) ??
        (taken ? `mod/${folderValue}.mod exists already.` : undefined) ??
        descriptorTextProblem('Version', version) ??
        (supported.trim() && !/^v?[0-9*]+(\.[0-9*]+){0,3}$/i.test(supported.trim()) ? 'Supported version: numbers or * separated by dots, like 1.19.*' : undefined) ??
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
        <Modal title="New mod" onClose={props.onClose}>
            <div className="field">
                <label>Name</label>
                <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Mod" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && void create()} />
            </div>
            <div className="field">
                <label>Folder</label>
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
                    Creates the folder with its descriptor.mod, and mod\{folderValue || '…'}.mod for the game and the launcher.
                </span>
            </div>
            <div className="field-pair">
                <div className="field">
                    <label>Version</label>
                    <input value={version} onChange={(e) => setVersion(e.target.value)} spellCheck={false} />
                </div>
                <div className="field">
                    <label>Supported game version</label>
                    <input value={supported} onChange={(e) => setSupported(e.target.value)} spellCheck={false} />
                    <span className={'hint' + (fits === false ? ' warn-text' : '')}>
                        {game ? `The installed game is ${game}${fits === false ? ' — this does not match it' : ''}.` : 'Game version unknown.'}
                    </span>
                </div>
            </div>
            <div className="field">
                <label>Tags</label>
                <div className="tag-picks">
                    {STANDARD_TAGS.map((t) => (
                        <button key={t} className={'tag-pick' + (tags.includes(t) ? ' on' : '')} onClick={() => setTags((v) => (v.includes(t) ? v.filter((x) => x !== t) : [...v, t]))}>
                            {t}
                        </button>
                    ))}
                </div>
                <input value={otherTags} onChange={(e) => setOtherTags(e.target.value)} placeholder="Other tags, comma separated" spellCheck={false} />
            </div>
            <div className="field">
                <label>Add to a mod list</label>
                <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="new">A new list “{name.trim() || 'the mod’s name'}” (the game plus this mod)</option>
                    {customs.map((l) => (
                        <option key={l.ref} value={l.ref}>
                            {l.name}
                            {props.state.selected === l.ref ? ' (loaded in the explorer)' : ''}
                        </option>
                    ))}
                    <option value="">Don’t add it to a list</option>
                </Select>
                <span className="hint">The mod becomes the active mod (the one being edited). Launcher playsets can list it once the launcher has registered it.</span>
            </div>
            {(error || (problem && name.trim())) && <div className="mods-error">{error ?? problem}</div>}
            <div className="actions">
                <button onClick={props.onClose}>Cancel</button>
                <button className="primary" disabled={!!problem || busy} onClick={() => void create()}>
                    {busy ? 'Creating…' : 'Create mod'}
                </button>
            </div>
        </Modal>
    );
}
