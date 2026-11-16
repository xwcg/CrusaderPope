/**
 * Settings → Characters (docs/mods.md, "New characters"): the presets new historical characters are made from (a
 * map holder, a relative) and the default ages of relatives: global, for every mod.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { pickEntry } from '../characterPick';
import { GameImg } from '../img';
import { onIndexChange, useRevision } from '../revision';
import type { CharacterPreset, Relation, Settings } from '../../../shared/api';
import { DEFAULT_PRESETS, DEFAULT_RELATIVE_AGES, RELATION_LABELS, presetsOf, relativeAgesOf } from '../../../shared/characterPresets';
import { tr } from '../../../shared/i18n';
import { Select } from './Select';

const SKILLS = ['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess'] as const;
const SKILL_LABELS: Record<(typeof SKILLS)[number], string> = { diplomacy: tr('Diplomacy'), martial: tr('Martial'), stewardship: tr('Stewardship'), intrigue: tr('Intrigue'), learning: tr('Learning'), prowess: tr('Prowess') };

/** names in game of a type's entries (the preset's culture, faith, traits, dynasty shown by name), loaded once */
const nameCache = new Map<string, Promise<Map<string, { name: string; icon?: string; }> | null>>();

// (another mod list or game folder: other cultures, faiths, traits)
onIndexChange((files) =>
{
    // (a revision that changed no files, e.g. a renamed mod, leaves the names as they are)
    if (!files || files.length)
        nameCache.clear();
});

