import { useEffect, useRef, useState } from 'react';
import type { IndexStatus, ModsState, SearchResult } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { TypeChip, formatCount } from './common';
import { GameImg } from '../img';
import { ModsTab } from './ModsView';
import { ModChip, ModToggle } from './ModChip';
import { useHideRemoved, useLoadedMods, useModChange, useModFilter } from '../modStore';
import { TryPicker } from '../picker/TryPicker';
import '../styles/edit.css';

export function TopBar(props: {
    status: IndexStatus;
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    navigate: Navigate;
    onSettings: () => void;
    mods: ModsState | null;
    modsOpen: boolean;
    onMods: () => void;
    /** back to the explorer page last shown */
    onExplorer: () => void;
    mapOpen: boolean;
    onMap: () => void;
}): React.JSX.Element
{
    return (
        <div className="topbar">
            <div className="brand">
                CrusaderPope
            </div>
            <nav className="app-tabs">
                <button className={'app-tab' + (props.modsOpen || props.mapOpen ? '' : ' on')} onClick={props.onExplorer} title="Browse the game data (with the loaded mods)">
                    Explorer
                </button>
                <button className={'app-tab' + (props.mapOpen ? ' on' : '')} onClick={props.onMap} title="The map: realms at a bookmark date, de jure titles, cultures, faiths, terrain">
                    Map
                </button>
                <ModsTab state={props.mods} open={props.modsOpen} onClick={props.onMods} />
            </nav>
            <div className="nav-buttons">
                <button className="ghost" disabled={!props.canBack} onClick={props.onBack} title="Back (Alt+←)">
                    ←
                </button>
                <button className="ghost" disabled={!props.canForward} onClick={props.onForward} title="Forward (Alt+→)">
                    →
                </button>
            </div>
            {props.status.state === 'ready' && <SearchBox navigate={props.navigate} />}
            <div className="spacer" />
            <ModChangeNotice />
            <StatusIndicator status={props.status} />
            {props.status.state === 'ready' && <TryPicker />}
            <button className="ghost" onClick={props.onSettings} title="Settings">
                ⚙
            </button>
        </div>
    );
}

/**
 * Files of loaded mods changed since the index was built in a way only a re-index takes in (the main process watches
 * their folders — ordinary changes show by themselves): offers a re-index — never started by itself, a full one takes
 * 10–30 s. Gone once a build starts.
 */
function ModChangeNotice(): React.JSX.Element | null
{
    const change = useModChange();

    if (!change)
        return null;

    const mods = change.mods ?? [{ id: change.mod, name: change.name, active: true }];
    const shown = change.files.slice(0, 12);
    const more = change.files.length - shown.length;
    const tip = [`Changed in ${mods.map((m) => m.name).join(', ')}:`, ...shown.map((f) => '  ' + f), ...(more > 0 ? [`  … and ${more} more`] : []), '', 'Re-index to see the changes in the explorer.'].join('\n');
    const label = mods.length > 1 ? `${mods.length} mods changed` : mods[0].active ? 'Active mod changed' : `${mods[0].name} changed`;
    return (
        <div className="mod-change" title={tip}>
            <span>{label}</span>
            <button className="primary" onClick={() => void api.rebuild(false)}>
                Re-index
            </button>
        </div>
    );
}

