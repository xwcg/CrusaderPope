/**
 * A historical character at the preview date (docs/app-architecture.md, "Views that remember"): the date (the map's,
 * viewState.ts): changed here, the map shows it too, and back, with the bookmarks as shortcuts, a year back or on, a
 * date typed; and the character then: age, alive or not, culture. The portrait shows them at that date.
 */
import { useEffect, useState } from 'react';
import type { MapCharacter } from '../../../shared/api';
import { tr } from '../../../shared/i18n';
import { api } from '../api';
import { setPreviewDate, usePreviewDate } from '../viewState';
import { bookmarkDates } from './map/mapLoad';
import { Select } from './Select';

/** y, y.m or y.m.d → y.m.d, else null */
function parseDate(s: string): string | null
{
    const m = /^\s*(\d{1,5})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?\s*$/.exec(s);

    if (!m)
        return null;

    const [y, mo = 1, d = 1] = [m[1], m[2], m[3]].map((x) => (x === undefined ? undefined : Number(x))) as number[];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}.${mo}.${d}` : null;
}

export function PreviewDateBar(props: { id: string; }): React.JSX.Element
{
    const chosen = usePreviewDate();
    const [dates, setDates] = useState<{ date: string; label: string; }[]>([]);
    const date = chosen ?? dates[0]?.date;
    const [text, setText] = useState(date ?? '');
    const [who, setWho] = useState<MapCharacter | null | undefined>(undefined);

    useEffect(() =>
    {
        void bookmarkDates().then(setDates);
    }, []);
    useEffect(() => setText(date ?? ''), [date]);
    // the character then (the map's character facts: age, alive, culture at the date)
    useEffect(() =>
    {
        if (!date)
            return;

        let live = true;
        void api
            .mapCharacters(props.id, date)
            .then((list) => live && setWho(list.find((c) => c.id === props.id) ?? null))
            .catch(() => live && setWho(null));
        return () =>
        {
            live = false;
        };
    }, [props.id, date]);

    const go = (d: string | null): void =>
    {
        if (d)
            setPreviewDate(d);
    };
    const shift = (years: number): void =>
    {
        if (!date)
            return;

        const [y, m, d] = date.split('.').map(Number);
        go(`${y + years}.${m}.${d}`);
    };
    const born = who?.birth && date && cmp(date, who.birth) < 0;
    return (
        <div className="preview-date" title={tr('The preview date — the map shows the same date: change it here or there')}>
            <span className="preview-date-label">{tr('At')}</span>
            <Select value={dates.some((x) => x.date === date) ? date : ''} onChange={(e) => go(e.target.value || null)} label={tr('Bookmark')}>
                {!dates.some((x) => x.date === date) && <option value="">{tr('Other date')}</option>}
                {dates.map((x) => (
                    <option key={x.date} value={x.date}>
                        {x.date} ({x.label})
                    </option>
                ))}
            </Select>
            <button className="ghost small" onClick={(e) => shift(e.shiftKey ? -10 : -1)} title={tr('A year earlier (Shift: ten)')}>
                ◂
            </button>
            <input
                className="preview-date-input"
                value={text}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go(parseDate(text))}
                onBlur={() => go(parseDate(text))}
            />
            <button className="ghost small" onClick={(e) => shift(e.shiftKey ? 10 : 1)} title={tr('A year later (Shift: ten)')}>
                ▸
            </button>
            <span className="preview-date-who">
                {who === undefined ? '' : who === null ? tr('not in the map’s history') : born ? tr('not born yet (born {birth})', { birth: who.birth! }) : !who.alive ? tr('dead (died {death})', { death: who.death ?? '?' }) : tr('age {age}{culture}', { age: who.age ?? '?', culture: who.culture ? ` · ${who.culture.name}` : '' })}
            </span>
        </div>
    );
}

/** y.m.d dates in order */
function cmp(a: string, b: string): number
{
    const [x, y] = [a, b].map((d) => d.split('.').map(Number));

    for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) - (y[i] ?? 0);

    return 0;
}
