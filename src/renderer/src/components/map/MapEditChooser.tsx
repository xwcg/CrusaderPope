/** The list the map panel's editors choose from (MapEdit.tsx): cultures, faiths, holdings, characters, titles. */
import { useEffect, useMemo, useRef, useState } from 'react';

/** One entry to choose: a culture, faith, holding, character, title — or "none". */
export interface Choice
{
    key: string;
    name: string;
    color?: string;
    /** smaller text after the name (a tier, "age 36", "not alive then") */
    hint?: string;
    /** a second line (a character's life, culture, titles and id) */
    sub?: string;
    /** shown dimmer (a character not alive at the map's date, a title without holder) */
    dim?: boolean;
}

const MAX_SHOWN = 200;

/** Static choices filtered by words: exact name or key first, then prefix, then contains; list order within. */
function filterChoices(list: Choice[], q: string): Choice[]
{
    const s = q.trim().toLowerCase();

    if (!s)
        return list;

    const scored: [Choice, number][] = [];

    for (const c of list)
    {
        const n = c.name.toLowerCase();
        const k = c.key.toLowerCase();
        const score = n === s || k === s ? 0 : n.startsWith(s) || k.startsWith(s) ? 1 : n.includes(s) || k.includes(s) ? 2 : -1;

        if (score >= 0)
            scored.push([c, score]);
    }

    return scored.sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/**
 * A filterable list: type to filter (`choices`) or to search (`search`, e.g. the index's characters), ↑ ↓ move,
 * Enter chooses, Esc cancels. `fixed` entries ("No holder") come first; the current value is marked.
 */
export function MapEditChooser(props: {
    choices?: Choice[];
    search?: (q: string) => Promise<Choice[]>;
    fixed?: Choice[];
    current?: string;
    placeholder: string;
    busy?: boolean;
    onPick: (c: Choice) => void;
    onCancel: () => void;
}): React.JSX.Element
{
    const [q, setQ] = useState('');
    const [found, setFound] = useState<Choice[] | null>(null);
    const [hi, setHi] = useState(0);
    const list = useRef<HTMLDivElement>(null);
    const { search } = props;

    // searching (debounced; the last query wins)
    useEffect(() =>
    {
        if (!search)
            return;

        if (!q.trim())
            return setFound(null);

        let live = true;
        const t = setTimeout(() =>
        {
            void search(q).then((r) => live && setFound(r));
        }, 150);
        return () =>
        {
            live = false;
            clearTimeout(t);
        };
    }, [q, search]);

    const shown = useMemo(() =>
    {
        const fixed = filterChoices(props.fixed ?? [], q);
        const rest = search ? (found ?? []) : filterChoices(props.choices ?? [], q);
        return [...fixed, ...rest].slice(0, MAX_SHOWN);
    }, [props.fixed, props.choices, search, found, q]);

    useEffect(() => setHi(0), [shown]);
    useEffect(() =>
    {
        list.current?.querySelector('.map-edit-item.hi')?.scrollIntoView({ block: 'nearest' });
    }, [hi]);

    const onKey = (e: React.KeyboardEvent): void =>
    {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        {
            e.preventDefault();
            setHi((h) => Math.max(0, Math.min(shown.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))));
        }
        else if (e.key === 'Enter')
        {
            e.preventDefault();

            if (shown[hi] && !props.busy)
                props.onPick(shown[hi]);
        }
        else if (e.key === 'Escape')
        {
            e.preventDefault();
            props.onCancel();
        }
    };

    return (
        <div className="map-edit-chooser">
            <input autoFocus value={q} placeholder={props.placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} disabled={props.busy} />
            <div className="map-edit-list" ref={list}>
                {shown.map((c, i) => (
                    <button
                        key={c.key}
                        className={'map-edit-item' + (i === hi ? ' hi' : '') + (c.key === props.current ? ' cur' : '') + (c.dim ? ' dim' : '')}
                        disabled={props.busy}
                        onMouseEnter={() => setHi(i)}
                        onClick={() => props.onPick(c)}
                        title={c.key}
                    >
                        {c.color !== undefined && <span className="map-edit-swatch" style={{ background: c.color }} />}
                        <span className="map-edit-body">
                            <span className="map-edit-line">
                                <span className="map-edit-name">{c.name}</span>
                                {c.hint && <span className="map-edit-hint">{c.hint}</span>}
                                {c.key === props.current && <span className="map-edit-now">now</span>}
                            </span>
                            {c.sub && <span className="map-edit-sub">{c.sub}</span>}
                        </span>
                    </button>
                ))}
                {!shown.length && <div className="map-edit-empty">{search && !q.trim() ? 'Type a name, house or id to search' : search && found === null ? 'Searching…' : 'Nothing matches'}</div>}
            </div>
        </div>
    );
}
