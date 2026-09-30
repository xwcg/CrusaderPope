/**
 * Editing from the map (docs/map.md, "Editing from the map"): the side panel's editors of a province's layers — a
 * county's culture, faith and development, a barony's holding (the title editor: MapEditTitle.tsx) — written into
 * the active mod by the main process (src/main/map/edit.ts: history at the map's date), reported in the change bar
 * with Undo; main's map undo stack stays reachable (the panel's Undo, Ctrl+Z on the map page, a refusal's action). The
 * map reads its data again once the index has the change.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { MapEditRequest, MapEditResult, MapInfo, MapLayer } from '../../../../shared/api';
import type { Navigate } from '../../App';
import { api } from '../../api';
import { reportChange } from '../../changes';
import { useActiveMod } from '../../modStore';
import { errorText } from '../ModDialogs';
import { MODS_ROUTE } from '../ModsView';
import { MapEditChooser, type Choice } from './MapEditChooser';
import { ancestorAt, hashColor } from './model';
import '../../styles/map-edit.css';

/** The layers the map edits: the value is the county's (culture, faith, development) or the barony's (holding). */
export const EDITABLE_LAYERS = new Set(['culture', 'faith', 'holding', 'development']);

export type When = 'date' | 'current';

/** The map can be edited: an editable active mod in the loaded list (`mod`: its name) — else why not. */
export function useMapEditing(): { mod?: string; why?: string; }
{
    const a = useActiveMod();

    if (!a.mod)
        return { why: 'To change the map in your own mod, set an active mod (Mods page: “New mod…”, or a mod’s ⋯ → Set as active mod).' };

    if (!a.mod.editable)
        return { why: `The active mod ${a.mod.name} cannot be edited here (only unpacked mods in your mod folder can) — choose another one on the Mods page.` };

    if (!a.loaded)
        return { why: `The active mod ${a.mod.name} is not in the mod list loaded in the explorer — load a list with it to change the map.` };

    return { mod: a.mod.name };
}

// ---------------------------------------------------------------------------
// Running edits, main's undo stack
// ---------------------------------------------------------------------------

/** What this page's edits said, oldest first — the newest part of main's undo stack (older ones: main's own words). */
const edits: string[] = [];

/** Main's map undo stack as the page knows it: how many edits can be undone, what the next undo takes back. */
let undoable: { count: number; next?: string; } = { count: 0 };
const undoListeners = new Set<() => void>();

/** Takes in what main says about its undo stack (every result carries it). */
function tookStack(r: MapEditResult): void
{
    if (r.undo === undefined)
        return;

    if (edits.length > r.undo)
        edits.splice(0, edits.length - r.undo);

    undoable = { count: r.undo, next: edits[edits.length - 1] ?? r.undoNext };

    for (const l of undoListeners)
        l();
}

/** Main's map undo stack (read from main once per page, then kept by every result). */
export function useMapUndo(): { count: number; next?: string; }
{
    useEffect(() =>
    {
        void api
            .mapEdit({ kind: 'undo', plan: true })
            .then(tookStack)
            .catch(() => undefined);
    }, []);
    return useSyncExternalStore(
        (l) =>
        {
            undoListeners.add(l);
            return () => undoListeners.delete(l);
        },
        () => undoable
    );
}

const UNDO = { label: 'Undo', run: (): void => void undoMapEdit() };
const UNDO_LAST = { label: 'Undo last map edit', run: (): void => void undoMapEdit() };

