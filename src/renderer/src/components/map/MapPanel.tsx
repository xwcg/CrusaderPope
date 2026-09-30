/**
 * The map's hover tooltip and side panel (docs/map.md): a province, its titles, realm and layers, with links — and ✎
 * on the rows the map can change in the active mod (MapEdit.tsx).
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import type { Navigate } from '../../App';
import { TIER_NAMES, ancestorAt, provinceName, type Groups, type Mode } from './model';
import { CoatOfArms } from '../CoatOfArms';
import { EDITABLE_LAYERS, MapEditHint, MapLayerEdit, useMapEditing } from './MapEdit';
import { MapTitleEdit } from './MapEditTitle';

export function MapTooltip(props: { info: MapInfo; groups: Groups; mode: Mode; p: number; x: number; y: number; }): React.JSX.Element
{
    const { info, groups, p } = props;
    const P = info.province;
    const kind = info.kinds[P.kind[p]];
    const g = groups.of[p];
    const county = ancestorAt(info, p, 'c');
    const realm = P.realm[p];
    return (
        <div className="map-tip" style={{ left: props.x + 16, top: props.y + 12 }}>
            <b>{provinceName(info, p)}</b>
            {kind !== 'land' && <span className="map-tip-kind">· {kind.replace('_', ' ')}</span>}
            {county >= 0 && county !== P.barony[p] && <div>{info.titles[county].name}</div>}
            {g >= 0 && props.mode !== 'c' && props.mode !== 'b' && <div className="map-tip-group">{groups.name(g)}</div>}
            {props.mode !== 'realm' && realm >= 0 && <div className="map-tip-dim">Realm: {info.titles[realm].name}</div>}
        </div>
    );
}

/** A row of the panel; `edit`: what its ✎ changes — a title (index) or a layer of the province. */
interface Row
{
    /** the label (unique: it names the open editor) */
    k: string;
    v: React.ReactNode;
    edit?: { title: number; } | { layer: string; };
}

/**
 * The selected province: its group in the mode (with a link and "Zoom to it"), then its titles, realm and holder and
 * every layer's value. `onChanged`: the map's data changed (an edit) — read it again.
 */
