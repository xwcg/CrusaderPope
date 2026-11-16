import { useEffect, useMemo, useRef, useState } from 'react';
import { pickEntry } from '../characterPick';
import { useShownDate } from './map/mapLoad';
import type { DnaEditorData, DnaGene, DnaGeneInfo, PortraitData, PortraitRequest } from '../../../shared/api';
import { api } from '../api';
import { imgUrl } from '../img';
import { useActiveMod } from '../modStore';
import { undoSaveEdit } from '../scriptEdits';
import { reportChange } from '../changes';
import { errorText } from './ModDialogs';
import { PortraitViewer } from './PortraitViewer';
import { Select } from './Select';
import { Slider } from './Slider';

import { tr } from '../../../shared/i18n';
/**
 * The barbershop (docs/portraits.md, "Barbershop"): a character's DNA gene by gene, grouped like the game's ruler
 * designer (the genes with a `group` in common/genes), with the portrait rebuilt as it changes. Age and sex only change
 * the preview (the DNA has neither). Save writes the DNA into the active mod, one undo step.
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
    // the ethnicity the genes were last rolled from ("From ethnicity…")
    const [rolled, setRolled] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // accessory gene → the template the portrait wears it from (a portrait modifier may swap in another list)
    const [worn, setWorn] = useState<Map<string, string>>(new Map());
    const active = useActiveMod();

    // (the DNA and the catalog, their age at the preview date, as the portrait shows them)
    const date = useShownDate();
    useEffect(() =>
    {
        void api.dnaEditor(props.type, props.name, date).then((d) =>
        {
            setData(d);

            if (!d)
                return;

            setGenes(d.genes);
            setRolled(null);
            setFemale(d.female);
            setAge(d.age);
            setGroup(d.catalog[0]?.group ?? '');
        }, (e: unknown) => setError(errorText(e)));
    }, [props.type, props.name, date]);

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
    // (the DNA as loaded: each slider's default; double click goes back to it)
    const loaded = useMemo(() => new Map((data?.genes ?? []).map((g) => [g.gene, g])), [data]);
    const kind = age < 18 ? (female ? 'girl' : 'boy') : female ? 'female' : 'male';
    const set = (g: DnaGene): void =>
        setGenes((list) =>
        {
            const i = list.findIndex((x) => x.gene === g.gene);
            return i < 0 ? [...list, g] : list.map((x, k) => (k === i ? g : x));
        });

    // the game's rule for the most beautiful (beauty_good_3's genetic constraints): each gene it names moved into its
    // range: the nearest value, the template kept when the rule allows it (else its first)
    const beautify = (): void =>
        setGenes((list) =>
        {
            const out = [...list];

            // (beyond the game's rule: the body shape neutral and no musculature of its own (the game adds it from
            // prowess, portrait modifier `muscularity`): the apple / pear … shapes and the gene's muscles read as pudgy
            // or brawny on a beauty)
            const shape = data?.catalog.find((g) => g.gene === 'gene_bs_body_shape');
            const extra = shape?.templates.some((t) => t.name === 'body_shape_average') && !data?.beauty.some((r) => r.gene === shape.gene)
                ? [{ gene: shape.gene, options: [{ template: 'body_shape_average', min: 0, max: 0 }] }]
                : [];

            for (const rule of [...(data?.beauty ?? []), ...extra])
            {
                const i = out.findIndex((x) => x.gene === rule.gene);
                const g = out[i];

                if (g?.xy || !rule.options.length)
                    continue;

                const o = rule.options.find((x) => x.template === g?.template) ?? rule.options[0];
                const value = Math.min(o.max, Math.max(o.min, g?.value ?? 127));
                const next: DnaGene = g ? { ...g, template: o.template, value } : { gene: rule.gene, template: o.template, value, template2: o.template, value2: value };

                if (i < 0)
                    out.push(next);
                else
                    out[i] = next;
            }

            return out;
        });

    // "From ethnicity…": the genes rolled from an ethnicity (picked) replace the DNA's; another click, another roll
    const fromEthnicity = async (at: { x: number; y: number; }): Promise<void> =>
    {
        const eth = await pickEntry('ethnicities', tr('Genes from which ethnicity?'), at);

        if (!eth)
            return;

        const genesOf = await api.ethnicityGenes(eth, `${eth}:${Math.random()}`);
        const by = new Map(genesOf.map((g) => [g.gene, g]));
        setGenes((list) => [...list.map((g) => by.get(g.gene) ?? g), ...genesOf.filter((g) => !list.some((x) => x.gene === g.gene))]);
        setRolled(eth);
    };

    // "Randomize" (a section): its genes rolled from the ethnicity (the one last rolled from, else the culture's) and
    // what the ethnicity leaves out at random (a template the designer offers, any value / palette point)
    const randomize = async (genesOf: DnaGeneInfo[]): Promise<void> =>
    {
        if (!data)
            return;

        const eth = rolled ?? data.ethnicity;
        const roll = new Map((await api.ethnicityGenes(eth, `${eth}:${Math.random()}`)).map((g) => [g.gene, g]));
        const any = (n: number): number => Math.floor(Math.random() * n);
        const next = genesOf.map((info): DnaGene =>
        {
            const r = roll.get(info.gene);

            if (r)
                return r;

            if (info.kind === 'color')
            {
                const xy: [number, number] = [any(256), any(256)];
                return { gene: info.gene, value: 0, xy, xy2: xy };
            }

            // (an accessory list stays (the portrait modifiers pick the list worn anyway), a morph's variant is rolled)
            const visible = info.templates.filter((t) => t.visible);
            const pool = visible.length ? visible : info.templates;
            const cur = byGene.get(info.gene)?.template;
            const t = info.kind === 'accessory' && cur ? cur : pool[any(pool.length)]?.name;
            const v = any(256);
            return { gene: info.gene, template: t, value: v, template2: t, value2: v };
        });
        const by = new Map(next.map((g) => [g.gene, g]));
        setGenes((list) => [...list.map((g) => by.get(g.gene) ?? g), ...next.filter((g) => !list.some((x) => x.gene === g.gene))]);
    };

    // (a loaded save's character: its DNA goes into the save, no mod needed)
    const toSave = data?.target.type === 'savegame/characters';
    const why = toSave
        ? undefined
        : !active.mod
        ? tr('To save, set an active mod (Mods page: “New mod…”, or a mod’s ⋯ → Set as active mod).')
        : !active.mod.editable
        ? tr('The active mod {name} cannot be edited here (only unpacked mods in your mod folder can).', { name: active.mod.name })
        : !active.loaded
        ? tr('The active mod {name} is not in the loaded mod list.', { name: active.mod.name })
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

            if (r.save)
                reportChange({ kind: 'ok', text: tr('Changed the looks of {who}', { who }), mod: r.mod.name, details: r.notes, actions: [{ label: tr('Undo'), run: () => void undoSaveEdit() }] });
            else
                reportChange({ kind: 'ok', text: tr('Changed the looks of {who}', { who }), mod: r.mod.name, where: `${r.rel}:${r.line}`, file: r.file, line: r.line, details: r.notes.length ? r.notes : undefined, undo: r.step });
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
            <div className="modal barbershop" role="dialog" aria-label={tr('Barbershop')}>
                <div className="barbershop-view">
                    {data && <PortraitViewer className="barbershop-portrait" type={props.type} name={props.name} request={preview ?? { genes, age, female }} pending={!preview || preview.genes !== genes || preview.age !== age || preview.female !== female} onData={(d: PortraitData) => setWorn(new Map(d.accessories.filter((a) => a.template).map((a) => [a.gene, a.template!])))} />}
                </div>
                <div className="barbershop-side">
                    <header className="bb-head">
                        <span className="bb-eyebrow">{tr('Barbershop')}</span>
                        <h2>{data ? data.label : props.name}</h2>
                        {data && <span className="bb-source">{rolled ? tr('Rolled from ethnicity “{eth}”', { eth: rolled }) : data.source}</span>}
                    </header>
                    {data === undefined && !error && <p className="hint">{tr('Reading the DNA…')}</p>}
                    {data === null && <p className="wizard-warn">{tr('This portrait has no DNA to change.')}</p>}
                    {data && (
                        <>
                            <div className="bb-subject" title={tr('Age and sex only change the preview: the DNA has neither')}>
                                <div className="bb-seg" role="radiogroup" aria-label={tr('Sex')}>
                                    <button role="radio" aria-checked={!female} className={!female ? 'on' : ''} onClick={() => setFemale(false)}>
                                        {tr('Male')}
                                    </button>
                                    <button role="radio" aria-checked={female} className={female ? 'on' : ''} onClick={() => setFemale(true)}>
                                        {tr('Female')}
                                    </button>
                                </div>
                                <span className="bb-age">
                                    <span className="bb-age-label">{tr('Age')}</span>
                                    <Slider min={2} max={90} value={age} defaultValue={data.age} onChange={setAge} aria-label={tr('Age')} />
                                    <span className="bb-chip">{age}</span>
                                </span>
                            </div>
                            <nav className="bb-tabs" role="tablist">
                                {groups.map((g) => (
                                    <button key={g.group} role="tab" aria-selected={g === shown} className={g === shown ? 'on' : ''} onClick={() => setGroup(g.group)}>
                                        {g.label}
                                    </button>
                                ))}
                            </nav>
                            {shown && (
                                <div className="bb-section-head">
                                    <span>{shown.label}</span>
                                    {shown.group !== 'other' && (
                                        <button
                                            className="ghost small"
                                            onClick={() => void randomize(shown.genes)}
                                            title={tr('Roll this section’s genes from the ethnicity ({eth}) — again: another roll', { eth: rolled ?? data.ethnicity })}
                                        >
                                            {tr('Randomize')}
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="barbershop-genes">
                                {shown?.genes.map((info) => <GeneRow key={info.gene} info={info} gene={byGene.get(info.gene)} loaded={loaded.get(info.gene)} kind={kind} worn={worn.get(info.gene)} onChange={set} />)}
                            </div>
                        </>
                    )}
                    {error && <p className="wizard-warn">{error}</p>}
                    <footer className="bb-foot">
                        <div className="bb-tools">
                            <button className="ghost" disabled={!data} onClick={(e) => void fromEthnicity({ x: e.clientX, y: e.clientY })} title={tr('Roll the genes from an ethnicity, as the game does for a new character (again: another roll)')}>
                                {tr('From ethnicity…')}
                            </button>
                            <button className="ghost" disabled={!data?.beauty.length} onClick={beautify} title={tr('The face and body the game gives the most beautiful (trait Beautiful, beauty_good_3): each gene it limits moved into its range')}>
                                {tr('Beautify')}
                            </button>
                            <button className="ghost" disabled={!data} onClick={() => data && (setGenes(data.genes), setRolled(null))} title={tr('Back to the DNA as it was loaded')}>
                                {tr('Reset')}
                            </button>
                            <span style={{ flex: 1 }} />
                            <button onClick={props.onClose}>{tr('Close')}</button>
                            <button className="primary" disabled={!data || !!why || saving} onClick={() => void save()}>
                                {toSave ? tr('Save to the savegame') : tr('Save to mod')}
                            </button>
                        </div>
                        <span className="bb-save-hint">
                            {why ?? (toSave ? tr('Changes the character’s DNA in the loaded save (written with “Write save as…” on the Save tab).') : t && (t.create ? tr('Saves a new DNA entry {name} for character {character} into {name2}.', { name: t.name, character: t.character, name2: active.mod!.name }) : tr('Saves {what} {name} into {name2}.', { what: t.type === 'dna_data' ? tr('DNA') : tr('bookmark portrait'), name: t.name, name2: active.mod!.name })))}
                        </span>
                    </footer>
                </div>
            </div>
        </div>
    );
}

/** A key shown as words where the game has no name for it: "body_shape_apple_half" → "Body shape apple half". */
const nice = (label: string): string => (/^[a-z0-9_]+$/.test(label) ? (label.charAt(0).toUpperCase() + label.slice(1)).replace(/_/g, ' ') : label);

