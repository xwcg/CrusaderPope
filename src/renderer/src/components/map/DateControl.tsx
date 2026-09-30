/**
 * The map's history date (docs/map.md, "History and realms"): the bookmarks' start dates as shortcuts, a year slider
 * over the history's range (ticks at the bookmarks) and a date entry (y.m.d). Scrubbing asks for one map at a time:
 * while one is on its way, the latest date wanted waits and goes next.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import '../../styles/map-date.css';

/** y, y.m or y.m.d → y.m.d (month 1–12, day 1–31), else null */
function parseDate(s: string): string | null
{
    const m = /^\s*(\d{1,5})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?\s*$/.exec(s);

    if (!m)
        return null;

    const [y, mo = 1, d = 1] = [m[1], m[2], m[3]].map((x) => (x === undefined ? undefined : Number(x))) as number[];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}.${mo}.${d}` : null;
}

const yearOf = (d: string): number => Number(d.split('.')[0]);

/** a map asked for that has not come within this time is given up (an error): the next can go */
const GIVE_UP = 3000;

/** @param historical the mode is read at the date (else the control is dimmed) */
export function DateControl(props: { info: MapInfo; historical: boolean; onDate: (date: string) => void; }): React.JSX.Element
{
    const { info, onDate } = props;
    // the date asked for and not shown yet (the slider and entry show it meanwhile)
    const [draft, setDraft] = useState<string | null>(null);
    const [text, setText] = useState(info.date);
    const [bad, setBad] = useState(false);
    const asked = useRef<{ date: string; at: number; } | null>(null);
    const next = useRef<string | null>(null);
    const shown = useRef(info.date);
    shown.current = info.date;

    const send = useCallback(
        (d: string) =>
        {
            if (asked.current && performance.now() - asked.current.at < GIVE_UP)
            {
                next.current = d;
                return;
            }

            next.current = null;

            if (d === shown.current)
            {
                asked.current = null;
                setDraft(null);
                return;
            }

            asked.current = { date: d, at: performance.now() };
            onDate(d);
        },
        [onDate]
    );

    // a map came: the latest date wanted meanwhile goes next
    useEffect(() =>
    {
        asked.current = null;
        setText(info.date);
        setBad(false);
        const want = next.current;

        if (want && want !== info.date)
            send(want);
        else
        {
            next.current = null;
            setDraft(null);
        }
    }, [info, send]);

    const want = (d: string): void =>
    {
        setDraft(d);
        setText(d);
        setBad(false);
        send(d);
    };
    const current = draft ?? info.date;
    const { from, to } = info.range;
    const year = Math.min(to, Math.max(from, yearOf(current)));
    const bookmark = info.dates.find((d) => d.date === current);
    const commit = (): void =>
    {
        const d = parseDate(text);

        if (d)
            want(d);
        else
            setBad(true);
    };

    return (
        <div className={'map-date' + (props.historical ? '' : ' idle') + (draft ? ' pending' : '')} title="Holders, realms, names, cultures, faiths and holdings are read from the history at this date">
            <span>At</span>
            <select value={bookmark ? bookmark.date : ''} onChange={(e) => e.target.value && want(e.target.value)} title="The bookmarks' start dates">
                {!bookmark && <option value="">Bookmarks…</option>}
                {info.dates.map((d) => (
                    <option key={d.date} value={d.date}>
                        {d.date} — {d.label}
                    </option>
                ))}
            </select>
            <input
                className="map-date-slider"
                type="range"
                min={from}
                max={to}
                step={1}
                value={year}
                list="map-date-ticks"
                onChange={(e) => want(`${e.target.value}.1.1`)}
                title={`Year (${from}–${to}): the first of January — ← → a year`}
            />
            <datalist id="map-date-ticks">
                {info.dates.map((d) => <option key={d.date} value={yearOf(d.date)} />)}
            </datalist>
            <input
                className={'map-date-entry' + (bad ? ' bad' : '')}
                value={text}
                spellCheck={false}
                onChange={(e) =>
                {
                    setText(e.target.value);
                    setBad(false);
                }}
                onKeyDown={(e) =>
                {
                    if (e.key === 'Enter')
                        commit();
                    else if (e.key === 'Escape')
                        setText(current);
                }}
                onBlur={() => text !== current && commit()}
                title="A date (year.month.day) — Enter"
            />
        </div>
    );
}
