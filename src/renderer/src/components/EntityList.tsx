import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterFilter, EntityListItem, SearchResult, TypeSummary } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { VirtualList, formatCount } from './common';
import { GameImg } from '../img';
import { CharacterFilters, activeCriteria } from './CharacterFilters';
import { HideRemovedToggle, ModChip, ModStateFilter, ModToggle, type ModStateCounts } from './ModChip';
import { isConflict, matchesState, shownWith, useHideRemoved, useModFilter } from '../modStore';
import { EntryContextMenu } from './EntryMenu';

type Sort = 'name' | 'refs' | 'file';

const listCache = new Map<string, EntityListItem[]>();
let listCacheKey = '';

export function EntityList(props: {
    type: TypeSummary;
    selected?: string;
    reloadKey: string;
    onSelect: (name: string) => void;
    navigate: Navigate;
}): React.JSX.Element
{
    const { type } = props;
    const [items, setItems] = useState<EntityListItem[] | null>(null);
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState<Sort>('name');
    // Historical Characters: filters on facts at a date, evaluated in the worker (ids that match)
    const isCharacters = type.id === 'characters';
    const [showFilters, setShowFilters] = useState(false);
    const [charFilter, setCharFilter] = useState<CharacterFilter>({});
    const [allowed, setAllowed] = useState<Set<string> | null>(null);
    const criteria = isCharacters ? activeCriteria(charFilter) : 0;
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    // the context menu of an entry (right click)
    const [menu, setMenu] = useState<{ item: EntityListItem; x: number; y: number; } | null>(null);
    useEffect(() =>
    {
        if (!isCharacters || !criteria)
        {
            setAllowed(null);
            return;
        }

        let cancelled = false;
        const t = setTimeout(() =>
        {
            void api.characterFilter(charFilter).then((ids) => !cancelled && setAllowed(new Set(ids)));
        }, 200);
        return () =>
        {
            cancelled = true;
            clearTimeout(t);
        };
    }, [isCharacters, criteria, charFilter, props.reloadKey]);

    // another type: its list from scratch; the same type after an index update: the list stays (filter, scroll) until
    // the new one is there
    const shownType = useRef('');
    useEffect(() =>
    {
        if (listCacheKey !== props.reloadKey)
        {
            listCache.clear();
            listCacheKey = props.reloadKey;
        }

        const sameType = shownType.current === type.id;
        shownType.current = type.id;

        if (!sameType)
            setFilter('');

        if (type.searchOnly)
        {
            setItems([]);
            return;
        }

        const cached = listCache.get(type.id);

        if (cached)
        {
            setItems(cached);
            return;
        }

        if (!sameType)
            setItems(null);

        let cancelled = false;
        void api.list(type.id).then((l) =>
        {
            listCache.set(type.id, l);

            if (!cancelled)
                setItems(l);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [type.id, type.searchOnly, props.reloadKey]);

    // entries per kind of mod change and the conflicts (the state filter's counts)
    const modCounts = useMemo(() =>
    {
        const c: ModStateCounts = { added: 0, overridden: 0, same: 0, removed: 0, merged: 0, conflicts: 0, duplicates: 0 };

        for (const i of items ?? [])
        {
            if (!i.mod)
                continue;

            c[i.mod.state]++;

            if (isConflict(i.mod))
                c.conflicts++;

            if (i.mod.duplicate)
                c.duplicates++;
        }

        return c;
    }, [items]);

    const filtered = useMemo(() =>
    {
        if (!items)
            return [];

        const f = filter.trim().toLowerCase();
        let out = f ? items.filter((i) => i.name.toLowerCase().includes(f) || i.display?.toLowerCase().includes(f) || i.file?.toLowerCase().includes(f)) : items;

        if (allowed)
            out = out.filter((i) => allowed.has(i.name));

        if (modFilter.on)
            out = out.filter((i) => matchesState(i.mod, modFilter.state));

        // (entries a mod removed, while they are hidden — unless the removed ones are what the state filter asks for)
        if (hideRemoved && modCounts.removed)
            out = out.filter((i) => shownWith(i.mod, true, modFilter));

        if (sort === 'refs')
            out = [...out].sort((a, b) => b.refs - a.refs);
        else if (sort === 'file')
            out = [...out].sort((a, b) => (a.file ?? '').localeCompare(b.file ?? ''));

        return out;
    }, [items, filter, sort, allowed, modFilter, hideRemoved, modCounts.removed]);

    const selectedIndex = props.selected ? filtered.findIndex((i) => i.name === props.selected) : -1;
    const hasIcons = useMemo(() => !!items?.some((i) => i.icon), [items]);

    if (type.searchOnly)
        return <LocSearchList type={type} selected={props.selected} onSelect={props.onSelect} />;

    return (
        <div className="entity-list">
            <div className="head">
                <div className="title">
                    <h2>{type.label}</h2>
                    <span className="count">
                        {items ? (filter || allowed || modFilter.on || (hideRemoved && modCounts.removed) ? `${filtered.length} / ${items.length}` : items.length) : '…'}
                    </span>
                    <HideRemovedToggle count={modCounts.removed} />
                </div>
                <div className="row">
                    <input placeholder="Filter by key, name or file…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="Sort">
                        <option value="name">A–Z</option>
                        <option value="refs">Most used</option>
                        <option value="file">File</option>
                    </select>
                    {isCharacters && (
                        <button className={'ghost small cf-toggle' + (criteria ? ' active' : '')} onClick={() => setShowFilters((v) => !v)} title="Filter by age, gender, faith, culture, rank …">
                            Filters{criteria ? ` (${criteria})` : ''}
                        </button>
                    )}
                    <ModToggle />
                </div>
                {modFilter.on && <ModStateFilter counts={modCounts} />}
                {isCharacters && showFilters && <CharacterFilters value={charFilter} onChange={setCharFilter} />}
            </div>
            {items === null ? <div className="list-empty">Loading…</div> : filtered.length === 0 ?
                (
                    <div className="list-empty">
                        {modFilter.on && items.length
                            ? (modFilter.state === 'conflicts' ? 'No conflicts here: no entry is changed by two or more of the loaded mods.' : 'The loaded mods change nothing here.')
                            : hideRemoved && items.length && modCounts.removed === items.length
                            ? 'The loaded mods removed every entry here (hidden — “Removed” in the list head shows them).'
                            : 'Nothing here.'}
                    </div>
                ) :
                (
                    <VirtualList
                        items={filtered}
                        rowHeight={42}
                        scrollToIndex={selectedIndex}
                        // (another list, not the same one after an index update: back to the top)
                        resetKey={[type.id, filter, sort, allowed, modFilter.on, modFilter.state, hideRemoved]}
                        render={(it, _i, style) => (
                            <div
                                key={it.name}
                                className={'entity-row' + (it.name === props.selected ? ' active' : '') + (it.mod?.state === 'removed' ? ' removed' : '')}
                                style={style}
                                onClick={() => props.onSelect(it.name)}
                                onContextMenu={(e) =>
                                {
                                    e.preventDefault();
                                    setMenu({ item: it, x: e.clientX, y: e.clientY });
                                }}
                                title={it.file ? `${it.file} — right click: more` : 'Right click: more'}
                            >
                                {hasIcons && <div className="row-icon">{it.icon && <GameImg path={it.icon} size={32} />}</div>}
                                <div className="row-text">
                                    <div className="line1">
                                        <span className="name">{it.name}</span>
                                        {it.defs > 1 && <span className="refs" title="Defined in several places">×{it.defs}</span>}
                                        <ModChip touch={it.mod} />
                                        <span className="refs" title="Incoming references">
                                            {it.refs ? '← ' + formatCount(it.refs) : ''}
                                        </span>
                                    </div>
                                    <div className="display">{it.display ?? ' '}</div>
                                </div>
                            </div>
                        )}
                    />
                )}
            {menu && <EntryContextMenu type={type} item={menu.item} x={menu.x} y={menu.y} navigate={props.navigate} onClose={() => setMenu(null)} />}
        </div>
    );
}

/** Localization has ~300k keys: search instead of listing everything. */
function LocSearchList(props: { type: TypeSummary; selected?: string; onSelect: (name: string) => void; }): React.JSX.Element
{
    const [q, setQ] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const seq = useRef(0);
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    useEffect(() =>
    {
        if (!q.trim())
        {
            setResults([]);
            return;
        }

        const t = setTimeout(() =>
        {
            const my = ++seq.current;
            void api.search(q, { types: [props.type.id], text: true, limit: 500, modOnly: modFilter.on, noRemoved: hideRemoved }).then((r) =>
            {
                if (my === seq.current)
                    setResults(r);
            });
        }, 150);
        return () => clearTimeout(t);
    }, [q, props.type.id, modFilter.on, hideRemoved]);

    return (
        <div className="entity-list">
            <div className="head">
                <div className="title">
                    <h2>{props.type.label}</h2>
                    <span className="count">
                        {formatCount(props.type.count)} keys{props.type.modCount ? ` · ${formatCount(props.type.modCount)} from mods` : ''}
                    </span>
                    <HideRemovedToggle count={props.type.modStates?.removed ?? 0} />
                </div>
                <div className="row">
                    <input autoFocus placeholder="Search keys and text…" value={q} onChange={(e) => setQ(e.target.value)} />
                    <ModToggle />
                </div>
            </div>
            {!q.trim() ? <div className="list-empty">Type to search localization keys and their text.</div> : (
                <VirtualList
                    items={results}
                    rowHeight={42}
                    render={(r, _i, style) => (
                        <div
                            key={r.name}
                            className={'entity-row' + (r.name === props.selected ? ' active' : '') + (r.mod?.state === 'removed' ? ' removed' : '')}
                            style={style}
                            onClick={() => props.onSelect(r.name)}
                        >
                            <div className="line1">
                                <span className="name">{r.name}</span>
                                <ModChip touch={r.mod} />
                            </div>
                            <div className="display">{r.match ?? r.display ?? ' '}</div>
                        </div>
                    )}
                />
            )}
        </div>
    );
}
