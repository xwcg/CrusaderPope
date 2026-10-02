import { useEffect, useState } from 'react';
import type { CharacterFacets, CharacterFilter } from '../../../shared/api';
import { api } from '../api';
import { useRevision } from '../revision';
import { Select } from './Select';

/** the facets of an index revision (an update can bring other cultures, faiths, traits) */
let facetsCache: { revision: number; facets: Promise<CharacterFacets>; } | null = null;

/** Number of active criteria (the date alone does not filter). */
export function activeCriteria(f: CharacterFilter): number
{
    return (
        (f.gender ? 1 : 0) +
        (f.age ? 1 : 0) +
        (f.alive !== undefined ? 1 : 0) +
        (f.culture ? 1 : 0) +
        (f.faith ? 1 : 0) +
        (f.religion ? 1 : 0) +
        (f.trait ? 1 : 0) +
        (f.dynasty?.trim() ? 1 : 0) +
        (f.rank ? 1 : 0) +
        (f.dna !== undefined ? 1 : 0)
    );
}

/** Filter panel for Historical Characters: facts at a date (default the 1066 bookmark). */
export function CharacterFilters(props: { value: CharacterFilter; onChange: (f: CharacterFilter) => void; }): React.JSX.Element
{
    const { value: f, onChange } = props;
    const [facets, setFacets] = useState<CharacterFacets | null>(null);
    const [ageText, setAgeText] = useState(f.age ? String(f.age.value) : '');
    const [ageOp, setAgeOp] = useState<'' | '<' | '>' | '='>(f.age?.op ?? '');

    const revision = useRevision();
    useEffect(() =>
    {
        if (facetsCache?.revision !== revision)
            facetsCache = { revision, facets: api.characterFacets() };

        void facetsCache.facets.then(setFacets);
    }, [revision]);

    const set = (patch: Partial<CharacterFilter>): void =>
    {
        const next = { ...f, ...patch };

        for (const k of Object.keys(next) as (keyof CharacterFilter)[])
            if (next[k] === undefined || next[k] === '')
                delete next[k];

        onChange(next);
    };
    const setAge = (op: '' | '<' | '>' | '=', text: string): void =>
    {
        setAgeOp(op);
        setAgeText(text);
        const n = parseInt(text, 10);
        set({ age: op && Number.isFinite(n) ? { op, value: n } : undefined });
    };
    const faiths = facets ? facets.faiths : [];

    return (
        <div className="char-filters">
            <label className="cf-field">
                <span>Date</span>
                <input placeholder="1066.9.15" value={f.date ?? ''} onChange={(e) => set({ date: e.target.value.trim() || undefined })} title="Facts (age, faith, rank …) at this date, yyyy.mm.dd" />
            </label>
            <label className="cf-field">
                <span>Gender</span>
                <Select value={f.gender ?? ''} onChange={(e) => set({ gender: (e.target.value || undefined) as CharacterFilter['gender'] })}>
                    <option value="">Any</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                </Select>
            </label>
            <label className="cf-field">
                <span>Age</span>
                <span className="cf-age">
                    <Select value={ageOp} onChange={(e) => setAge(e.target.value as '' | '<' | '>' | '=', ageText)}>
                        <option value="">Any</option>
                        <option value="<">Under</option>
                        <option value=">">Over</option>
                        <option value="=">Exactly</option>
                    </Select>
                    <input type="number" min={0} max={120} value={ageText} disabled={!ageOp} onChange={(e) => setAge(ageOp, e.target.value)} />
                </span>
            </label>
            <label className="cf-field">
                <span>Alive</span>
                <Select value={f.alive === undefined ? '' : f.alive ? 'yes' : 'no'} onChange={(e) => set({ alive: e.target.value === '' ? undefined : e.target.value === 'yes' })}>
                    <option value="">Any</option>
                    <option value="yes">Alive at the date</option>
                    <option value="no">Not alive then</option>
                </Select>
            </label>
            <label className="cf-field">
                <span>Religion</span>
                <Select value={f.religion ?? ''} onChange={(e) => set({ religion: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {facets?.religions.map((r) => (
                        <option key={r.key} value={r.key}>
                            {r.label} ({r.count})
                        </option>
                    ))}
                </Select>
            </label>
            <label className="cf-field">
                <span>Faith</span>
                <Select value={f.faith ?? ''} onChange={(e) => set({ faith: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {faiths.map((r) => (
                        <option key={r.key} value={r.key}>
                            {r.label} ({r.count})
                        </option>
                    ))}
                </Select>
            </label>
            <label className="cf-field">
                <span>Culture</span>
                <Select value={f.culture ?? ''} onChange={(e) => set({ culture: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {facets?.cultures.map((r) => (
                        <option key={r.key} value={r.key}>
                            {r.label} ({r.count})
                        </option>
                    ))}
                </Select>
            </label>
            <label className="cf-field">
                <span>Trait</span>
                <Select value={f.trait ?? ''} onChange={(e) => set({ trait: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {facets?.traits.map((r) => (
                        <option key={r.key} value={r.key}>
                            {r.label} ({r.count})
                        </option>
                    ))}
                </Select>
            </label>
            <label className="cf-field">
                <span>Rank</span>
                <Select value={f.rank ?? ''} onChange={(e) => set({ rank: (e.target.value || undefined) as CharacterFilter['rank'] })}>
                    <option value="">Any</option>
                    <option value="ruler">Any ruler</option>
                    <option value="unlanded">Unlanded</option>
                    <option value="empire">Emperor / empress</option>
                    <option value="kingdom">King / queen</option>
                    <option value="duchy">Duke / duchess</option>
                    <option value="county">Count / countess</option>
                    <option value="barony">Baron / baroness</option>
                </Select>
            </label>
            <label className="cf-field">
                <span>Dynasty</span>
                <input placeholder="name or key" value={f.dynasty ?? ''} onChange={(e) => set({ dynasty: e.target.value || undefined })} />
            </label>
            <label className="cf-field">
                <span>Look</span>
                <Select value={f.dna === undefined ? '' : f.dna ? 'yes' : 'no'} onChange={(e) => set({ dna: e.target.value === '' ? undefined : e.target.value === 'yes' })}>
                    <option value="">Any</option>
                    <option value="yes">Scripted DNA</option>
                    <option value="no">Generated</option>
                </Select>
            </label>
            <div className="cf-actions">
                <button
                    className="ghost small"
                    onClick={() =>
                    {
                        setAgeOp('');
                        setAgeText('');
                        onChange({});
                    }}
                >
                    Reset
                </button>
            </div>
        </div>
    );
}