function StatusIndicator({ status }: { status: IndexStatus; }): React.JSX.Element
{
    if (status.state === 'indexing')
    {
        const pct = status.total ? Math.round(((status.done ?? 0) / status.total) * 100) : 0;
        const overall = Math.round((status.overall ?? 0) * 100);
        return (
            <div className="status" title={`${status.phase}: ${pct}%\nTotal${status.steps ? ` (step ${status.step} of ${status.steps})` : ''}: ${overall}%`}>
                {status.phase} ({status.done} / {status.total})
                <div className="progress-stack">
                    <div className="progress">
                        <div style={{ width: pct + '%' }} />
                    </div>
                    <div className="progress total">
                        <div style={{ width: overall + '%' }} />
                    </div>
                </div>
            </div>
        );
    }

    if (status.state === 'error')
        return <div className="status error">Index error</div>;

    if (status.state === 'ready' && status.stats)
    {
        const s = status.stats;
        return (
            <div className="status" title={status.gameDir + (s.cached ? '\nLoaded from the index cache (Settings → Re-index now parses afresh)' : '')}>
                {formatCount(s.files)} files · {formatCount(s.entities)} entries · {formatCount(s.refs)} refs · {(s.ms / 1000).toFixed(1)}s{s.cached ? ' (cached)' : ''}
            </div>
        );
    }

    return <div className="status" />;
}

function SearchBox({ navigate }: { navigate: Navigate; }): React.JSX.Element
{
    const [q, setQ] = useState('');
    const [inText, setInText] = useState(false);
    const [results, setResults] = useState<SearchResult[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const seq = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);
    // "mod content only" is shared with the lists and galleries
    const [modFilter] = useModFilter();
    const [hideRemoved] = useHideRemoved();
    const hasMods = useLoadedMods().length > 0;

    useEffect(() =>
    {
        const onKey = (e: KeyboardEvent): void =>
        {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p'))
            {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
                setOpen(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
            void api.search(q, { limit: 150, text: inText, modOnly: modFilter.on, noRemoved: hideRemoved }).then((r) =>
            {
                if (my === seq.current)
                {
                    setResults(r);
                    setActive(0);
                }
            });
        }, 110);
        return () => clearTimeout(t);
    }, [q, inText, modFilter.on, hideRemoved]);

    useEffect(() =>
    {
        listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const pick = (r: SearchResult): void =>
    {
        navigate({ type: r.type, name: r.name });
        setOpen(false);
        inputRef.current?.blur();
    };

    return (
        <div className="search">
            <span className="icon">⌕</span>
            <input
                ref={inputRef}
                value={q}
                className={hasMods ? 'with-mods' : undefined}
                placeholder={inText ? 'Search names and text…  (Ctrl+K)' : 'Search events, traits, effects, loc keys…  (Ctrl+K)'}
                onChange={(e) =>
                {
                    setQ(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={(e) =>
                {
                    if (e.key === 'ArrowDown')
                    {
                        e.preventDefault();
                        setActive((a) => Math.min(results.length - 1, a + 1));
                    }
                    else if (e.key === 'ArrowUp')
                    {
                        e.preventDefault();
                        setActive((a) => Math.max(0, a - 1));
                    }
                    else if (e.key === 'Enter' && results[active])
                        pick(results[active]);
                    else if (e.key === 'Escape')
                    {
                        setOpen(false);
                        inputRef.current?.blur();
                    }
                }}
            />
            <button
                className={'text-toggle ghost' + (inText ? ' on' : '')}
                title="Also search in display names and localization text"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setInText((v) => !v)}
            >
                Aa text
            </button>
            <ModToggle title="Only entries the loaded mods add, change or remove" />
            {open && q.trim() && (
                <div className="search-results" ref={listRef}>
                    {results.length === 0 && <div className="search-empty">{modFilter.on ? 'No matches in mod content' : 'No matches'}</div>}
                    {results.map((r, i) => (
                        <div
                            key={r.type + '\u0000' + r.name}
                            className={'search-result' + (i === active ? ' active' : '')}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(r)}
                            onMouseEnter={() => setActive(i)}
                        >
                            <TypeChip type={r.type} label={r.typeLabel} />
                            <div className="result-body">
                                {r.icon && <GameImg path={r.icon} size={28} className="result-icon" />}
                                <div style={{ minWidth: 0 }}>
                                    <div className="name-line">
                                        <div className="name">{r.name}</div>
                                        <ModChip touch={r.mod} />
                                    </div>
                                    {(r.match || r.display) && <div className={r.match ? 'match' : 'display'}>{r.match ?? r.display}</div>}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