/** names in game and icons of a type's entries (the preset's culture, faith, traits, dynasty shown so), loaded once */
function useNames(types: string[]): Record<string, Map<string, { name: string; icon?: string; }>>
{
    const [out, setOut] = useState<Record<string, Map<string, { name: string; icon?: string; }>>>({});
    // (the names are asked again after an index change)
    const rev = useRevision();
    useEffect(() =>
    {
        let live = true;

        for (const t of types)
        {
            let p = nameCache.get(t);

            if (!p)
                nameCache.set(t, p = api.list(t).then((l) => new Map(l.map((e) => [e.name, { name: e.display ?? e.name, icon: e.icon }])), () =>
                {
                    // (a failed list is asked again next time, not kept; the keys show meanwhile)
                    nameCache.delete(t);
                    return null;
                }));

            void p.then((m) => m && live && setOut((o) => ({ ...o, [t]: m })));
        }

        return () =>
        {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [types.join(), rev]);
    return out;
}

/** An entry of a type chosen with the picker (docs/picker.md, plain menus): its name in game, or what empty means. */
function EntryButton(props: { type: string; value?: string; empty: string; title: string; onPick: (key: string) => void; }): React.JSX.Element
{
    const names = useNames([props.type]);
    const e = props.value ? names[props.type]?.get(props.value) : undefined;
    return (
        <span className="preset-entry">
            <button
                data-entity={props.value ? `${props.type}:${props.value}` : undefined}
                onClick={(e) => void pickEntry(props.type, props.title, { x: e.clientX, y: e.clientY }, { none: props.empty, current: props.value }).then((k) => k !== null && props.onPick(k))}
                title={props.value}
            >
                {props.value ?
                    (
                        <>
                            {e?.icon && <GameImg path={e.icon} size={18} className="preset-icon" />}
                            {e?.name ?? props.value}
                        </>
                    ) :
                    <span className="dim">{props.empty}</span>}
            </button>
            {props.value && (
                <button className="ghost small" title={tr('Back to: {empty}', { empty: props.empty })} onClick={() => props.onPick('')}>
                    ×
                </button>
            )}
        </span>
    );
}

export function CharacterPresetsPage(props: { s: Settings; setS: (s: Settings) => void; }): React.JSX.Element
{
    const names = useNames(['traits']);
    const { s, setS } = props;
    const presets = presetsOf(s);
    const ages = relativeAgesOf(s);
    const [sel, setSel] = useState(0);
    const p = presets[Math.min(sel, presets.length - 1)];
    const put = (list: CharacterPreset[]): void => setS({ ...s, characterPresets: list });
    const change = (patch: Partial<CharacterPreset>): void => put(presets.map((x, i) => (x === p ? { ...x, ...patch } : x)));
    return (
        <>
            <div className="field">
                <label>{tr('Relatives are born, in years from the character')}</label>
                <div className="preset-ages">
                    {(Object.keys(DEFAULT_RELATIVE_AGES) as Relation[]).map((r) => (
                        <label key={r}>
                            {RELATION_LABELS[r]}
                            <input type="number" value={ages[r]} onChange={(e) => setS({ ...s, relativeAges: { ...ages, [r]: Number(e.target.value) || 0 } })} />
                        </label>
                    ))}
                </div>
                <span className="hint">{tr('The default of “＋ relative” on a character’s card — any other number can be typed there.')}</span>
            </div>
            <div className="field">
                <label>{tr('Presets for new characters')}</label>
                <div className="preset-list">
                    {presets.map((x, i) => (
                        <button key={x.id} className={x === p ? 'active' : ''} onClick={() => setSel(i)}>
                            {x.label}
                        </button>
                    ))}
                    <button
                        onClick={() =>
                        {
                            put([...presets, { id: `preset_${Date.now().toString(36)}`, label: tr('New preset'), sex: 'male', age: 30, dynasty: 'relative' }]);
                            setSel(presets.length);
                        }}
                    >
                        {tr('＋ New')}
                    </button>
                </div>
                <span className="hint">{tr('For every mod: a new holder on the map, a new relative on a character’s card.')}</span>
            </div>
            {p && (
                <div className="preset-edit">
                    <label>
                        {tr('Name of the preset')}
                        <input value={p.label} onChange={(e) => change({ label: e.target.value })} />
                    </label>
                    <label>
                        {tr('Man or woman')}
                        <Select value={p.sex} onChange={(e) => change({ sex: e.target.value as CharacterPreset['sex'] })}>
                            <option value="male">{tr('A man')}</option>
                            <option value="female">{tr('A woman')}</option>
                            <option value="either">{tr('Either, by chance')}</option>
                        </Select>
                    </label>
                    <label>
                        {tr('Age as a new holder')}
                        <input type="number" value={p.age} onChange={(e) => change({ age: Number(e.target.value) || 0 })} />
                    </label>
                    <label>
                        {tr('Dynasty')}
                        <Select value={p.dynasty === 'none' ? 'none' : p.dynasty === 'relative' || p.dynasty === undefined ? 'relative' : 'key'} onChange={(e) => change({ dynasty: e.target.value === 'key' ? '' : e.target.value })}>
                            <option value="relative">{tr('The family’s (the relative’s, the title holder’s)')}</option>
                            <option value="none">{tr('None (lowborn)')}</option>
                            <option value="key">{tr('A dynasty by key…')}</option>
                        </Select>
                    </label>
                    {p.dynasty !== 'none' && p.dynasty !== 'relative' && p.dynasty !== undefined && (
                        <label>
                            {tr('Dynasty')}
                            <EntryButton type="dynasties" value={p.dynasty || undefined} empty={tr('Choose a dynasty…')} title={tr('Dynasty of the preset')} onPick={(k) => change({ dynasty: k || 'relative' })} />
                        </label>
                    )}
                    <label>
                        {tr('Culture')}
                        <EntryButton type="culture/cultures" value={p.culture} empty={tr('The relative’s, the county’s')} title={tr('Culture of the preset')} onPick={(k) => change({ culture: k || undefined })} />
                    </label>
                    <label>
                        {tr('Faith')}
                        <EntryButton type="faith" value={p.faith} empty={tr('The relative’s, the county’s')} title={tr('Faith of the preset')} onPick={(k) => change({ faith: k || undefined })} />
                    </label>
                    <label>
                        {tr('Name (empty: one from the culture’s names)')}
                        <input value={p.name ?? ''} onChange={(e) => change({ name: e.target.value.trim() || undefined })} />
                    </label>
                    <div className="preset-traits">
                        <span>{tr('Traits')}</span>
                        <div>
                            {(p.traits ?? []).map((t) => (
                                <span key={t} className="preset-chip" data-entity={`traits:${t}`}>
                                    {names['traits']?.get(t)?.icon && <GameImg path={names['traits'].get(t)!.icon} size={18} className="preset-icon" />}
                                    {names['traits']?.get(t)?.name ?? t}
                                    <button className="ghost small" title={tr('Remove')} onClick={() => change({ traits: (p.traits ?? []).filter((x) => x !== t) })}>
                                        ×
                                    </button>
                                </span>
                            ))}
                            <button
                                className="ghost small"
                                onClick={(e) =>
                                    void pickEntry('traits', tr('A trait for the preset'), { x: e.clientX, y: e.clientY }).then((k) => k && !(p.traits ?? []).includes(k) && change({ traits: [...(p.traits ?? []), k] }))}
                            >
                                {tr('＋ trait')}
                            </button>
                        </div>
                    </div>
                    <div className="preset-skills">
                        {SKILLS.map((k) => (
                            <label key={k}>
                                {SKILL_LABELS[k]}
                                <input
                                    type="number"
                                    value={p.skills?.[k] ?? ''}
                                    placeholder={tr('not set')}
                                    title={tr('Empty: not written')}
                                    onChange={(e) => change({ skills: { ...p.skills, [k]: e.target.value === '' ? undefined : Number(e.target.value) } })}
                                />
                            </label>
                        ))}
                    </div>
                    <div className="preset-actions">
                        <button disabled={presets.length < 2} onClick={() => put(presets.filter((x) => x !== p))}>
                            {tr('Delete this preset')}
                        </button>
                        <button onClick={() => setS({ ...s, characterPresets: undefined, relativeAges: undefined })}>{tr('Back to the app’s presets')}</button>
                        <span className="hint">{tr('{n} presets come with the app.', { n: DEFAULT_PRESETS.length })}</span>
                    </div>
                </div>
            )}
        </>
    );
}
