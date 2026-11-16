/**
 * The map panel's title editor (docs/map.md, "Editing from the map"): a title's holder and liege at the map's date
 * (history/titles) and its colour (its definition in common/landed_titles), written by MapEdit.tsx's runEdit.
 * Characters are searched in main (api.mapCharacters): house, life, culture and whether they live at the date.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MapCharacter, MapEditRequest, MapInfo } from '../../../../shared/api';
import { api } from '../../api';
import { runEdit, usePlan, whenOf, WhenRow, type When } from './MapEdit';
import { MapEditChooser, type Choice } from './MapEditChooser';
import { TIER_NAMES, ancestorAt, hashColor } from './model';
import { newCharacterFor } from '../../characterPick';

/** the holder chooser's row for a new character */
const NEW = '\u0000new';

import { tr } from '../../../../shared/i18n';
/** tiers from low to high */
const TIER_RANK = 'bcdkeh';

/** #rrggbb of a CSS colour (the title's colour, or its fallback). */
function hexOf(c: string | undefined): string
{
    return c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '#808080';
}

const yearOf = (d: string | undefined): string => (d ? d.slice(0, d.indexOf('.')) : '?');

/** A found character as a choice: name and house; life, culture and the titles they hold at the date below. */
function characterChoice(c: MapCharacter, holds: Map<string, string>): Choice
{
    const life = c.birth || c.death ? `${yearOf(c.birth)}–${c.death ? yearOf(c.death) : ''}` : '';
    const title = holds.get(c.id);
    return {
        key: c.id,
        name: c.house ? `${c.name} ${c.house}` : c.name,
        hint: c.alive ? (c.age !== undefined ? tr('age {age}', { age: c.age }) : 'alive') : tr('not alive then'),
        sub: [life, c.culture?.name, title && `holds ${title}`, `#${c.id}`].filter(Boolean).join(' · '),
        dim: !c.alive
    };
}

