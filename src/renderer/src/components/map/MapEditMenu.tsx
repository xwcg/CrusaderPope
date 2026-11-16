/**
 * A province's editors at a point of the map (docs/map.md, "Editing from the map"): the rows the side panel can change
 * (its titles (holder, liege, colour), realm, culture, faith, holding, development), each with its value; choosing one
 * opens that row's editor (MapEdit.tsx, MapEditTitle.tsx) in the menu's place. ↑ ↓ choose, Enter opens, Esc closes.
 * The right-click menu itself is the picker's (mapPick.ts); its Colour… opens this with the title's editor (`title`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import { TIER_NAMES, ancestorAt, provinceName } from './model';
import { EDITABLE_LAYERS, MapLayerEdit, useMapEditing } from './MapEdit';
import { MapTitleEdit } from './MapEditTitle';
import '../../styles/edit.css';

import { tr } from '../../../../shared/i18n';
/** A row the menu offers: its label, its value as text, what it changes. */
interface Target
{
    k: string;
    v: string;
    edit: { title: number; } | { layer: string; };
}

/** The province's changeable rows, in the side panel's order. */
function targetsOf(info: MapInfo, p: number): Target[]
{
    const P = info.province;
    const out: Target[] = [];

    for (const tier of ['b', 'c', 'd', 'k', 'e', 'h'] as const)
    {
        const t = ancestorAt(info, p, tier);

        if (t >= 0)
            out.push({ k: TIER_NAMES[tier][0], v: info.titles[t].name, edit: { title: t } });
    }

    if (P.realm[p] >= 0)
        out.push({ k: 'Realm', v: info.titles[P.realm[p]].name, edit: { title: P.realm[p] } });

    for (const l of info.layers)
    {
        // (culture and faith are the county's, the holding its barony's, as in the panel)
        if (!EDITABLE_LAYERS.has(l.id) || (l.id === 'holding' ? P.barony[p] < 0 : ancestorAt(info, p, 'c') < 0))
            continue;

        const v = l.values[p];
        out.push({ k: l.row, v: l.things ? (v >= 0 ? l.things[v].name : tr('none')) : Number.isFinite(v) ? String(Math.round(v * 10) / 10) : tr('none'), edit: { layer: l.id } });
    }

    return out;
}

export function MapEditMenu(props: { info: MapInfo; p: number; x: number; y: number; title?: number; onClose: () => void; onChanged: () => void; }): React.JSX.Element
{
    const { info, p, onClose } = props;
    const editing = useMapEditing();
    const box = useRef<HTMLDivElement>(null);
    const targets = targetsOf(info, p);
    const [at, setAt] = useState(0);
    const [open, setOpen] = useState<Target | null>(() => targets.find((t) => 'title' in t.edit && t.edit.title === props.title) ?? null);
    // (kept inside the window, again when the editor opens and the box grows)
    const [pos, setPos] = useState({ left: props.x, top: props.y });

    useLayoutEffect(() =>
    {
        const r = box.current?.getBoundingClientRect();

        if (r)
            setPos({ left: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)) });
    }, [props.x, props.y, open]);

    useEffect(() =>
    {
        const onDown = (e: MouseEvent): void =>
        {
            if (!box.current?.contains(e.target as Node))
                onClose();
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
            {
                e.preventDefault();
                onClose();
                return;
            }

            // (the list's keys only while it shows: an open editor has its own)
            if (open || !editing.mod)
                return;

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
            {
                e.preventDefault();
                setAt((i) => (i + (e.key === 'ArrowDown' ? 1 : targets.length - 1)) % Math.max(1, targets.length));
            }
            else if (e.key === 'Enter' && targets[at])
            {
                e.preventDefault();
                setOpen(targets[at]);
            }
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose, open, editing.mod, targets, at]);

    const done = (): void =>
    {
        props.onChanged();
        onClose();
    };

    return (
        <div className={'ctx-menu map-menu' + (open ? ' map-menu-edit' : '')} ref={box} style={pos} onContextMenu={(e) => e.preventDefault()}>
            <div className="map-menu-head">
                <b>{provinceName(info, p)}</b>
                {open && (
                    <>
                        {' · '}
                        {open.k}
                    </>
                )}
            </div>
            {!editing.mod && <div className="map-menu-why">{editing.why}</div>}
            {!open && editing.mod && targets.map((t, i) => (
                <button key={t.k} className={'am-item map-menu-item' + (i === at ? ' on' : '')} onMouseEnter={() => setAt(i)} onClick={() => setOpen(t)}>
                    <span className="map-menu-k">{t.k}</span>
                    <span className="map-menu-v">{t.v}</span>
                    <span className="map-menu-pen">✎</span>
                </button>
            ))}
            {open && editing.mod && (
                <div className="map-menu-editor">
                    {'title' in open.edit ?
                        <MapTitleEdit info={info} t={open.edit.title} onDone={done} onClose={onClose} /> :
                        <MapLayerEdit info={info} layer={info.layers.find((l) => l.id === (open.edit as { layer: string; }).layer)!} p={p} onDone={done} onClose={onClose} />}
                </div>
            )}
        </div>
    );
}
