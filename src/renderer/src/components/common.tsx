import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { EntityKey } from '../../../shared/api';
import { typeColor } from '../typeColors';

export function TypeDot({ type }: { type: string; }): React.JSX.Element
{
    return <span className="type-dot" style={{ background: typeColor(type) }} />;
}

export function TypeChip({ type, label }: { type: string; label: string; }): React.JSX.Element
{
    return (
        <span className="type-chip" title={type}>
            <TypeDot type={type} />
            {label}
        </span>
    );
}

/** Fixed-row-height virtualized list. */
export function VirtualList<T>(props: {
    items: T[];
    rowHeight: number;
    render: (item: T, index: number, style: React.CSSProperties) => ReactNode;
    scrollToIndex?: number;
    /** what makes it another list (scrolled back to the top); default: another `items` array */
    resetKey?: unknown[];
}): React.JSX.Element
{
    const { items, rowHeight, render, scrollToIndex } = props;
    const ref = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(800);

    useLayoutEffect(() =>
    {
        const el = ref.current!;
        const ro = new ResizeObserver(() => setHeight(el.clientHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() =>
    {
        const el = ref.current;

        if (!el || scrollToIndex === undefined || scrollToIndex < 0)
            return;

        const top = scrollToIndex * rowHeight;

        if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight)
            el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }, [scrollToIndex, rowHeight]);

    useEffect(() =>
    {
        // new list → back to top unless we are about to scroll to a selection
        if (ref.current && (scrollToIndex === undefined || scrollToIndex < 0))
            ref.current.scrollTop = 0;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, props.resetKey ?? [items]);

    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
    const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 8);
    const rows: ReactNode[] = [];

    for (let i = start; i < end; i++)
        rows.push(render(items[i], i, { top: i * rowHeight, height: rowHeight }));

    return (
        <div className="vlist" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
        </div>
    );
}

/** Small menu to pick one of several targets (ambiguous references). */
export function TargetMenu(props: {
    x: number;
    y: number;
    targets: EntityKey[];
    onPick: (t: EntityKey) => void;
    onClose: () => void;
}): React.JSX.Element
{
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() =>
    {
        const onDown = (e: MouseEvent): void =>
        {
            if (ref.current && !ref.current.contains(e.target as Node))
                props.onClose();
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                props.onClose();
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [props]);
    const left = Math.min(props.x, window.innerWidth - 260);
    const top = Math.min(props.y + 8, window.innerHeight - 40 - props.targets.length * 44);
    return (
        <div className="popover" ref={ref} style={{ left, top }}>
            {props.targets.map((t) => (
                <div key={t.type + t.name} className="item" onClick={() => props.onPick(t)}>
                    <span className="n">{t.name}</span>
                    <TypeChip type={t.type} label={t.type} />
                </div>
            ))}
        </div>
    );
}

/** A file inside a packed mod has no disk path: `archive.zip › entry` (GameFiles.where). */
const ZIP_SEP = ' › ';

/** Tooltip of an "open in the editor" action: a file inside a zip opens as a read-only copy. */
export function openTitle(path: string, what = 'Open in VS Code'): string
{
    const i = path.indexOf(ZIP_SEP);
    return i < 0 ? what : `${what} — a read-only copy extracted from ${path.slice(0, i)} (edit a mod’s files after unpacking it on the Mods page)`;
}

/** Tooltip of a "show in folder" action: for a file inside a zip, the zip is shown. */
export function revealTitle(path: string, what = 'Show in folder'): string
{
    const i = path.indexOf(ZIP_SEP);
    return i < 0 ? what : `${what} — the file is inside ${path.slice(0, i)}: shows the zip`;
}

export function formatCount(n: number): string
{
    if (n >= 1e6)
        return (n / 1e6).toFixed(1) + 'M';

    if (n >= 1e4)
        return Math.round(n / 1e3) + 'k';

    return String(n);
}