/** Changes a title: its holder and liege at the map's date (history), its colour (its definition). */
export function MapTitleEdit(props: { info: MapInfo; t: number; onDone: () => void; onClose: () => void; }): React.JSX.Element
{
    const { info, t } = props;
    const title = info.titles[t];
    const [sub, setSub] = useState<'holder' | 'liege' | null>(null);
    const [when, setWhen] = useState<When>('date');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [color, setColor] = useState(hexOf(title.color));
    const holderPlan = usePlan({ kind: 'holder', title: title.key, date: info.date }, info);
    const liegePlan = usePlan({ kind: 'liege', title: title.key, date: info.date }, info);
    const liegeKey = liegePlan?.current?.value;
    const liege = liegeKey && liegeKey !== '0' ? info.titles.find((x) => x.key === liegeKey) : undefined;

    useEffect(() =>
    {
        setColor(hexOf(title.color));
    }, [title.color]);
    // (the holder chooser opens: main readies its character lists for the date meanwhile), and its first list: the
    // holder, the de jure liege's and the vassal titles' holders and their families (main: mapHolderSuggestions)
    const [suggested, setSuggested] = useState<MapCharacter[]>([]);
    useEffect(() =>
    {
        if (sub !== 'holder')
            return;

        void api.mapCharacters('', info.date).catch(() => undefined);
        const seeds: [string, string][] = [];

        if (title.holder)
            seeds.push([title.holder.id, tr('holds it now')]);

        const liege = title.parent >= 0 ? info.titles[title.parent] : undefined;

        if (liege?.holder)
            seeds.push([liege.holder.id, tr('holder of {name}', { name: liege.name })]);

        for (const x of info.titles)
            if (x.parent === t && x.holder)
                seeds.push([x.holder.id, tr('holder of {name}', { name: x.name })]);

        let live = true;
        void api
            .mapHolderSuggestions(seeds, info.date, true)
            .then((r) => live && setSuggested(r))
            .catch(() => undefined);
        return () =>
        {
            live = false;
        };
    }, [sub, info.date, info.titles, t, title]);

    // who holds what at the date: a character's highest title
    const holds = useMemo(() =>
    {
        const m = new Map<string, { name: string; rank: number; }>();

        for (const x of info.titles)
        {
            if (!x.holder)
                continue;

            const rank = TIER_RANK.indexOf(x.tier);
            const had = m.get(x.holder.id);

            if (!had || rank > had.rank)
                m.set(x.holder.id, { name: x.name, rank });
        }

        return new Map([...m].map(([id, x]) => [id, x.name]));
    }, [info.titles]);

    // characters by name, id, house or dynasty, those alive at the date first (main ranks them)
    const searchCharacters = useCallback(async (q: string): Promise<Choice[]> => (await api.mapCharacters(q, info.date)).map((c) => characterChoice(c, holds)), [info.date, holds]);
    const lieges = useMemo(() =>
    {
        const rank = TIER_RANK.indexOf(title.tier);
        return info.titles
            .filter((x) => TIER_RANK.indexOf(x.tier) > rank)
            .map((x) => ({
                key: x.key,
                name: x.name,
                color: x.color ?? hashColor(x.key),
                hint: `${TIER_NAMES[x.tier]?.[0] ?? x.tier} · ${x.holder ? x.holder.name : tr('no holder')}`,
                dim: !x.holder
            }))
            .sort((a, b) => Number(a.dim) - Number(b.dim) || a.name.localeCompare(b.name));
    }, [info.titles, title.tier]);

    const edit = async (req: MapEditRequest, text: string): Promise<void> =>
    {
        setBusy(true);
        setError(null);
        const why = await runEdit(req, text);
        setBusy(false);

        if (why)
            setError(why);
        else
            props.onDone();
    };
    const open = (s: 'holder' | 'liege'): void =>
    {
        setSub(sub === s ? null : s);
        setWhen('date');
        setError(null);
    };
    const plan = sub === 'liege' ? liegePlan : holderPlan;
    // a new character as the holder (characterPick.ts): the culture and faith of a province of the title where the
    // preset leaves them, the holder's family for a "relative" dynasty; then set as the holder
    const newHolder = async (): Promise<void> =>
    {
        let p = 1;

        while (p < info.count && ancestorAt(info, p, title.tier as 'b' | 'c' | 'd' | 'k' | 'e' | 'h') !== t)
            p++;

        const layer = (id: string): string | undefined =>
        {
            const l = info.layers.find((x) => x.id === id);
            const i = p < info.count ? (l?.values[p] ?? -1) : -1;
            return l?.things && i >= 0 ? l.things[i].key : undefined;
        };
        const id = await newCharacterFor({ title: title.name, date: info.date, culture: layer('culture'), faith: layer('faith'), houseOf: title.holder?.id }, { x: Math.max(16, window.innerWidth / 2 - 160), y: 140 });

        if (id)
            await edit({ kind: 'holder', title: title.key, value: id, date: info.date, when: at }, tr('Holder of {name}: {id}{from}', { name: title.name, id, from }));
    };
    const at = whenOf(plan, when, false);
    const from = at === 'date' ? tr(' from {date}', { date: info.date }) : '';
    return (
        <div className="map-edit">
            <div className="map-edit-head">
                <b>{title.name}</b> <span className="map-dim">{tr('at {date}', { date: info.date })}</span>
            </div>
            <div className="map-edit-field">
                <span className="map-edit-label">{tr('Holder')}</span>
                <span className="map-edit-value">{title.holder ? `${title.holder.name}${title.holder.house ? ' ' + title.holder.house : ''}` : <span className="map-dim">{tr('none')}</span>}</span>
                <button className={'small' + (sub === 'holder' ? ' on' : '')} disabled={busy} onClick={() => open('holder')}>
                    {tr('Change…')}</button>
            </div>
            {sub === 'holder' && (
                <>
                    <WhenRow date={info.date} plan={holderPlan} when={when} onWhen={setWhen} undated={false} />
                    <MapEditChooser
                        search={searchCharacters}
                        choices={suggested.map((c) => ({ ...characterChoice(c, holds), hint: c.note ? `${c.note} · ${characterChoice(c, holds).hint}` : characterChoice(c, holds).hint }))}
                        fixed={[{ key: '0', name: tr('No holder'), hint: 'holder = 0' }, { key: NEW, name: tr('＋ New character…'), hint: tr('from a preset') }]}
                        current={title.holder?.id}
                        placeholder={tr('Find a character (name, house or id)…')}
                        busy={busy}
                        onPick={(c) =>
                            c.key === NEW ?
                                void newHolder() :
                                void edit({ kind: 'holder', title: title.key, value: c.key, date: info.date, when: at }, tr('Holder of {name}: {holder}{from}', { name: title.name, holder: c.key === '0' ? 'none' : c.name, from }))}
                        onCancel={() => setSub(null)}
                    />
                </>
            )}
            <div className="map-edit-field">
                <span className="map-edit-label">{tr('Liege')}</span>
                <span className="map-edit-value">{liegePlan === undefined ? '…' : liege ? liege.name : liegeKey && liegeKey !== '0' ? liegeKey : <span className="map-dim">{tr('none')}</span>}</span>
                <button className={'small' + (sub === 'liege' ? ' on' : '')} disabled={busy} onClick={() => open('liege')}>
                    {tr('Change…')}</button>
            </div>
            {sub === 'liege' && (
                <>
                    <WhenRow date={info.date} plan={liegePlan} when={when} onWhen={setWhen} undated={false} />
                    <MapEditChooser
                        choices={lieges}
                        fixed={[{ key: '0', name: 'None (independent)', hint: 'liege = 0' }]}
                        current={liegeKey ?? '0'}
                        placeholder={tr('Find a title…')}
                        busy={busy}
                        onPick={(c) => void edit({ kind: 'liege', title: title.key, value: c.key, date: info.date, when: at }, tr('Liege of {name}: {liege}{from}', { name: title.name, liege: c.key === '0' ? 'none' : c.name, from }))}
                        onCancel={() => setSub(null)}
                    />
                </>
            )}
            <div className="map-edit-field">
                <span className="map-edit-label">{tr('Colour')}</span>
                <input type="color" className="map-edit-color" value={color} disabled={busy} onChange={(e) => setColor(e.target.value)} title="The title's colour (common/landed_titles: color = { r g b })" />
                <span className="map-edit-value map-dim">{color}</span>
                <button
                    className="small"
                    disabled={busy || color === hexOf(title.color)}
                    onClick={() => void edit({ kind: 'color', title: title.key, value: color }, tr('Colour of {name}: {color}', { name: title.name, color }))}
                    title={tr('Overrides the title\'s definition in the mod (the whole top-level title holding it) and sets its color')}
                >
                    {tr('Apply')}</button>
            </div>
            {busy && <div className="map-edit-busy">{tr('Writing into the mod…')}</div>}
            {error && <div className="map-edit-error">{error}</div>}
        </div>
    );
}
