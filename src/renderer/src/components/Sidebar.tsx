import { useMemo, useState } from 'react';
import type { TypeSummary } from '../../../shared/api';
import { TypeDot, formatCount } from './common';
import { STATE_LABEL, useHideRemoved, useModFilter, type ModFilter } from '../modStore';
import { NewEntryDialog, TypeContextMenu } from './NewEntry';

/** Entries of a type the mod filter shows: all, those from mods, one kind of change, or the conflicts. */
function filterCount(t: TypeSummary, f: ModFilter, hideRemoved: boolean): number
{
    const removed = hideRemoved ? (t.modStates?.removed ?? 0) : 0;

    if (!f.on)
        return t.count - removed;

    if (f.state === 'all')
        return (t.modCount ?? 0) - removed;

    return t.modStates?.[f.state] ?? 0;
}

/** What the sidebar lists while the mod filter is on. */
function filterLabel(f: ModFilter): string
{
    if (f.state === 'all')
        return 'Types with mod content';

    if (f.state === 'conflicts')
        return 'Types with conflicts';

    if (f.state === 'same')
        return 'Types with entries the same as the game';

    if (f.state === 'duplicates')
        return 'Types with duplicates';

    return `Types with ${STATE_LABEL[f.state].toLowerCase()} entries`;
}

const GROUP_ORDER_FIRST = ['Core', 'Graphics', 'Common'];
const GROUP_ORDER_LAST = ['History', 'Implicit', 'Localization'];
const OPEN_BY_DEFAULT = new Set(['Core', 'Graphics', 'History', 'Implicit', 'Localization']);

function groupLabel(g: string): string
{
    if (g === 'Implicit')
        return 'Implicit (flags & variables)';

    return g
        .split('_')
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

export function Sidebar(props: { types: TypeSummary[]; active: string; onSelect: (type: string) => void; onOpen: (type: string, name: string) => void; }): React.JSX.Element
{
    const [filter, setFilter] = useState('');
    // right click on a type: its menu ("New <type>…"), and the dialog making one
    const [menu, setMenu] = useState<{ type: TypeSummary; x: number; y: number; } | null>(null);
    const [making, setMaking] = useState<TypeSummary | null>(null);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    // "mod content only" (shared with the list): only types the loaded mods touch, counted by their mod entries — or
    // by the list's state filter (one kind of change, the conflicts)
    const [modFilter] = useModFilter();
    // entries the loaded mods removed are not counted while they are hidden (the list's "Removed" toggle)
    const [hideRemoved] = useHideRemoved();
    const count = (t: TypeSummary): number => filterCount(t, modFilter, hideRemoved);
    const modCount = (t: TypeSummary): number => (t.modCount ?? 0) - (hideRemoved ? (t.modStates?.removed ?? 0) : 0);

    const groups = useMemo(() =>
    {
        const f = filter.trim().toLowerCase();
        const m = new Map<string, TypeSummary[]>();

        for (const t of props.types)
        {
            if (f && !t.label.toLowerCase().includes(f) && !t.id.toLowerCase().includes(f))
                continue;

            if (modFilter.on && !filterCount(t, modFilter, hideRemoved))
                continue;

            const l = m.get(t.group) ?? [];
            l.push(t);
            m.set(t.group, l);
        }

        const rank = (g: string): number =>
        {
            const a = GROUP_ORDER_FIRST.indexOf(g);

            if (a >= 0)
                return a;

            const b = GROUP_ORDER_LAST.indexOf(g);

            if (b >= 0)
                return 1000 + b;

            return 10;
        };
        return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
    }, [props.types, filter, modFilter, hideRemoved]);

    const activeGroup = props.types.find((t) => t.id === props.active)?.group;

    return (
        <div className="sidebar">
            <div className="filter">
                <input placeholder="Filter types…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {modFilter.on && (
                <div className={'mod-only-note' + (modFilter.state === 'conflicts' || modFilter.state === 'duplicates' ? ' conflicts' : '')}>
                    {filterLabel(modFilter)} · {groups.reduce((s, [, l]) => s + l.length, 0)}
                </div>
            )}
            <div className="groups">
                {groups.map(([g, types]) =>
                {
                    const isOpen = filter.trim() !== '' || (open[g] ?? (OPEN_BY_DEFAULT.has(g) || g === activeGroup));
                    const total = types.reduce((s, t) => s + count(t), 0);
                    return (
                        <div key={g}>
                            <div className="group-header" onClick={() => setOpen((o) => ({ ...o, [g]: !isOpen }))}>
                                <span>{isOpen ? '▾' : '▸'}</span>
                                <span style={{ flex: 1 }}>{groupLabel(g)}</span>
                                {!isOpen && <span>{formatCount(total)}</span>}
                            </div>
                            {isOpen &&
                                types.map((t) => (
                                    <div
                                        key={t.id}
                                        className={'type-row' + (t.id === props.active ? ' active' : '')}
                                        onClick={() => props.onSelect(t.id)}
                                        onContextMenu={(e) =>
                                        {
                                            e.preventDefault();
                                            setMenu({ type: t, x: e.clientX, y: e.clientY });
                                        }}
                                        title={`${t.id} — right click: New ${t.label.toLowerCase()}…`}
                                    >
                                        <TypeDot type={t.id} />
                                        <span className="label">{t.label}</span>
                                        {!modFilter.on && modCount(t) > 0 ?
                                            (
                                                <span className="mod-count" title={`${modCount(t).toLocaleString()} entries ${hideRemoved ? 'added or changed' : 'added, changed or removed'} by the loaded mods`}>
                                                    {formatCount(modCount(t))}
                                                </span>
                                            ) :
                                            null}
                                        <span
                                            className={'count' + (modFilter.on && (modFilter.state === 'conflicts' || modFilter.state === 'duplicates') ? ' conflicts' : '')}
                                            title={modFilter.on ? `${count(t).toLocaleString()} of ${t.count.toLocaleString()} entries (${filterLabel(modFilter).replace(/^Types with /, '')})` : undefined}
                                        >
                                            {formatCount(count(t))}
                                        </span>
                                    </div>
                                ))}
                        </div>
                    );
                })}
            </div>
            {menu && <TypeContextMenu type={menu.type} x={menu.x} y={menu.y} onNew={() => setMaking(menu.type)} onClose={() => setMenu(null)} />}
            {making && <NewEntryDialog type={making} onClose={() => setMaking(null)} onOpen={props.onOpen} />}
        </div>
    );
}