/** Runs a map edit and reports it in the change bar (with Undo); the reason when it was refused, else null. */
export async function runEdit(req: MapEditRequest, text: string): Promise<string | null>
{
    let r: MapEditResult;

    try
    {
        r = await api.mapEdit(req);
    }
    catch (e)
    {
        r = { ok: false, message: errorText(e) };
    }

    if (!r.ok)
    {
        tookStack(r);
        // (the edits before it can still be undone)
        reportChange({ kind: 'error', text: `Not changed: ${text}`, details: [r.message ?? 'Refused'], actions: undoable.count ? [UNDO_LAST] : undefined });
        return r.message ?? 'Refused';
    }

    edits.push(text);
    tookStack(r);
    reportChange({ kind: 'ok', text, mod: r.mod?.name, where: r.rel && `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes?.length ? r.notes : undefined, actions: [UNDO] });
    return null;
}

/** Undoes the session's last map edit (the change bar's Undo, the panel's, Ctrl+Z on the map page). */
export async function undoMapEdit(): Promise<void>
{
    let r: MapEditResult;

    try
    {
        r = await api.mapEdit({ kind: 'undo' });
    }
    catch (e)
    {
        r = { ok: false, message: errorText(e) };
    }

    if (!r.ok)
    {
        tookStack(r);
        return reportChange({ kind: 'error', text: 'Not undone', details: [r.message ?? 'Refused'] });
    }

    const said = edits.pop();
    tookStack(r);
    reportChange({
        kind: 'info',
        text: said ? `Undone: ${said}` : (r.message ?? 'Undone'),
        mod: r.mod?.name,
        where: r.file && `${r.rel}:${r.line}`,
        file: r.file,
        line: r.line,
        details: undoable.count ? [`${undoable.count} earlier map edit${undoable.count > 1 ? 's' : ''} can be undone — next: ${undoable.next}`] : undefined,
        actions: undoable.count ? [UNDO] : undefined
    });
}

/** The hint under the panel's rows: how editing works, or what it takes; Undo while main has map edits to undo. */
export function MapEditHint(props: { date: string; navigate: Navigate; }): React.JSX.Element
{
    const e = useMapEditing();
    const u = useMapUndo();
    const undo = u.count > 0 && (
        <button className="ghost small map-edit-undo" onClick={() => void undoMapEdit()} title={`Undo the last map edit (Ctrl+Z) — ${u.count} can be undone`}>
            ↶ Undo: {u.next}
        </button>
    );

    if (e.mod)
        return (
            <div className="map-edit-foot" title="Culture, faith, development, holding, holder and liege are history at the map's date; the colour is the title's definition">
                ✎ on a row changes it in <b>{e.mod}</b> · at {props.date}
                {undo}
            </div>
        );

    return (
        <div className="map-edit-foot none">
            <div className="map-edit-foot-row">
                <span>✎ {e.why}</span>
                <button className="ghost small" onClick={() => props.navigate({ type: MODS_ROUTE })}>
                    Mods page
                </button>
            </div>
            {undo}
        </div>
    );
}

/**
 * What an edit would change (main's plan: the statement in effect, the file written); undefined while it loads. Asked
 * again for new map data (`info`: an edit or undo changed the files).
 */
export function usePlan(req: MapEditRequest, info: MapInfo): MapEditResult | null | undefined
{
    const [plan, setPlan] = useState<MapEditResult | null | undefined>(undefined);
    const key = JSON.stringify(req);
    useEffect(() =>
    {
        let live = true;
        setPlan(undefined);
        api
            .mapEdit({ ...(JSON.parse(key) as MapEditRequest), plan: true })
            .then((r) => live && setPlan(r))
            .catch(() => live && setPlan(null));
        return () =>
        {
            live = false;
        };
    }, [key, info]);
    return plan;
}

// ---------------------------------------------------------------------------
// When the change happens, and where it is written
// ---------------------------------------------------------------------------

const sameDate = (a: string, b: string): boolean =>
    a.split('.')
        .map(Number)
        .join('.') === b.split('.')
        .map(Number)
        .join('.');

/**
 * "From <date> on" (a dated block) or the statement in effect at the date ("from the start" when it is undated,
 * "since <its date>"; a de jure liege's development: the county's own from its date); and the file the change goes to.
 * `undated`: history/provinces — without a statement in effect a change can go from the start (title history is
 * dated only: then it goes from the date on).
 */
export function WhenRow(props: { date: string; plan: MapEditResult | null | undefined; when: When; onWhen: (w: When) => void; undated: boolean; }): React.JSX.Element
{
    const { plan, date } = props;
    const cur = plan?.current;
    const t = plan?.target;
    const one = cur?.date && sameDate(cur.date, date);
    const choice = !one && (!!cur || props.undated);
    const since = cur ? (cur.title ? `Since ${cur.date} (${cur.title} sets it then: this county’s own from then)` : cur.date ? `Since ${cur.date} (changes the entry of then)` : 'From the start (changes the undated entry)') : 'From the start';
    return (
        <div className="map-edit-when">
            {one ? <span>At {date} (changes the entry of that date)</span> : choice ?
                (
                    <select value={props.when} onChange={(e) => props.onWhen(e.target.value as When)} title="When the change happens (the history's dates)">
                        <option value="date">From {date} on</option>
                        <option value="current">{since}</option>
                    </select>
                ) :
                <span title="Title history is dated: with nothing set before, the change goes from the map's date on">From {date} on</span>}
            {t && (
                <div className="map-edit-target" title={t.rel}>
                    → {t.rel.slice(t.rel.lastIndexOf('/') + 1)}
                    {t.from ? ` (copied from ${t.from === 'Game' ? 'the game' : t.from} first)` : t.created ? ' (new file)' : ''}
                </div>
            )}
            {plan && !plan.ok && <div className="map-edit-error">{plan.message}</div>}
        </div>
    );
}

/** The mode a WhenRow shows: without a choice, what main does anyway. */
export function whenOf(plan: MapEditResult | null | undefined, when: When, undated: boolean): When
{
    return plan && !plan.current && !undated ? 'date' : when;
}

// ---------------------------------------------------------------------------
// Culture, faith, holding, development
// ---------------------------------------------------------------------------

/** A county's provinces in title order: its capital barony's first (history/provinces writes culture and faith there). */
function countyProvinces(info: MapInfo, county: number): number[]
{
    const out: number[] = [];

    for (let q = 1; q < info.count; q++)
    {
        const b = info.province.barony[q];

        if (b >= 0 && info.titles[b].parent === county)
            out.push(q);
    }

    return out.sort((a, b) => info.province.barony[a] - info.province.barony[b]);
}

/** A title's de jure lieges at the date, lowest first. */
function liegesOf(info: MapInfo, t: number): string[]
{
    const out: string[] = [];

    for (let x = info.titles[t].parent, guard = 0; x >= 0 && guard < 10; x = info.titles[x].parent, guard++)
        out.push(info.titles[x].key);

    return out;
}

/**
 * Changes a layer's value of the selected province: the county's culture, faith or development (history/titles
 * `change_development_level`, which sets it), the barony's holding.
 */
export function MapLayerEdit(props: { info: MapInfo; layer: MapLayer; p: number; onDone: () => void; onClose: () => void; }): React.JSX.Element
{
    const { info, layer, p } = props;
    const kind = layer.id as 'culture' | 'faith' | 'holding' | 'development';
    const t = kind === 'holding' ? info.province.barony[p] : ancestorAt(info, p, 'c');
    const provinces = useMemo(() => (kind === 'holding' ? [p] : kind !== 'development' && t >= 0 ? countyProvinces(info, t) : undefined), [kind, p, t, info]);
    const lieges = useMemo(() => (kind === 'development' && t >= 0 ? liegesOf(info, t) : undefined), [kind, t, info]);
    const title = t >= 0 ? info.titles[t] : undefined;
    const [when, setWhen] = useState<When>('current');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const plan = usePlan({ kind, title: title?.key, provinces, lieges, date: info.date }, info);
    const [holdings, setHoldings] = useState<Choice[]>([]);
    const v = layer.values[p];
    const [level, setLevel] = useState(Number.isFinite(v) ? String(v) : '');

    // holdings: every holding type (the layer lists only those on the map), none and auto (the game picks one)
    useEffect(() =>
    {
        if (kind !== 'holding')
            return;

        let live = true;
        void api.list('holdings').then((list) =>
        {
            if (!live)
                return;

            const color = (key: string): string | undefined => layer.things?.find((x) => x.key === key)?.color ?? hashColor(key);
            setHoldings([
                ...list.map((h) => ({ key: h.name, name: h.display ?? h.name, color: color(h.name) })),
                { key: 'none', name: 'No holding', color: color('none'), hint: 'none' },
                { key: 'auto', name: 'Automatic', color: color('auto'), hint: 'auto: the game fills the county' }
            ]);
        });
        return () =>
        {
            live = false;
        };
    }, [kind, layer]);

    const choices = useMemo(() => (kind === 'holding' ? holdings : (layer.things ?? []).map((x) => ({ key: x.key, name: x.name, color: x.color ?? hashColor(x.key) }))), [kind, holdings, layer]);

    if (!title)
        return <div className="map-edit">No {kind === 'holding' ? 'barony' : 'county'} here.</div>;

    const undated = kind !== 'development';
    const at = whenOf(plan, when, undated);

    const set = async (value: string, name: string): Promise<void> =>
    {
        setBusy(true);
        setError(null);
        const why = await runEdit({ kind, title: title.key, provinces, lieges, value, date: info.date, when: at }, `${layer.row} of ${title.name}: ${name}${at === 'date' ? ` from ${info.date}` : ''}`);
        setBusy(false);

        if (why)
            setError(why);
        else
            props.onDone();
    };
    const levelOk = /^\d{1,3}$/.test(level.trim());
    return (
        <div className="map-edit">
            <div className="map-edit-head">
                {layer.row} of <b>{title.name}</b>
                {kind === 'culture' || kind === 'faith' ? <span className="map-dim">(written on its capital)</span> : kind === 'development' ? <span className="map-dim">(sets it: change_development_level)</span> : null}
            </div>
            <WhenRow date={info.date} plan={plan} when={when} onWhen={setWhen} undated={undated} />
            {kind === 'development' ?
                (
                    <div className="map-edit-field">
                        <span className="map-edit-label">Level</span>
                        <input
                            className="map-edit-number"
                            type="number"
                            min={0}
                            max={999}
                            autoFocus
                            value={level}
                            disabled={busy}
                            onChange={(e) => setLevel(e.target.value)}
                            onKeyDown={(e) =>
                            {
                                if (e.key === 'Enter' && levelOk && !busy)
                                    void set(level.trim(), level.trim());
                                else if (e.key === 'Escape')
                                    props.onClose();
                            }}
                        />
                        <span className="map-edit-value map-dim">{Number.isFinite(v) ? `now ${v}` : ''}</span>
                        <button className="small" disabled={busy || !levelOk || Number(level) === v} onClick={() => void set(level.trim(), level.trim())}>
                            Set
                        </button>
                    </div>
                ) :
                (
                    <MapEditChooser
                        choices={choices}
                        current={v >= 0 ? layer.things?.[v]?.key : undefined}
                        placeholder={`Find a ${layer.row.toLowerCase()}…`}
                        busy={busy}
                        onPick={(c) => void set(c.key, c.name)}
                        onCancel={props.onClose}
                    />
                )}
            {busy && <div className="map-edit-busy">Writing into the mod…</div>}
            {error && <div className="map-edit-error">{error}</div>}
        </div>
    );
}
