/**
 * The app's dropdown: a button that looks like one and opens a statement-picker menu (styles/picker.css) right below
 * it — the same keys: the row letters pick, typing filters, ↑↓ Home End PageUp PageDown move, ⏎ picks, Esc clears the
 * filter / closes, Backspace edits the filter. A drop-in for <select>: the same `value` / `onChange(e)` (e.target.value,
 * a string) and <option> / <optgroup> children.
 */
import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/picker.css';

interface Opt
{
    value: string;
    label: React.ReactNode;
    /** the label as text (filtering, mnemonics) */
    text: string;
    title?: string;
    disabled?: boolean;
    /** an optgroup's heading */
    group?: boolean;
}

type Props = {
    value?: string | number;
    onChange?: (e: { target: { value: string; }; }) => void;
    children?: React.ReactNode;
    className?: string;
    title?: string;
    disabled?: boolean;
    style?: React.CSSProperties;
    /** the menu's title (default: aria-label or title) */
    label?: string;
    'aria-label'?: string;
};

function textOf(n: React.ReactNode): string
{
    if (n === null || n === undefined || typeof n === 'boolean')
        return '';

    if (typeof n === 'string' || typeof n === 'number')
        return String(n);

    if (Array.isArray(n))
        return n.map(textOf).join('');

    return isValidElement<{ children?: React.ReactNode; }>(n) ? textOf(n.props.children) : '';
}

function optionsOf(children: React.ReactNode, out: Opt[] = []): Opt[]
{
    Children.forEach(children, (c) =>
    {
        if (!isValidElement<{ value?: string | number; children?: React.ReactNode; title?: string; disabled?: boolean; label?: string; }>(c))
            return;

        if (c.type === 'optgroup')
        {
            out.push({ value: '', label: c.props.label, text: c.props.label ?? '', group: true, disabled: true });
            optionsOf(c.props.children, out);
        }
        else if (c.type === 'option')
        {
            const text = textOf(c.props.children);
            out.push({ value: String(c.props.value ?? text), label: c.props.children, text, title: c.props.title, disabled: c.props.disabled });
        }
        else if (c.type === Fragment)
            optionsOf(c.props.children, out);
    });
    return out;
}

/** Mnemonics as in the picker: the first free initial of a label's words, then any free letter or digit. */
function mnemonics(opts: Opt[]): Map<Opt, string>
{
    const used = new Set<string>();
    const out = new Map<Opt, string>();

    for (const o of opts)
    {
        if (o.group || o.disabled)
            continue;

        const l = o.text.toLowerCase();
        const cands = [
            ...l.split(/[^a-z0-9]+/)
                .filter(Boolean)
                .map((w) => w[0]),
            ...l.replace(/[^a-z0-9]/g, '')
        ];
        const k = cands.find((c) => !used.has(c));

        if (k)
        {
            used.add(k);
            out.set(o, k);
        }
    }

    return out;
}

const selectable = (o: Opt | undefined): boolean => !!o && !o.group && !o.disabled;

