/**
 * The map mode's legend (docs/map.md, "Presentation"): its groups with their colours and share of the land, the
 * biggest first, with a filter; a numeric layer's colour bar with its bands. A click on a group selects it. Folds away
 * (remembered in the browser).
 */
import { useMemo, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import { WATER, modesOf, type Groups, type Mode } from './model';

/** rows drawn at most (the filter finds the rest) */
const ROWS = 150;
const OPEN_KEY = 'map.legend.open';

function remembered(): boolean
{
    try
    {
        return localStorage.getItem(OPEN_KEY) !== '0';
    }
    catch
    {
        return true;
    }
}

function share(area: number, land: number): string
{
    const p = (area / land) * 100;
    return p >= 10 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : '<0.1%';
}

/** @param onHover a row under the pointer (its group highlighted on the map), null: none */
export function Legend(props: { info: MapInfo; groups: Groups; mode: Mode; onPick: (g: number) => void; onHover?: (g: number | null) => void; }): React.JSX.Element | null
{
    const { info, groups } = props;
    const [open, setOpen] = useState(remembered);
    // (the filter is the mode's: another mode starts without one)
    const [typed, setFilter] = useState({ mode: props.mode, q: '' });
    const filter = typed.mode === props.mode ? typed.q : '';
    const label = modesOf(info).find((m) => m.id === props.mode)?.label ?? '';
    // the land's area (water left out unless the mode colours it)
    const land = useMemo(() =>
    {
        let a = 0;

        for (let p = 0; p < info.count; p++)
            if (groups.of[p] >= 0 || !WATER.has(info.kinds[info.province.kind[p]]))
                a += info.province.area[p];

        return a || 1;
    }, [info, groups]);
    const scale = groups.layer?.scale;
    const rows = useMemo(() =>
    {
        const q = filter.trim().toLowerCase();
        // (a scale's bands in their order, low to high)
        const all = scale ? groups.bySize.slice().sort((a, b) => a - b) : groups.bySize;
        return q ?
            all.filter((g) =>
                groups.name(g)
                    .toLowerCase()
                    .includes(q)
            ) :
            all;
    }, [groups, filter, scale]);

    const toggle = (): void =>
    {
        setOpen(!open);

        try
        {
            localStorage.setItem(OPEN_KEY, open ? '0' : '1');
        }
        catch
        {
            // (no storage: open again next time)
        }
    };

    if (!groups.bySize.length)
        return null;

    if (!open)
        return (
            <button className="map-legend-fold" onClick={toggle} title="Show the legend">
                {label} ▴
            </button>
        );

    return (
        <div className="map-legend">
            <div className="map-legend-head">
                <b>{label}</b>
                <span className="map-dim">
                    {groups.bySize.length} {scale ? 'bands' : 'on the map'}
                </span>
                <button className="map-legend-close ghost" onClick={toggle} title="Hide the legend">
                    ▾
                </button>
            </div>
            {scale && (
                <div className="map-legend-scale">
                    <div className="map-legend-bar">
                        {scale.colors.map((c, i) => <span key={i} style={{ background: c }} title={groups.name(i)} onClick={() => groups.area[i] && props.onPick(i)} />)}
                    </div>
                    <div className="map-legend-ends">
                        <span>
                            {Math.round(scale.min)}
                            {scale.unit ? ' ' + scale.unit : ''}
                        </span>
                        <span>
                            {Math.round(scale.max)}
                            {scale.unit ? ' ' + scale.unit : ''}
                        </span>
                    </div>
                </div>
            )}
            {groups.bySize.length > 12 && !scale && <input className="map-legend-filter" value={filter} onChange={(e) => setFilter({ mode: props.mode, q: e.target.value })} placeholder={`Filter ${label.toLowerCase()}…`} />}
            <div className="map-legend-rows">
                {rows.slice(0, ROWS).map((g) => (
                    <div key={g} className="map-legend-row" onClick={() => props.onPick(g)} onMouseEnter={() => props.onHover?.(g)} onMouseLeave={() => props.onHover?.(null)} title={`${groups.name(g)} — ${share(groups.area[g], land)} of the land`}>
                        <span className="map-legend-swatch" style={{ background: groups.color(g) }} />
                        <span className="map-legend-name">{groups.name(g)}</span>
                        <span className="map-legend-share">{share(groups.area[g], land)}</span>
                    </div>
                ))}
                {rows.length > ROWS && <div className="map-legend-more map-dim">… {rows.length - ROWS} more (filter to find them)</div>}
                {!rows.length && <div className="map-legend-more map-dim">Nothing by that name</div>}
            </div>
        </div>
    );
}
