import { useEffect, useRef, useState } from 'react';
import type { EntityListItem, NewEntryPlan, TypeSummary } from '../../../shared/api';
import { api } from '../api';
import { reportChange } from '../changes';
import { errorText } from './ModDialogs';
import '../styles/edit.css';
import { Select } from './Select';

/** The type list's context menu (right click on a type): "New <type>…". */
export function TypeContextMenu(props: { type: TypeSummary; x: number; y: number; onNew: () => void; onClose: () => void; }): React.JSX.Element
{
    const box = useRef<HTMLDivElement>(null);
    useEffect(() =>
    {
        const onDown = (e: MouseEvent): void =>
        {
            if (!box.current?.contains(e.target as Node))
                props.onClose();
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                props.onClose();
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [props]);
    return (
        <div className="ctx-menu" ref={box} style={{ left: props.x, top: props.y }}>
            <button
                className="am-item"
                onClick={() =>
                {
                    props.onClose();
                    props.onNew();
                }}
            >
                New {singular(props.type.label)}…
            </button>
        </div>
    );
}

/** A nested type's choices: the holder (NEW: a new one, with its key and name), and the entry to start from ('' empty). */
interface NestedChoice
{
    holder: string;
    newKey: string;
    newName: string;
    from: string;
}

const NEW = '\u0000new';

/**
 * Where a nested entry goes: a filterable list of the holders (the mod's first) and "New <holder>…" (its key and name),
 * then "Start from": empty or one of the chosen holder's entries of the type.
 */
function NestedFields(props: { type: TypeSummary; nested: NonNullable<NewEntryPlan['nested']>; value: NestedChoice; onChange: (v: NestedChoice) => void; }): React.JSX.Element
{
    const { nested, value, onChange } = props;
    const [holders, setHolders] = useState<EntityListItem[] | null>(null);
    const [q, setQ] = useState('');
    const [siblings, setSiblings] = useState<string[]>([]);
    const holder = singular(nested.holderLabel);

    useEffect(() =>
    {
        let alive = true;
        void api.list(nested.holderType).then((l) => alive && setHolders(l.filter((x) => x.mod?.state !== 'removed')));
        return () =>
        {
            alive = false;
        };
    }, [nested.holderType]);

    useEffect(() =>
    {
        let alive = true;

        if (!value.holder || value.holder === NEW)
            setSiblings([]);
        else
            void api.childrenOf(props.type.id, nested.holderType, value.holder).then((l) => alive && setSiblings(l));

        return () =>
        {
            alive = false;
        };
    }, [value.holder, nested.holderType, props.type.id]);

    const words = q.toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    const shown = (holders ?? [])
        .filter((h) => words.every((w) => h.name.toLowerCase().includes(w) || h.display?.toLowerCase().includes(w)))
        .sort((a, b) => Number(!!b.mod) - Number(!!a.mod) || a.name.localeCompare(b.name))
        .slice(0, 200);
    return (
        <div className="ne-nested">
            <label>
                <span>In {holder}</span>
                <input value={q} placeholder={`Filter the ${nested.holderLabel.toLowerCase()}…`} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="ne-holders">
                {nested.newHolder && (
                    <button className={'ne-holder' + (value.holder === NEW ? ' on' : '')} onClick={() => onChange({ ...value, holder: NEW, from: '' })}>
                        ＋ New {holder}…
                    </button>
                )}
                {!holders && <div className="ne-note">…</div>}
                {shown.map((h) => (
                    <button key={h.name} className={'ne-holder' + (value.holder === h.name ? ' on' : '')} title={h.name} onClick={() => onChange({ ...value, holder: h.name, from: '' })}>
                        {h.display ?? h.name}
                        <em>{h.name}</em>
                        {h.mod && <em>· {h.mod.state === 'added' ? 'mod' : h.mod.state === 'same' ? 'copied' : 'changed'}</em>}
                    </button>
                ))}
            </div>
            {value.holder === NEW && (
                <>
                    <label>
                        <span>New {holder}: key</span>
                        <input value={value.newKey} placeholder={`my_${holder.replace(/\W+/g, '_')}`} onChange={(e) => onChange({ ...value, newKey: e.target.value })} />
                    </label>
                    <label>
                        <span>Its name in game</span>
                        <input value={value.newName} placeholder="(the key made readable)" onChange={(e) => onChange({ ...value, newName: e.target.value })} />
                    </label>
                </>
            )}
            {siblings.length > 0 && (
                <label>
                    <span>Start from</span>
                    <Select value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })}>
                        <option value="">Empty</option>
                        {siblings.map((x) => (
                            <option key={x} value={x}>
                                A copy of {x}
                            </option>
                        ))}
                    </Select>
                </label>
            )}
        </div>
    );
}

