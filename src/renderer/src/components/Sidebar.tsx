import { useMemo, useState } from 'react';
import type { TypeSummary } from '../../../shared/api';
import { Throbber, TypeDot, formatCount } from './common';
import { STATE_LABEL, useHideRemoved, useModFilter, type ModFilter } from '../modStore';
import { NewEntryDialog, TypeContextMenu } from './NewEntry';

import { tr, trm } from '../../../shared/i18n';
import { fold, foldHas } from '../../../shared/fold';
/** Entries of a type the mod filter shows: all, those from mods, one kind of change, or the conflicts. */
function filterCount(t: TypeSummary, f: ModFilter, hideRemoved: boolean): number
{
    const removed = hideRemoved ? (t.modStates?.removed ?? 0) : 0;

    if (!f.on)
        return t.count - removed;

    if (f.state === 'all')
        return (t.modCount ?? 0) - removed;

    // (the conflicts and duplicates that are removals: not counted while removed entries are hidden, as the list
    // doesn't show them)
    if (hideRemoved && (f.state === 'conflicts' || f.state === 'duplicates'))
        return (t.modStates?.[f.state] ?? 0) - (t.modStates?.[`${f.state}Removed`] ?? 0);

    return t.modStates?.[f.state] ?? 0;
}

/** What the sidebar lists while the mod filter is on. */
function filterLabel(f: ModFilter): string
{
    if (f.state === 'all')
        return tr('Types with mod content');

    if (f.state === 'conflicts')
        return tr('Types with conflicts');

    if (f.state === 'same')
        return tr('Types with entries the same as the game');

    if (f.state === 'duplicates')
        return tr('Types with duplicates');

    return tr('Types with {state} entries', { state: STATE_LABEL[f.state].toLowerCase() });
}

const GROUP_ORDER_FIRST = ['Savegame', 'Core', 'Graphics', 'Common'];
const GROUP_ORDER_LAST = ['History', 'Implicit', 'Localization'];
const OPEN_BY_DEFAULT = new Set(['Savegame', 'Core', 'Graphics', 'History', 'Implicit', 'Localization']);

function groupLabel(g: string): string
{
    if (g === 'Implicit')
        return tr('Implicit (flags & variables)');

    // (groups are keys (the schema's and common/<folder> names): translated here, where they show; the folders' own
    // names are not in the template, a catalog may still have them)
    return tr(
        g
            .split('_')
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(' ')
    );
}

/** the schema's own group names, for the catalog template (shown through groupLabel) */
export const GROUP_NAMES = [trm('Savegame'), trm('Core'), trm('Graphics'), trm('Common'), trm('History'), trm('Localization'), trm('Game Rules'), trm('Laws'), trm('Religion')];

export function Sidebar(props: { types: TypeSummary[]; active: string; onSelect: (type: string) => void; onOpen: (type: string, name: string) => void; }): React.JSX.Element
{
    const [filter, setFilter] = useState('');
    // right click on a type: its menu ("New <type>…"), and the dialog making one
    const [menu, setMenu] = useState<{ type: TypeSummary; x: number; y: number; } | null>(null);
    const [making, setMaking] = useState<TypeSummary | null>(null);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    // "mod content only" (shared with the list): only types the loaded mods touch, counted by their mod entries, or
    // by the list's state filter (one kind of change, the conflicts)
    const [modFilter] = useModFilter();
    // entries the loaded mods removed are not counted while they are hidden (the list's "Removed" toggle)
    const [hideRemoved] = useHideRemoved();
    const count = (t: TypeSummary): number => filterCount(t, modFilter, hideRemoved);
    const modCount = (t: TypeSummary): number => (t.modCount ?? 0) - (hideRemoved ? (t.modStates?.removed ?? 0) : 0);

    const groups = useMemo(() =>
    {
        const f = fold(filter.trim());
        const m = new Map<string, TypeSummary[]>();

        for (const t of props.types)
        {
            if (f && !foldHas(t.label, f) && !foldHas(t.id, f))
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
                <input placeholder={tr('Filter types…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {modFilter.on && (
                <div className={'mod-only-note' + (modFilter.state === 'conflicts' || modFilter.state === 'duplicates' ? ' conflicts' : '')}>
                    {filterLabel(modFilter)} · {groups.reduce((s, [, l]) => s + l.length, 0)}
                </div>
            )}
            <div className="groups">
                {/* (the types not there yet: right after a build, before the first answer) */}
                {!props.types.length && <Throbber text={tr('Reading the types…')} />}
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
                                        title={tr('{id} — right click: New {label}…', { id: t.id, label: t.label.toLowerCase() })}
                                    >
                                        <TypeDot type={t.id} />
                                        <span className="label">{t.label}</span>
                                        {!modFilter.on && modCount(t) > 0 ?
                                            (
                                                <span className="mod-count" title={tr('{count} entries {kinds} by the loaded mods', { count: modCount(t).toLocaleString(), kinds: hideRemoved ? tr('added or changed') : tr('added, changed or removed') })}>
                                                    {formatCount(modCount(t))}
                                                </span>
                                            ) :
                                            null}
                                        <span
                                            className={'count' + (modFilter.on && (modFilter.state === 'conflicts' || modFilter.state === 'duplicates') ? ' conflicts' : '')}
                                            title={modFilter.on ? tr('{shown} of {total} entries ({filterName})', { shown: count(t).toLocaleString(), total: t.count.toLocaleString(), filterName: filterLabel(modFilter).replace(/^Types with /, '') }) : undefined}
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