export function MapPanel(props: { info: MapInfo; groups: Groups; mode: Mode; sel: number; navigate: Navigate; onClose: () => void; onZoom: () => void; onChanged: () => void; }): React.JSX.Element
{
    const { info, groups, sel: p, navigate } = props;
    const P = info.province;
    const editing = useMapEditing();
    // the row whose editor is open (another province closes it)
    const [open, setOpen] = useState<string | null>(null);
    useEffect(() => setOpen(null), [p]);
    const link = (type: string | undefined, key: string, text: string): React.ReactNode =>
        type ?
            (
                <a className="map-link" onClick={() => navigate({ type, name: key })}>
                    {text}
                </a>
            ) :
            text;
    // (a realm is shown with its banner: the government's shape, the tier's bar)
    const title = (t: number, kind: 'title' | 'realm' = 'title'): React.ReactNode =>
        t >= 0 ?
            (
                <>
                    <CoatOfArms kind={kind} name={info.titles[t].key} size={18} className="map-coa-row" date={info.date} />
                    {link('landed_titles', info.titles[t].key, info.titles[t].name)}
                </>
            ) :
            (
                '—'
            );
    // a holder: name and house, age, culture and faith at the date
    const holderOf = (h: NonNullable<MapInfo['titles'][number]['holder']>): React.ReactNode => (
        <>
            {link('characters', h.id, h.house ? `${h.name} ${h.house}` : h.name)}
            {h.age !== undefined && `, ${h.age}`}
            {h.culture && <>· {link('culture/cultures', h.culture.key, h.culture.name)}</>}
            {h.faith && <>· {link('faith', h.faith.key, h.faith.name)}</>}
        </>
    );
    const realm = P.realm[p];
    const holder = realm >= 0 ? info.titles[realm].holder : undefined;
    const g = groups.of[p];
    const gl = g >= 0 ? groups.link(g) : undefined;
    const counties = useMemo(() =>
    {
        if (g < 0)
            return 0;

        const set = new Set<number>();

        for (let q = 0; q < info.count; q++)
            if (groups.of[q] === g)
                set.add(ancestorAt(info, q, 'c'));

        set.delete(-1);
        return set.size;
    }, [g, groups, info]);
    // (culture and faith are the county's, the holding its barony's)
    const layerEditable = (id: string): boolean => EDITABLE_LAYERS.has(id) && (id === 'holding' ? P.barony[p] >= 0 : ancestorAt(info, p, 'c') >= 0);
    const rows: Row[] = [
        ...(['b', 'c', 'd', 'k', 'e', 'h'] as const)
            .filter((t) => info.titles.some((x) => x.tier === t))
            .map((tier): Row =>
            {
                const t = ancestorAt(info, p, tier);
                return { k: TIER_NAMES[tier][0], v: title(t), edit: t >= 0 ? { title: t } : undefined };
            }),
        {
            k: 'Realm',
            v: realm >= 0 ?
                (
                    <>
                        {title(realm, 'realm')}
                        {holder && <span className="map-dim">· {link('characters', holder.id, holder.name)}</span>}
                    </>
                ) :
                (
                    '—'
                ),
            edit: realm >= 0 ? { title: realm } : undefined
        },
        ...info.layers.map((l): Row =>
        {
            const v = l.values[p];
            const edit = layerEditable(l.id) ? { layer: l.id } : undefined;

            if (l.things)
                return { k: l.row, v: v >= 0 ? link(l.things[v].type, l.things[v].key, l.things[v].name) : '—', edit };

            return { k: l.row, v: Number.isFinite(v) ? `${Math.round(v * 10) / 10}${l.scale?.unit ? ' ' + l.scale.unit : ''}` : '—', edit };
        })
    ];
    return (
        <aside className="map-panel">
            <button className="map-close ghost" onClick={props.onClose} title="Close">
                ×
            </button>
            {g >= 0 && (
                <div className="map-panel-group">
                    {gl?.type === 'landed_titles' && <CoatOfArms kind={props.mode === 'realm' || props.mode === 'vassal' ? 'realm' : 'title'} name={gl.name} size={60} className="map-coa" date={info.date} />}
                    <span className="map-swatch" style={{ background: groups.color(g) }} />
                    <h2>{gl ? link(gl.type, gl.name, groups.name(g)) : groups.name(g)}</h2>
                    {(props.mode === 'realm' || props.mode === 'vassal') && info.titles[g].baseName && <div className="map-dim">{info.titles[g].baseName}</div>}
                    {groups.note(g) && <div className="map-dim">{groups.note(g)}</div>}
                    <div className="map-dim">
                        {counties} {counties === 1 ? 'county' : 'counties'}
                        {(props.mode === 'realm' || props.mode === 'vassal') && info.titles[g].holder && <>· {holderOf(info.titles[g].holder!)}</>}
                        {props.mode === 'vassal' && info.titles[g].liege !== undefined && <>· under {title(info.titles[g].liege!)}</>}
                    </div>
                    <button className="map-zoom" onClick={props.onZoom}>
                        Zoom to it
                    </button>
                </div>
            )}
            <h3>{provinceName(info, p)}</h3>
            <div className="map-dim">
                Province {p}
                {P.name[p] ? ` · ${P.name[p]}` : ''} · {info.kinds[P.kind[p]].replace('_', ' ')}
            </div>
            <table className="map-rows">
                <tbody>
                    {rows.map((r) =>
                    {
                        const on = open === r.k;
                        const done = (): void =>
                        {
                            setOpen(null);
                            props.onChanged();
                        };
                        return (
                            <Fragment key={r.k}>
                                <tr className={on ? 'map-edit-open' : undefined}>
                                    <th>{r.k}</th>
                                    <td>
                                        {r.v}
                                        {r.edit && (
                                            <button
                                                className={'map-edit-btn ghost' + (on ? ' on' : '')}
                                                disabled={!editing.mod}
                                                title={editing.mod ? `Change it in ${editing.mod}` : editing.why}
                                                onClick={() => setOpen(on ? null : r.k)}
                                            >
                                                ✎
                                            </button>
                                        )}
                                    </td>
                                </tr>
                                {on && r.edit && editing.mod && (
                                    <tr className="map-edit-row">
                                        <td colSpan={2}>
                                            {'title' in r.edit ?
                                                <MapTitleEdit key={r.edit.title} info={info} t={r.edit.title} onDone={done} onClose={() => setOpen(null)} /> :
                                                <MapLayerEdit info={info} layer={info.layers.find((l) => l.id === (r.edit as { layer: string; }).layer)!} p={p} onDone={done} onClose={() => setOpen(null)} />}
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
            <MapEditHint date={info.date} navigate={navigate} />
        </aside>
    );
}