/** "Traits" → "trait", "On Actions" → "on action". */
export function singular(label: string): string
{
    const l = label.toLowerCase();
    return l.endsWith('ies') ? l.slice(0, -3) + 'y' : l.endsWith('ses') ? l.slice(0, -2) : l.replace(/s$/, '');
}

/**
 * "New <type>" (docs/mods.md, "New entries"): its key and name in game, written as a template definition (with its
 * localization) into the active mod — the dialog shows where — then opened; refused with the reason (no active mod,
 * no script definition …). A type written inside other definitions (laws in law groups, faiths in religions:
 * `NewEntryPlan.nested`) asks first which holder it goes in — or a new one — and what it starts as: empty, or a copy
 * of one of the holder's entries (`NestedFields`).
 */
export function NewEntryDialog(props: { type: TypeSummary; onClose: () => void; onOpen: (type: string, name: string) => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<NewEntryPlan | null>(null);
    const [key, setKey] = useState('');
    const [name, setName] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const one = singular(props.type.label);
    // (a nested type: where it goes and what it starts as)
    const [where, setWhere] = useState<NestedChoice>({ holder: '', newKey: '', newName: '', from: '' });

    useEffect(() =>
    {
        let alive = true;
        void api.newEntryPlan(props.type.id).then(
            (p) =>
            {
                if (!alive)
                    return;

                setPlan(p);

                if (p.key)
                    setKey(p.key);

                setTimeout(() => input.current?.select(), 0);
            },
            (e) => alive && setPlan({ type: props.type.id, label: props.type.label, problem: errorText(e), name: false })
        );
        return () =>
        {
            alive = false;
        };
    }, [props.type]);

    const create = async (): Promise<void> =>
    {
        if (!plan || plan.problem || !key.trim() || busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const nested = plan.nested ? (where.holder === NEW ? { newHolder: { key: where.newKey.trim(), name: where.newName.trim() || undefined } } : { holder: where.holder }) : {};
            const r = await api.createEntry({ type: props.type.id, key: key.trim(), name: name.trim() || undefined, ...nested, ...(where.from ? { from: where.from } : {}) });
            reportChange({
                kind: 'ok',
                text: `New ${one}: ${r.key}`,
                mod: r.mod,
                where: `${r.rel}:${r.line}`,
                file: r.file,
                line: r.line,
                details: r.loaded ? undefined : [`${r.mod} is not in the loaded mod list: the explorer does not show it.`],
                undo: r.step
            });
            props.onClose();

            if (r.loaded)
                props.onOpen(r.type, r.key);
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

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div
                className="new-entry"
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        props.onClose();

                    if (e.key === 'Enter')
                        void create();
                }}
            >
                <h3>
                    New {one}
                    {plan?.mod && <span className="ne-mod">in {plan.mod}</span>}
                </h3>
                {!plan ? <div className="ne-note">…</div> : plan.problem ? <div className="ne-problem">{plan.problem}</div> : (
                    <>
                        {plan.nested && <NestedFields type={props.type} nested={plan.nested} value={where} onChange={setWhere} />}
                        <label>
                            <span>{props.type.id === 'events' ? 'Event id' : 'Key'}</span>
                            <input ref={input} autoFocus value={key} placeholder={props.type.id === 'events' ? 'my_mod.0001' : `my_${one.replace(/\W+/g, '_')}`} onChange={(e) => setKey(e.target.value)} />
                        </label>
                        {plan.name && (
                            <label>
                                <span>{props.type.id === 'events' ? 'Title' : 'Name in game'}</span>
                                <input value={name} placeholder="(the key made readable)" onChange={(e) => setName(e.target.value)} />
                            </label>
                        )}
                        <div className="ne-note">
                            {plan.nested ?
                                (
                                    <>
                                        Written inside the {plan.nested.holderLabel.toLowerCase().replace(/s$/, '')}
                                        {plan.nested.within.length
                                            ? (
                                                <>
                                                    (its <code>{plan.nested.within.join(' › ')}</code>)
                                                </>
                                            )
                                            : null} — a {plan.nested.holderLabel.toLowerCase().replace(/s$/, '')} the mod does not write yet is copied into it first
                                        {plan.name ? ', with its localization' : ''} — then it opens, to fill in.
                                    </>
                                ) :
                                (
                                    <>
                                        Written to <code>{plan.rel}</code>
                                        {plan.name ? ' with its localization' : ''} — then it opens, to fill in.
                                    </>
                                )}
                        </div>
                        {problem && <div className="ne-problem">{problem}</div>}
                    </>
                )}
                <div className="ne-actions">
                    <button onClick={props.onClose}>Cancel</button>
                    <button className="primary" disabled={!plan || !!plan.problem || !key.trim() || busy || (!!plan.nested && (!where.holder || (where.holder === NEW && !where.newKey.trim())))} onClick={() => void create()}>
                        {busy ? 'Creating…' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * "Duplicate as a new event…" (the Override menu of an event, docs/mods.md "Duplicating an event"): the new id (the
 * next free one in the mod's namespace) and, if wanted, another title; the copy is written into the active mod — its
 * texts under the new id — and opened.
 */
export function DuplicateEventDialog(props: { source: string; onClose: () => void; onOpen: (type: string, name: string) => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<NewEntryPlan | null>(null);
    const [key, setKey] = useState('');
    const [title, setTitle] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() =>
    {
        let alive = true;
        void api.newEntryPlan('events').then(
            (p) =>
            {
                if (!alive)
                    return;

                setPlan(p);

                if (p.key)
                    setKey(p.key);

                setTimeout(() => input.current?.select(), 0);
            },
            (e) => alive && setPlan({ type: 'events', label: 'Events', problem: errorText(e), name: false })
        );
        return () =>
        {
            alive = false;
        };
    }, []);

    const create = async (): Promise<void> =>
    {
        if (!plan || plan.problem || !key.trim() || busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const r = await api.duplicateEvent({ source: props.source, key: key.trim(), title: title.trim() || undefined });
            reportChange({
                kind: 'ok',
                text: `Duplicated ${props.source} as ${r.key}`,
                mod: r.mod,
                where: `${r.rel}:${r.line}`,
                file: r.file,
                line: r.line,
                details: r.loaded ? undefined : [`${r.mod} is not in the loaded mod list: the explorer does not show it.`],
                undo: r.step
            });
            props.onClose();

            if (r.loaded)
                props.onOpen(r.type, r.key);
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

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div
                className="new-entry"
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        props.onClose();

                    if (e.key === 'Enter')
                        void create();
                }}
            >
                <h3>
                    Duplicate {props.source}
                    {plan?.mod && <span className="ne-mod">into {plan.mod}</span>}
                </h3>
                {!plan ? <div className="ne-note">…</div> : plan.problem ? <div className="ne-problem">{plan.problem}</div> : (
                    <>
                        <label>
                            <span>New event id</span>
                            <input ref={input} autoFocus value={key} placeholder="my_mod.0001" onChange={(e) => setKey(e.target.value)} />
                        </label>
                        <label>
                            <span>Title</span>
                            <input value={title} placeholder="(the original’s)" onChange={(e) => setTitle(e.target.value)} />
                        </label>
                        <div className="ne-note">
                            A copy to change freely: its texts (title, descriptions, options) are copied under the new id; the events it leads to and what fires the original stay as they are. Written to the mod’s events file with the id’s namespace — then it opens.
                        </div>
                        {problem && <div className="ne-problem">{problem}</div>}
                    </>
                )}
                <div className="ne-actions">
                    <button onClick={props.onClose}>Cancel</button>
                    <button className="primary" disabled={!plan || !!plan.problem || !key.trim() || busy} onClick={() => void create()}>
                        {busy ? 'Duplicating…' : 'Duplicate'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * "Duplicate …" of any other type (the entry list's context menu, docs/mods.md "Duplicating an entry"): the new key
 * (default `<source>_copy`) and, if wanted, another name in game; the copy is written into the active mod where new
 * entries of the type go — its texts under keys following the new one — and opened.
 */
export function DuplicateEntryDialog(props: { type: TypeSummary; source: string; onClose: () => void; onOpen: (type: string, name: string) => void; }): React.JSX.Element
{
    const [plan, setPlan] = useState<NewEntryPlan | null>(null);
    const [key, setKey] = useState(props.source + '_copy');
    const [name, setName] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const what = singular(props.type.label);

    useEffect(() =>
    {
        let alive = true;
        void api.newEntryPlan(props.type.id).then(
            (p) =>
            {
                if (!alive)
                    return;

                setPlan(p);
                setTimeout(() => input.current?.select(), 0);
            },
            (e) => alive && setPlan({ type: props.type.id, label: props.type.label, problem: errorText(e), name: false })
        );
        return () =>
        {
            alive = false;
        };
    }, [props.type]);

    const create = async (): Promise<void> =>
    {
        if (!plan || plan.problem || !key.trim() || busy)
            return;

        setBusy(true);
        setProblem(null);

        try
        {
            const r = await api.duplicateEntry({ type: props.type.id, source: props.source, key: key.trim(), name: name.trim() || undefined });
            reportChange({
                kind: 'ok',
                text: `Duplicated ${props.source} as ${r.key}`,
                mod: r.mod,
                where: `${r.rel}:${r.line}`,
                file: r.file,
                line: r.line,
                details: r.loaded ? undefined : [`${r.mod} is not in the loaded mod list: the explorer does not show it.`],
                undo: r.step
            });
            props.onClose();

            if (r.loaded)
                props.onOpen(r.type, r.key);
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

    return (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div
                className="new-entry"
                onKeyDown={(e) =>
                {
                    if (e.key === 'Escape')
                        props.onClose();

                    if (e.key === 'Enter')
                        void create();
                }}
            >
                <h3>
                    Duplicate {props.source}
                    {plan?.mod && <span className="ne-mod">into {plan.mod}</span>}
                </h3>
                {!plan ? <div className="ne-note">…</div> : plan.problem ? <div className="ne-problem">{plan.problem}</div> : (
                    <>
                        <label>
                            <span>New key</span>
                            <input ref={input} autoFocus value={key} onChange={(e) => setKey(e.target.value)} />
                        </label>
                        <label>
                            <span>Name in game</span>
                            <input value={name} placeholder="(the original’s)" onChange={(e) => setName(e.target.value)} />
                        </label>
                        <div className="ne-note">
                            A copy of this {what} to change freely: its definition under the new key (with the name everywhere it names itself), its texts (name, description) copied under keys following the new one.{' '}
                            {plan.nested ? `Written next to it inside its ${singular(plan.nested.holderLabel)} (copied into the mod first when the mod does not write it yet)` : `Written to ${plan.rel ?? 'the mod'}`} — then it opens.
                        </div>
                        {problem && <div className="ne-problem">{problem}</div>}
                    </>
                )}
                <div className="ne-actions">
                    <button onClick={props.onClose}>Cancel</button>
                    <button className="primary" disabled={!plan || !!plan.problem || !key.trim() || busy} onClick={() => void create()}>
                        {busy ? 'Duplicating…' : 'Duplicate'}
                    </button>
                </div>
            </div>
        </div>
    );
}
