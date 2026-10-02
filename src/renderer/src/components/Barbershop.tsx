import { useEffect, useMemo, useRef, useState } from 'react';
import type { DnaEditorData, DnaGene, DnaGeneInfo, PortraitData, PortraitRequest } from '../../../shared/api';
import { api } from '../api';
import { imgUrl } from '../img';
import { useActiveMod } from '../modStore';
import { reportChange } from '../changes';
import { errorText } from './ModDialogs';
import { PortraitViewer } from './PortraitViewer';
import { Select } from './Select';

/**
 * The barbershop (docs/portraits.md, "Barbershop"): a character's DNA gene by gene, grouped like the game's ruler
 * designer (the genes with a `group` in common/genes), with the portrait rebuilt as it changes. Age and sex only change
 * the preview (the DNA has neither). Save writes the DNA into the active mod — one undo step.
 */
export function Barbershop(props: { type: string; name: string; onClose: () => void; }): React.JSX.Element
{
    const [data, setData] = useState<DnaEditorData | null | undefined>(undefined);
    const [genes, setGenes] = useState<DnaGene[]>([]);
    const [female, setFemale] = useState(false);
    const [age, setAge] = useState(30);
    const [group, setGroup] = useState('');
    const [preview, setPreview] = useState<PortraitRequest | undefined>(undefined);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // accessory gene → the template the portrait wears it from (a portrait modifier may swap in another list)
    const [worn, setWorn] = useState<Map<string, string>>(new Map());
    const active = useActiveMod();

    useEffect(() =>
    {
        void api.dnaEditor(props.type, props.name).then((d) =>
        {
            setData(d);

            if (!d)
                return;

            setGenes(d.genes);
            setFemale(d.female);
            setAge(d.age);
            setGroup(d.catalog[0]?.group ?? '');
        }, (e: unknown) => setError(errorText(e)));
    }, [props.type, props.name]);

    // the portrait follows the sliders a moment later (each change rebuilds it in the worker)
    useEffect(() =>
    {
        if (!data)
            return;

        const t = setTimeout(() => setPreview({ genes, age, female }), 120);
        return () => clearTimeout(t);
    }, [data, genes, age, female]);

    useEffect(() =>
    {
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                props.onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [props.onClose]);

    const groups = useMemo(() =>
    {
        const out: { group: string; label: string; genes: DnaGeneInfo[]; }[] = [];

        for (const g of data?.catalog ?? [])
        {
            let e = out.find((x) => x.group === g.group);

            if (!e)
                out.push(e = { group: g.group, label: g.groupLabel, genes: [] });

            e.genes.push(g);
        }

        return out;
    }, [data]);

    const byGene = useMemo(() => new Map(genes.map((g) => [g.gene, g])), [genes]);
    const kind = age < 18 ? (female ? 'girl' : 'boy') : female ? 'female' : 'male';
    const set = (g: DnaGene): void =>
        setGenes((list) =>
        {
            const i = list.findIndex((x) => x.gene === g.gene);
            return i < 0 ? [...list, g] : list.map((x, k) => (k === i ? g : x));
        });

    const why = !active.mod
        ? 'To save, set an active mod (Mods page: “New mod…”, or a mod’s ⋯ → Set as active mod).'
        : !active.mod.editable
        ? `The active mod ${active.mod.name} cannot be edited here (only unpacked mods in your mod folder can).`
        : !active.loaded
        ? `The active mod ${active.mod.name} is not in the loaded mod list.`
        : undefined;

    const save = async (): Promise<void> =>
    {
        if (!data)
            return;

        setSaving(true);
        setError(null);

        try
        {
            const r = await api.saveDna({ target: data.target, genes });
            const who = data.target.character ?? data.target.name;
            reportChange({ kind: 'ok', text: `Changed the looks of ${who}`, mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
            // (the DNA entry exists now: the next save changes it)
            setData({ ...data, target: { ...data.target, create: false } });
        }
        catch (e)
        {
            setError(errorText(e));
        }
        finally
        {
            setSaving(false);
        }
    };

    const t = data?.target;
    const shown = groups.find((g) => g.group === group) ?? groups[0];
    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal barbershop" role="dialog" aria-label="Barbershop">
                <div className="barbershop-view">
                    {data && <PortraitViewer className="barbershop-portrait" type={props.type} name={props.name} request={preview ?? { genes, age, female }} onData={(d: PortraitData) => setWorn(new Map(d.accessories.filter((a) => a.template).map((a) => [a.gene, a.template!])))} />}
                </div>
                <div className="barbershop-side">
                    <h2>Barbershop{data ? ` – ${data.label}` : ''}</h2>
                    {data === undefined && !error && <p className="hint">Reading the DNA…</p>}
                    {data === null && <p className="wizard-warn">This portrait has no DNA to change.</p>}
                    {data && (
                        <>
                            <p className="hint">
                                {data.source}. Age and sex only change the preview.
                            </p>
                            <div className="barbershop-subject">
                                <label>
                                    <input type="radio" checked={!female} onChange={() => setFemale(false)} /> Male
                                </label>
                                <label>
                                    <input type="radio" checked={female} onChange={() => setFemale(true)} /> Female
                                </label>
                                <label className="barbershop-age">
                                    Age {age}
                                    <input type="range" min={2} max={90} value={age} onChange={(e) => setAge(Number(e.target.value))} />
                                </label>
                            </div>
                            <div className="barbershop-groups" role="tablist">
                                {groups.map((g) => (
                                    <button key={g.group} role="tab" aria-selected={g === shown} className={g === shown ? 'active' : ''} onClick={() => setGroup(g.group)}>
                                        {g.label}
                                    </button>
                                ))}
                            </div>
                            <div className="barbershop-genes">
                                {shown?.genes.map((info) => <GeneRow key={info.gene} info={info} gene={byGene.get(info.gene)} kind={kind} worn={worn.get(info.gene)} onChange={set} />)}
                            </div>
                        </>
                    )}
                    {error && <p className="wizard-warn">{error}</p>}
                    <div className="actions">
                        <span className="hint">
                            {why ?? (t && (t.create ? `Saves a new DNA entry ${t.name} for character ${t.character} into ${active.mod!.name}.` : `Saves ${t.type === 'dna_data' ? 'DNA' : 'bookmark portrait'} ${t.name} into ${active.mod!.name}.`))}
                        </span>
                        <span style={{ flex: 1 }} />
                        <button disabled={!data} onClick={() => data && setGenes(data.genes)} title="Back to the DNA as it was loaded">
                            Reset
                        </button>
                        <button onClick={props.onClose}>Close</button>
                        <button className="primary" disabled={!data || !!why || saving} onClick={() => void save()}>
                            Save to mod
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** An accessory's file name as words: "male_hair_western_01" → "hair western 01". */
const accessoryLabel = (a: string): string => a.replace(/^(male|female|boy|girl)_/, '').replace(/_/g, ' ');

/** One gene: a palette for colours, the accessory list for accessory genes, a slider (and template) for morphs. */
function GeneRow(props: { info: DnaGeneInfo; gene: DnaGene | undefined; kind: string; worn?: string; onChange: (g: DnaGene) => void; }): React.JSX.Element
{
    const { info, gene } = props;
    const first = info.templates.find((t) => t.visible) ?? info.templates[0];
    // (templates the ruler designer offers, and the one the DNA has even when hidden)
    const offered = info.templates.filter((t) => t.visible || t.name === gene?.template);
    const template = gene?.template ?? first?.name;
    const value = gene?.value ?? 127;
    const base: DnaGene = gene ?? { gene: info.gene, template, value, template2: template, value2: value };

    if (info.kind === 'color')
        return (
            <div className="gene-row">
                <span className="gene-label">{info.label}</span>
                <Palette src={info.palette!} xy={gene?.xy} onPick={(xy) => props.onChange({ ...base, value: 0, template: undefined, template2: undefined, xy, xy2: gene?.xy2 ?? xy })} />
            </div>
        );

    const templateSelect = offered.length > 1 && (
        <Select value={template} onChange={(e) => props.onChange({ ...base, template: e.target.value })} aria-label={`${info.label}: variant`}>
            {offered.map((t) => (
                <option key={t.name} value={t.name}>
                    {t.label}
                </option>
            ))}
        </Select>
    );

    if (info.kind === 'accessory')
    {
        // a portrait modifier (culture, hair type) may wear it from another list: the DNA's value walks that one
        const from = props.worn && info.accessories?.[props.kind]?.[props.worn] ? props.worn : template;
        const swapped = from !== template;
        const list = (from && info.accessories?.[props.kind]?.[from]) || [];
        const i = list.findIndex((x) => value >= x.from && value < x.to);
        const current = i < 0 ? list.length - 1 : i;
        return (
            <div className="gene-row">
                <span className="gene-label">{info.label}</span>
                {templateSelect}
                {swapped && <span className="hint" title="A portrait modifier (culture, clothing, hair type) picks this list; the DNA's value chooses in it">worn from {info.templates.find((t) => t.name === from)?.label ?? from}</span>}
                {list.length ?
                    (
                        <Select
                            value={current}
                            aria-label={info.label}
                            onChange={(e) =>
                            {
                                const x = list[Number(e.target.value)];
                                // the lowest whole value inside its range (ranges narrower than 1 take their middle)
                                const v = Math.ceil(x.from) < x.to ? Math.ceil(x.from) : Math.round((x.from + x.to) / 2);
                                props.onChange({ ...base, value: Math.min(255, v) });
                            }}
                        >
                            {list.map((x, k) => (
                                <option key={k} value={k}>
                                    {accessoryLabel(x.accessory)}
                                </option>
                            ))}
                        </Select>
                    ) :
                    <span className="hint">nothing for this portrait type</span>}
            </div>
        );
    }

    return (
        <div className={'gene-row' + (gene ? '' : ' unset')} title={gene ? undefined : 'Not in this DNA — the game uses the middle'}>
            <span className="gene-label">{info.label}</span>
            {templateSelect}
            <input type="range" min={0} max={255} value={value} aria-label={info.label} onChange={(e) => props.onChange({ ...base, value: Number(e.target.value) })} />
            <span className="gene-value">{value}</span>
        </div>
    );
}

/** A colour palette (gfx/portraits/*_palette.dds): click or drag to pick the point (0..255 each way). */
function Palette(props: { src: string; xy: [number, number] | undefined; onPick: (xy: [number, number]) => void; }): React.JSX.Element
{
    const el = useRef<HTMLDivElement>(null);
    const pick = (e: React.PointerEvent): void =>
    {
        const r = el.current!.getBoundingClientRect();
        const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
        props.onPick([f((e.clientX - r.left) / r.width), f((e.clientY - r.top) / r.height)]);
    };
    const xy = props.xy;
    return (
        <div
            ref={el}
            className="gene-palette"
            onPointerDown={(e) =>
            {
                e.currentTarget.setPointerCapture(e.pointerId);
                pick(e);
            }}
            onPointerMove={(e) => e.buttons & 1 && pick(e)}
        >
            <img src={imgUrl(props.src, 256)} alt="" draggable={false} />
            {xy && <span className="gene-palette-mark" style={{ left: `${(xy[0] / 255) * 100}%`, top: `${(xy[1] / 255) * 100}%` }} />}
        </div>
    );
}