/** An accessory's file name as words: "male_hair_western_01" → "hair western 01". */
const accessoryLabel = (a: string): string => a.replace(/^(male|female|boy|girl)_/, '').replace(/_/g, ' ');

/** One gene: a palette for colours, the accessory list for accessory genes, a slider (and template) for morphs. */
function GeneRow(props: { info: DnaGeneInfo; gene: DnaGene | undefined; loaded?: DnaGene; kind: string; worn?: string; onChange: (g: DnaGene) => void; }): React.JSX.Element
{
    const { info, gene } = props;
    const first = info.templates.find((t) => t.visible) ?? info.templates[0];
    // (every template (the ones the ruler designer hides marked): a DNA may use any)
    const offered = info.templates;
    const template = gene?.template ?? first?.name;
    const value = gene?.value ?? 127;
    const base: DnaGene = gene ?? { gene: info.gene, template, value, template2: template, value2: value };

    if (info.kind === 'color')
        return (
            <div className="gene-row">
                <span className="gene-label">{nice(info.label)}</span>
                <Palette src={info.palette!} xy={gene?.xy} onPick={(xy) => props.onChange({ ...base, value: 0, template: undefined, template2: undefined, xy, xy2: gene?.xy2 ?? xy })} />
            </div>
        );

    const templateSelect = offered.length > 1 && (
        <Select value={template} onChange={(e) => props.onChange({ ...base, template: e.target.value })} aria-label={tr('{label}: variant', { label: info.label })}>
            {offered.map((t) => (
                <option key={t.name} value={t.name}>
                    {t.visible ? nice(t.label) : tr('{label} (hidden)', { label: nice(t.label) })}
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
                <span className="gene-label">{nice(info.label)}</span>
                {templateSelect}
                {swapped && <span className="hint" title={tr('A portrait modifier (culture, clothing, hair type) picks this list; the DNA\'s value chooses in it')}>{tr('worn from {label}', { label: info.templates.find((t) => t.name === from)?.label ?? from })}</span>}
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
                    <span className="hint">{tr('nothing for this portrait type')}</span>}
            </div>
        );
    }

    return (
        <div className={'gene-row' + (gene ? '' : ' unset')} title={gene ? undefined : tr('Not in this DNA — the game uses the middle')}>
            <span className="gene-label">{nice(info.label)}</span>
            {templateSelect}
            <Slider
                className="gene-slider"
                min={0}
                max={255}
                value={value}
                defaultValue={props.loaded?.value ?? 127}
                defaultLabel={props.loaded ? tr('{label} (as loaded)', { label: props.loaded.value }) : tr('127 (the middle)')}
                aria-label={info.label}
                onChange={(v) => props.onChange({ ...base, value: v })}
            />
            <span className="bb-chip">{value}</span>
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
