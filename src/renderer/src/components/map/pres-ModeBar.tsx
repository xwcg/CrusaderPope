/**
 * The map's mode bar (docs/map.md, "Presentation"): the modes in sections — Political, De jure, Society, Land (and
 * Other for modes it does not know) — each a compact button with the section's current (or last used) mode that
 * opens a menu of its modes. A click on a section's button shows its mode; the ▾ (or a click on the active section)
 * opens its menu. Every mode's button is in the page (`.map-mode`, hidden in closed menus).
 */
import { useEffect, useRef, useState } from 'react';
import type { Mode, ModeDef } from './model';

const SECTIONS: [string, string[]][] = [
    ['Political', ['realm', 'vassal', 'government', 'dynasty', 'house', 'liege', 'council']],
    ['De jure', ['h', 'e', 'k', 'd', 'c', 'b']],
    ['Society', ['culture', 'heritage', 'language', 'ethnicity', 'faith', 'religion', 'religionfamily', 'holysite', 'doctrine']],
    ['Land', ['terrain', 'holding', 'development', 'building', 'specialbuilding', 'region', 'province', 'climate', 'winter']]
];

/** a mode id's section (singular or plural: 'holy_sites' → Society, 'dynasties' → Political) */
function sectionOf(id: Mode): string
{
    const key = id.toLowerCase().replace(/[^a-z]/g, '');
    const is = (k: string): boolean => key === k || key === k + 's' || (k.endsWith('y') && key === k.slice(0, -1) + 'ies');
    return SECTIONS.find(([, ids]) => ids.some(is))?.[0] ?? 'Other';
}

export function ModeBar(props: { modes: ModeDef[]; mode: Mode; onMode: (m: Mode) => void; }): React.JSX.Element
{
    const [open, setOpen] = useState<string | null>(null);
    // each section's last mode
    const last = useRef(new Map<string, Mode>());
    const bar = useRef<HTMLDivElement>(null);
    const sections = [...SECTIONS.map(([s]) => s), 'Other']
        .map((s) => ({ s, modes: props.modes.filter((m) => sectionOf(m.id) === s) }))
        .filter((x) => x.modes.length);
    const active = sectionOf(props.mode);
    last.current.set(active, props.mode);

    // a menu closes on a click elsewhere or Escape
    useEffect(() =>
    {
        if (!open)
            return;

        const away = (e: PointerEvent): void =>
        {
            if (!bar.current?.contains(e.target as Node))
                setOpen(null);
        };
        const key = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                setOpen(null);
        };
        document.addEventListener('pointerdown', away);
        document.addEventListener('keydown', key);
        return () =>
        {
            document.removeEventListener('pointerdown', away);
            document.removeEventListener('keydown', key);
        };
    }, [open]);

    return (
        <div className="map-sections" ref={bar}>
            {sections.map(({ s, modes }) =>
            {
                const shown = modes.find((m) => m.id === (last.current.get(s) ?? '')) ?? modes[0];
                return (
                    <div key={s} className={'map-section' + (s === active ? ' on' : '') + (open === s ? ' open' : '')}>
                        <button
                            className="map-section-chip"
                            title={shown.title ?? shown.label}
                            onClick={() =>
                            {
                                if (s === active && modes.length > 1)
                                    setOpen(open === s ? null : s);
                                else
                                {
                                    props.onMode(shown.id);
                                    setOpen(null);
                                }
                            }}
                        >
                            <small>{s}</small>
                            {shown.label}
                        </button>
                        {modes.length > 1 && (
                            <button className="map-section-more" onClick={() => setOpen(open === s ? null : s)} title={`${s} modes`}>
                                ▾
                            </button>
                        )}
                        <div className="map-section-menu">
                            {modes.map((m) => (
                                <button
                                    key={m.id}
                                    className={'map-mode' + (m.id === props.mode ? ' on' : '')}
                                    title={m.title}
                                    onClick={() =>
                                    {
                                        props.onMode(m.id);
                                        setOpen(null);
                                    }}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