export function Select(props: Props): React.JSX.Element
{
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState('');
    const [sel, setSel] = useState(-1);
    const [at, setAt] = useState<{ left: number; top: number; width: number; maxHeight: number; } | null>(null);
    const btn = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const pointer = useRef<{ x: number; y: number; } | null>(null);

    const all = optionsOf(props.children);
    const value = props.value === undefined ? undefined : String(props.value);
    const current = all.find((o) => !o.group && o.value === value);
    const f = filter.trim().toLowerCase();
    // (filtering: the matches, words starting with the filter first; headings go)
    const rows = f
        ? all
            .filter((o) => !o.group && o.text.toLowerCase().includes(f))
            .sort((a, b) =>
                Number(
                    !a.text.toLowerCase()
                        .split(/\W+/)
                        .some((w) => w.startsWith(f))
                ) - Number(
                    !b.text.toLowerCase()
                        .split(/\W+/)
                        .some((w) => w.startsWith(f))
                )
            )
        : all;
    const keys = f ? new Map<Opt, string>() : mnemonics(rows);

    const close = (focus = true): void =>
    {
        setOpen(false);
        setFilter('');

        if (focus)
            btn.current?.focus();
    };
    const pick = (o: Opt | undefined): void =>
    {
        if (!selectable(o))
            return;

        close();

        if (o!.value !== value)
            props.onChange?.({ target: { value: o!.value } });
    };
    const openMenu = (): void =>
    {
        if (props.disabled)
            return;

        setFilter('');
        setSel(Math.max(0, all.findIndex((o) => o === current && selectable(o))));
        setOpen(true);
    };

    // placed below the button (above when there is no room), inside the window
    useLayoutEffect(() =>
    {
        const b = btn.current?.getBoundingClientRect();
        const m = menu.current;

        if (!open || !b || !m)
            return;

        // (as wide as its longest row, at least the button)
        const width = Math.max(b.width, 200);
        const left = Math.max(8, Math.min(b.left, window.innerWidth - m.offsetWidth - 8));
        const h = m.offsetHeight;
        const below = window.innerHeight - b.bottom - 12;
        const above = b.top - 12;
        const up = h > below && above > below;
        const maxHeight = Math.max(120, up ? above : below);
        const top = up ? Math.max(8, b.top - 4 - Math.min(h, maxHeight)) : b.bottom + 4;
        setAt((o) => (o && o.left === left && o.top === top && o.width === width && o.maxHeight === maxHeight ? o : { left, top, width, maxHeight }));
    });

    // the selected row stays in view
    useEffect(() =>
    {
        menu.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [sel, open, filter]);

    // closed by a click or scroll elsewhere, or when the window loses focus
    useEffect(() =>
    {
        if (!open)
            return;

        const onDown = (e: MouseEvent): void =>
        {
            if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node))
                close(false);
        };
        const onScroll = (e: Event): void =>
        {
            if (!menu.current?.contains(e.target as Node))
                close(false);
        };
        const onBlur = (): void => close(false);
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('blur', onBlur);
        return () =>
        {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('blur', onBlur);
            setAt(null);
        };
    }, [open]);

    const firstIn = (list: Opt[]): number => Math.max(0, list.findIndex(selectable));
    const setFilterTo = (next: string): void =>
    {
        setFilter(next);
        const t = next.trim().toLowerCase();
        setSel(t ? 0 : firstIn(all));
    };

    // (keys go to the open menu first — nothing behind it reacts)
    useEffect(() =>
    {
        if (!open)
            return;

        const onKey = (e: KeyboardEvent): void =>
        {
            const k = e.key;
            const move = (d: number): void =>
            {
                if (!rows.length)
                    return;

                let i = sel < 0 ? (d > 0 ? -1 : 0) : sel;

                for (let n = 0; n < rows.length; n++)
                {
                    i = (i + d + rows.length) % rows.length;

                    if (selectable(rows[i]))
                        break;
                }

                setSel(i);
            };

            if (k === 'Tab')
            {
                close(false);
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (k === 'Escape')
                filter ? setFilterTo('') : close();
            else if (k === 'Enter')
                pick(rows[sel]);
            else if (k === 'ArrowDown')
                move(1);
            else if (k === 'ArrowUp')
                move(-1);
            else if (k === 'PageDown')
                setSel(Math.min(rows.length - 1, sel + 10));
            else if (k === 'PageUp')
                setSel(Math.max(0, sel - 10));
            else if (k === 'Home')
                setSel(firstIn(rows));
            else if (k === 'End')
                setSel(rows.length - 1);
            else if (k === 'Backspace')
                setFilterTo(filter.slice(0, -1));
            else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey)
            {
                const hit = !filter && k !== ' ' ? rows.find((o) => keys.get(o) === k.toLowerCase()) : undefined;

                if (hit)
                    pick(hit);
                else if (k !== ' ' || filter)
                    setFilterTo(filter + k);
                else
                    setFilterTo(' ');
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    });

    const title = props.label ?? props['aria-label'] ?? props.title;
    return (
        <>
            <button
                ref={btn}
                type="button"
                className={'dd-btn' + (open ? ' open' : '') + (props.className ? ' ' + props.className : '')}
                title={props.title}
                style={props.style}
                disabled={props.disabled}
                aria-label={props['aria-label']}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => (open ? close() : openMenu())}
                onKeyDown={(e) =>
                {
                    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
                    {
                        e.preventDefault();
                        openMenu();
                    }
                }}
            >
                <span className="dd-value">{current ? current.label : value}</span>
                <span className="dd-caret" aria-hidden />
            </button>
            {open &&
                createPortal(
                    <div
                        ref={menu}
                        className="pk-menu top dd-menu"
                        role="listbox"
                        style={at ? { left: at.left, top: at.top, minWidth: at.width, maxHeight: at.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        {title && <div className="pk-title">{title}</div>}
                        {filter && (
                            <div className="pk-filter">
                                <span className="pk-filter-icon">⌕</span>
                                {filter}
                                <span className="pk-caret" />
                            </div>
                        )}
                        <div className="pk-rows">
                            {rows.length === 0 && <div className="pk-empty">Nothing matches</div>}
                            {rows.map((o, i) =>
                                o.group ?
                                    (
                                        <div key={i} className="pk-row info dd-group">
                                            <span className="pk-label">{o.label}</span>
                                        </div>
                                    ) :
                                    (
                                        <div
                                            key={i}
                                            data-row={i}
                                            data-value={o.value}
                                            role="option"
                                            aria-selected={o === current}
                                            className={'pk-row' + (i === sel ? ' sel' : '') + (o.disabled ? ' info' : '') + (o === current ? ' dd-current' : '')}
                                            title={o.title}
                                            onMouseMove={(e) =>
                                            {
                                                const last = pointer.current;
                                                pointer.current = { x: e.screenX, y: e.screenY };

                                                if (last && (last.x !== e.screenX || last.y !== e.screenY) && sel !== i && selectable(o))
                                                    setSel(i);
                                            }}
                                            onClick={() => pick(o)}
                                        >
                                            <span className="pk-key">{keys.get(o)?.toUpperCase() ?? ''}</span>
                                            <span className="pk-label">{o.label}</span>
                                            <span className="pk-arrow">{o === current ? '✓' : ''}</span>
                                        </div>
                                    )
                            )}
                        </div>
                    </div>,
                    document.body
                )}
        </>
    );
}
