/**
 * The map's history date (docs/map.md, "History and realms"): the bookmarks' start dates as shortcuts, a year slider
 * over the history's range (ticks at the bookmarks) and a date entry (y.m.d). Scrubbing asks for one map at a time:
 * while one is on its way, the latest date wanted waits and goes next.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapInfo } from '../../../../shared/api';
import '../../styles/map-date.css';
import { Select } from '../Select';

import { Slider } from '../Slider';
import { tr } from '../../../../shared/i18n';
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
/** y.m.d dates in order */
const cmpDate = (a: string, b: string): number =>
{
    const [x, y] = [a, b].map((d) => d.split('.').map(Number));

    for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) - (y[i] ?? 0);

    return 0;
};

/** the slider thumb's half width: where its travel starts and ends inside the slider (the ticks line up with it) */
const TICK_INSET = 8;

/** a map asked for that has not come within this time is given up (an error): the next can go */
const GIVE_UP = 3000;

/** @param historical the mode is read at the date (else the control is dimmed) */
export function DateControl(props: { info: MapInfo; historical: boolean; onDate: (date: string) => void; onNewBookmark?: (date: string) => void; }): React.JSX.Element
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
    // before the first bookmark the game's history is thin: many counties get their first holder only at it (vanilla:
    // 1,184 of 4,697 on 867.1.1) and show unheld before: the map reads the files right, the files have nothing earlier
    const firstMark = [...info.dates].sort((a, b) => cmpDate(a.date, b.date))[0];
    const early = !!firstMark && cmpDate(current, firstMark.date) < 0;
    const commit = (): void =>
    {
        const d = parseDate(text);

        if (d)
            want(d);
        else
            setBad(true);
    };

    return (
        <div className={'map-date' + (props.historical ? '' : ' idle') + (draft ? ' pending' : '')} title={tr('Holders, realms, names, cultures, faiths and holdings are read from the history at this date')}>
            <span>{tr('At')}</span>
            <Select
                value={bookmark ? bookmark.date : ''}
                onChange={(e) => e.target.value && want(e.target.value)}
                title={tr('The bookmarks\' start dates')}
                // (a fixed width: at a bookmark's date it shows its name; growing and shrinking, it moved the slider beside it)
                style={{ width: 190, minWidth: 190, maxWidth: 190 }}
            >
                {!bookmark && <option value="">{tr('Bookmarks…')}</option>}
                {info.dates.map((d) => (
                    <option key={d.date} value={d.date}>
                        {d.date} ({d.label})
                    </option>
                ))}
            </Select>
            {
                /* (the bookmarks' ticks drawn here, not as the slider's datalist: Chromium snaps a slider to its datalist's
                values; dragging past a bookmark, the thumb jumped to it) */
            }
            <span className="map-date-track">
                <Slider
                    className="map-date-slider"
                    min={from}
                    max={to}
                    step={1}
                    value={year}
                    onChange={(v) => want(`${v}.1.1`)}
                    defaultValue={info.dates[0] ? yearOf(info.dates[0].date) : undefined}
                    defaultLabel={info.dates[0] ? `${info.dates[0].date} (${info.dates[0].label})` : undefined}
                    onReset={info.dates[0] ? () => want(info.dates[0].date) : undefined}
                    title={tr('Year ({from}–{to}): the first of January — ← → a year', { from, to })}
                />
                {to > from && info.dates.map((d) => (
                    <span
                        key={d.date}
                        className={'map-date-tick' + (d.date === current ? ' on' : '')}
                        style={{ left: `calc(${TICK_INSET}px + (100% - ${2 * TICK_INSET}px) * ${(yearOf(d.date) - from) / (to - from)})` }}
                        title={`${d.date} (${d.label})`}
                        onClick={() => want(d.date)}
                    />
                ))}
            </span>
            {props.onNewBookmark && (
                <button className="map-date-new" onClick={() => props.onNewBookmark!(current)} title={tr('A new bookmark starting {current} in the active mod — its card opens: name, description, characters', { current })}>
                    ＋
                </button>
            )}
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
                title={tr('A date (year.month.day) — Enter')}
            />
            {early && (
                <span className="map-date-early" title={tr('Before the first bookmark ({date}) the game\'s history is incomplete: many counties get their first holder only at a bookmark and are shown unheld before it — the files have nothing earlier for them.', { date: firstMark.date })}>
                    {tr('history incomplete')}</span>
            )}
        </div>
    );
}
