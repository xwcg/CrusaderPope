import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterFilter, EntityListItem, SearchResult, TypeSummary } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { Throbber, VirtualList, formatCount } from './common';
import { GameImg } from '../img';
import { CharacterFilters, activeCriteria } from './CharacterFilters';
import { HideRemovedToggle, ModChip, ModStateFilter, ModToggle, type ModStateCounts } from './ModChip';
import { isConflict, matchesState, shownWith, useHideRemoved, useModFilter } from '../modStore';
import { EntryContextMenu } from './EntryMenu';
import { Select } from './Select';

import { fold } from '../../../shared/fold';
import { tr } from '../../../shared/i18n';
type Sort = 'name' | 'refs' | 'file';

const listCache = new Map<string, EntityListItem[]>();
/** per type: its entries' DLC or mod (base game entries left out), for the DLC filter */
const dlcCache = new Map<string, Record<string, string>>();
const BASE = tr('Base game');
let listCacheKey = '';

/** The played character of the loaded save (Savegame → Characters). */
function YouButton(props: { onSelect: (name: string) => void; }): React.JSX.Element | null
{
    const [you, setYou] = useState<number | undefined>(undefined);
    useEffect(() =>
    {
        void api.loadedSave().then((l) => setYou(l.players?.[0]));
    }, []);
    return you === undefined ? null : <button className="small you-button" onClick={() => props.onSelect(String(you))} title={tr('The character you play in this save')}>{tr('You')}</button>;
}

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
    // only the entries of one DLC (or mod, or the base game); '' = all
    const [dlc, setDlc] = useState('');
    const [dlcs, setDlcs] = useState<Record<string, string> | null>(null);
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
            dlcCache.clear();
            listCacheKey = props.reloadKey;
        }

        const sameType = shownType.current === type.id;
        shownType.current = type.id;

        if (!sameType)
        {
            setFilter('');
            setDlc('');
        }

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
            // (an answer of an older effect belongs to another reloadKey: not kept)
            if (cancelled)
                return;

            listCache.set(type.id, l);
            setItems(l);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [type.id, type.searchOnly, props.reloadKey]);

    // the DLC each entry comes with (after the list: it reads every entry's definition)
    useEffect(() =>
    {
        if (type.searchOnly || !items)
            return;

        const cached = dlcCache.get(type.id);

        if (cached)
        {
            setDlcs(cached);
            return;
        }

        setDlcs(null);
        let cancelled = false;
        void api.dlcGroups(type.id).then((g) =>
        {
            if (cancelled)
                return;

            dlcCache.set(type.id, g);
            setDlcs(g);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [type.id, type.searchOnly, items]);

    // the filter's choices: the DLCs (and mods) with entries here, by name, and how many
    const dlcCounts = useMemo(() =>
    {
        if (!dlcs || !items)
            return [];

        const c = new Map<string, number>();

        for (const i of items)
        {
            const g = dlcs[i.name] ?? BASE;
            c.set(g, (c.get(g) ?? 0) + 1);
        }

        const order = (g: string): number => (g === BASE ? 0 : g.startsWith('Mod: ') ? 2 : 1);
        return [...c].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
    }, [dlcs, items]);
    const hasDlcs = dlcCounts.some(([g]) => g !== BASE && !g.startsWith('Mod: '));

    // entries per kind of mod change and the conflicts (the state filter's counts)
    const modCounts = useMemo(() =>
    {
        const c: ModStateCounts = { added: 0, overridden: 0, same: 0, removed: 0, merged: 0, conflicts: 0, duplicates: 0 };

        for (const i of items ?? [])
        {
            if (!i.mod)
                continue;

            c[i.mod.state]++;

            // (a removed one is not counted among the conflicts / duplicates while removed entries are hidden: the list
            // doesn't show it)
            const shown = !hideRemoved || i.mod.state !== 'removed';

            if (isConflict(i.mod) && shown)
                c.conflicts++;

            if (i.mod.duplicate && shown)
                c.duplicates++;
        }

        return c;
    }, [items, hideRemoved]);

    const filtered = useMemo(() =>
    {
        if (!items)
            return [];

        const f = fold(filter.trim());
        let out = f ? items.filter((i) => fold(i.name).includes(f) || (i.display !== undefined && fold(i.display).includes(f)) || (i.file !== undefined && fold(i.file).includes(f))) : items;

        if (allowed)
            out = out.filter((i) => allowed.has(i.name));

        if (dlc && dlcs)
            out = out.filter((i) => (dlcs[i.name] ?? BASE) === dlc);

        if (modFilter.on)
            out = out.filter((i) => matchesState(i.mod, modFilter.state));

        // (entries a mod removed, while they are hidden, unless the removed ones are what the state filter asks for)
        if (hideRemoved && modCounts.removed)
            out = out.filter((i) => shownWith(i.mod, true, modFilter));

        if (sort === 'refs')
            out = [...out].sort((a, b) => b.refs - a.refs);
        else if (sort === 'file')
            out = [...out].sort((a, b) => (a.file ?? '').localeCompare(b.file ?? ''));

        return out;
    }, [items, filter, sort, allowed, dlc, dlcs, modFilter, hideRemoved, modCounts.removed]);

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
                        {items ? (filter || allowed || dlc || modFilter.on || (hideRemoved && modCounts.removed) ? `${filtered.length} / ${items.length}` : items.length) : '…'}
                    </span>
                    <HideRemovedToggle count={modCounts.removed} />
                    {/* (a loaded save's characters: the player's own, one click away) */}
                    {type.id === 'savegame/characters' && <YouButton onSelect={props.onSelect} />}
                </div>
                <div className="row">
                    <input placeholder={tr('Filter by key, name or file…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title={tr('Sort')}>
                        <option value="name">{tr('A–Z')}</option>
                        <option value="refs">{tr('Most used')}</option>
                        <option value="file">{tr('File')}</option>
                    </Select>
                    {isCharacters && (
                        <button className={'ghost small cf-toggle' + (criteria ? ' active' : '')} onClick={() => setShowFilters((v) => !v)} title={tr('Filter by age, gender, faith, culture, rank …')}>
                            {tr('Filters')}{criteria ? ` (${criteria})` : ''}
                        </button>
                    )}
                    {(hasDlcs || dlc) && (
                        <Select className={'dlc-filter' + (dlc ? ' on' : '')} value={dlc} onChange={(e) => setDlc(e.target.value)} title={tr('Only the entries a DLC comes with (or the base game\'s, or a mod\'s)')}>
                            <option value="">{tr('All DLCs')}</option>
                            {dlcCounts.map(([g, n]) => <option key={g} value={g}>{`${g} · ${formatCount(n)}`}</option>)}
                        </Select>
                    )}
                    <ModToggle />
                </div>
                {modFilter.on && <ModStateFilter counts={modCounts} />}
                {isCharacters && showFilters && <CharacterFilters value={charFilter} onChange={setCharFilter} />}
            </div>
            {items === null ? <Throbber text={tr('Loading the entries…')} /> : filtered.length === 0 ?
                (
                    <div className="list-empty">
                        {dlc && items.length
                            ? tr('No entries of {dlc} here{filterNote}.', { dlc, filterNote: filter || modFilter.on ? tr(' with this filter') : '' })
                            : modFilter.on && items.length
                            ? (modFilter.state === 'conflicts' ? tr('No conflicts here: no entry is changed by two or more of the loaded mods.') : tr('The loaded mods change nothing here.'))
                            : hideRemoved && items.length && modCounts.removed === items.length
                            ? tr('The loaded mods removed every entry here (hidden — “Show removed” in the list head lists them).')
                            : tr('Nothing here.')}
                    </div>
                ) :
                (
                    <VirtualList
                        items={filtered}
                        rowHeight={42}
                        scrollToIndex={selectedIndex}
                        // (another list, not the same one after an index update: back to the top)
                        resetKey={[type.id, filter, sort, allowed, dlc, modFilter.on, modFilter.state, hideRemoved]}
                        render={(it, _i, style) => (
                            <div
                                key={it.name}
                                className={'entity-row' + (it.name === props.selected ? ' active' : '') + (it.mod?.state === 'removed' ? ' removed' : '')}
                                data-entity={`${type.id}:${it.name}`}
                                style={style}
                                onClick={() => props.onSelect(it.name)}
                                onContextMenu={(e) =>
                                {
                                    e.preventDefault();
                                    setMenu({ item: it, x: e.clientX, y: e.clientY });
                                }}
                                title={it.file ? tr('{file} — right click: more', { file: it.file }) : tr('Right click: more')}
                            >
                                {hasIcons && <div className="row-icon">{it.icon && <GameImg path={it.icon} size={32} />}</div>}
                                <div className="row-text">
                                    <div className="line1">
                                        <span className="name">{it.name}</span>
                                        {it.defs > 1 && <span className="refs" title={tr('Defined in several places')}>×{it.defs}</span>}
                                        <ModChip touch={it.mod} />
                                        <span className="refs" title={tr('Incoming references')}>
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
            void api.search(q, { types: [props.type.id], text: true, limit: 500, modOnly: modFilter.on, state: modFilter.state, noRemoved: hideRemoved }).then((r) =>
            {
                if (my === seq.current)
                    setResults(r);
            });
        }, 150);
        return () => clearTimeout(t);
    }, [q, props.type.id, modFilter.on, modFilter.state, hideRemoved]);

    return (
        <div className="entity-list">
            <div className="head">
                <div className="title">
                    <h2>{props.type.label}</h2>
                    <span className="count">
                        {tr('{count} keys', { count: formatCount(props.type.count) })}{props.type.modCount ? tr(' · {count} from mods', { count: formatCount(props.type.modCount) }) : ''}
                    </span>
                    <HideRemovedToggle count={props.type.modStates?.removed ?? 0} />
                </div>
                <div className="row">
                    <input autoFocus placeholder={tr('Search keys and text…')} value={q} onChange={(e) => setQ(e.target.value)} />
                    <ModToggle />
                </div>
            </div>
            {!q.trim() ? <div className="list-empty">{tr('Type to search localization keys and their text.')}</div> : (
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
