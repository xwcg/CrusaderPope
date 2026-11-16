/**
 * The GUI tab's preview (docs/gui-designer.md, stage 2): a window, widget or type laid out as the game would, a box per
 * widget, labelled; a click shows where the widget is written; widgets with a bound `visible` are drawn and can be
 * switched off one by one. Textures drawn with CSS (GuiPaint): nine-slice sprites as border-image, frame sheets as a shifted
 * image; tints, masks (`modify_texture`) and shaders are not.
 */
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GuiBlock, GuiBox, GuiEditRequest, GuiFontFiles, GuiKind, GuiLayoutView, GuiPaint, GuiProp, GuiRun, GuiTextStyle, ScriptEditResult } from '../../../shared/api';
import { imgUrl } from '../img';
import { api } from '../api';
import { openTitle } from './common';
import { hook } from '../testApi';

import { errorText } from '../errors';
import { onIndexChange } from '../revision';
import { tr } from '../../../shared/i18n';
import { Slider } from './Slider';
/**
 * The toolbox (stage 3): widgets to add (the engine's common kinds and the game's everyday types), each as its key and
 * the properties a new one starts with. Any other type is added by name.
 */
const TOOLS: { label: string; key: string; props: string[]; title: string; }[] = [
    { label: tr('Widget'), key: 'widget', props: ['size = { 100 100 }'], title: tr('An empty widget: a frame for others') },
    { label: tr('Icon'), key: 'icon', props: ['size = { 48 48 }', 'texture = "gfx/interface/icons/icon_group_of_characters.dds"'], title: tr('A picture') },
    { label: tr('Text'), key: 'text_single', props: ['raw_text = "New text"'], title: tr('One line of text (text_single; `text = KEY` for a localization key)') },
    { label: tr('Text block'), key: 'text_multi', props: ['size = { 300 60 }', 'raw_text = "New text"'], title: tr('Text over several lines (text_multi)') },
    { label: tr('Button'), key: 'button_standard', props: ['size = { 180 40 }', 'raw_text = "Button"'], title: tr('The game’s standard button (button_standard)') },
    { label: tr('Row'), key: 'hbox', props: ['spacing = 5'], title: tr('Lays its children out left to right (hbox)') },
    { label: tr('Column'), key: 'vbox', props: ['spacing = 5'], title: tr('Lays its children out top to bottom (vbox)') },
    { label: tr('Flow'), key: 'flowcontainer', props: ['spacing = 5'], title: tr('Children one after another at their own sizes (flowcontainer)') },
    { label: tr('Spacer'), key: 'expand', props: [], title: tr('Takes the space left over in a row or column (expand)') },
    { label: tr('Scroll box'), key: 'scrollbox', props: ['size = { 300 200 }'], title: tr('A scrolling area (scrollbox)') }
];

/** kinds that place their children themselves: a widget dropped into them gets no `position` */
const PLACING = new Set(['hbox', 'vbox', 'flowcontainer', 'dynamicgridbox', 'fixedgridbox', 'overlappingitembox']);

/** kinds a dropped widget doesn't go into (it goes into their parent) */
const LEAVES = new Set(['icon', 'textbox', 'editbox', 'game_button', 'checkbutton']);

/** A new widget's statement: `key = {` its properties `}` (tabs for its own nesting; guiEdit makes them the file's). */
const snippet = (key: string, props: string[]): string => (props.length ? `${key} = {\n${props.map((p) => '\t' + p).join('\n')}\n}` : `${key} = {}`);

/** the type names for "Type…" (the GUI list, read once) */
let typeNames: string[] | null = null;

/** the toolbar's switches, kept while the app runs */
let drawTextures = true;
let drawOutlines = true;
/** the canvas zoom (1 = the game's pixels); null: fit the stage's width; kept while the app runs */
let canvasZoom: number | null = null;
/** switched-off widgets per definition, kept while the app runs */
const hiddenOf = new Map<string, number[]>();
/** widgets switched on that are hidden by default (alternatives), per definition */
const shownOf = new Map<string, number[]>();
/** sample texts typed for bound texts, per definition (widget id → text), and the rows of bound lists, while the app runs */
const samplesOf = new Map<string, Record<number, string>>();
let listRows = 3;

export function GuiPreview(props: { kind: GuiKind; name: string; reloadKey: string; }): React.JSX.Element
{
    const key = props.kind + ':' + props.name;
    const [hidden, setHidden] = useState<number[]>(hiddenOf.get(key) ?? []);
    const [shown, setShown] = useState<number[]>(shownOf.get(key) ?? []);
    const [view, setView] = useState<{ key: string; v: GuiLayoutView | null; } | null>(null);
    const [sel, setSel] = useState<number | null>(null);
    const [hover, setHover] = useState<number | null>(null);
    // (bumped after an edit: the layout is asked again; the GUI library was read again by the refresh)
    const [edits, setEdits] = useState(0);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<EditMsg | null>(null);
    // (a widget just added: selected once the layout has it, by where it is written)
    const [pending, setPending] = useState<{ rel: string; line: number; } | null>(null);
    const [types, setTypes] = useState<string[]>(typeNames ?? []);
    const [typeName, setTypeName] = useState('');
    const [zoom, setZoom] = useState<number | null>(canvasZoom);
    // (the stage's scroll: the minimap's frame follows it)
    const [scroll, setScroll] = useState({ x: 0, y: 0, w: 0, h: 0 });
    const [textures, setTextures] = useState(drawTextures);
    const [outlines, setOutlines] = useState(drawOutlines);
    const [samples, setSamples] = useState<Record<number, string>>(samplesOf.get(key) ?? {});
    const [rows, setRows] = useState(listRows);
    const stage = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(800);

    useEffect(() =>
    {
        setHidden(hiddenOf.get(key) ?? []);
        setShown(shownOf.get(key) ?? []);
        setSamples(samplesOf.get(key) ?? {});
        setSel(null);
    }, [key]);

    useEffect(() => setMsg(null), [sel]);

    useEffect(() =>
    {
        if (typeNames)
            return;

        void api.guiList().then((l) => setTypes(typeNames = [...new Set(l.filter((i) => i.kind === 'type').map((i) => i.name))].sort()));
    }, []);

    useEffect(() =>
    {
        let cancelled = false;
        void api.guiLayout(props.kind, props.name, hidden, { samples, rows, shown }).then((v) => !cancelled && setView({ key: key + '|' + hidden.join(',') + '|' + shown.join(','), v }));
        return () =>
        {
            cancelled = true;
        };
    }, [key, hidden.join(','), shown.join(','), props.reloadKey, edits, JSON.stringify(samples), rows]);

    const wheel = useRef<((e: WheelEvent) => void) | null>(null);

    useEffect(() =>
    {
        const el = stage.current;

        if (!el)
            return;

        const on = (e: WheelEvent): void => wheel.current?.(e);
        el.addEventListener('wheel', on, { passive: false });
        return () => el.removeEventListener('wheel', on);
    }, [view !== null]);

    useLayoutEffect(() =>
    {
        const el = stage.current;

        if (!el)
            return;

        const ro = new ResizeObserver(() => setWidth(el.clientWidth));
        ro.observe(el);
        setWidth(el.clientWidth);
        return () => ro.disconnect();
    }, [view !== null]);

    useEffect(() => hook('guiPreview', { loaded: () => view?.key === key + '|' + hidden.join(',') + '|' + shown.join(','), select: (id: number) => setSel(id) }), [view, key, hidden]);

    useEffect(() =>
    {
        if (!pending || !view?.v)
            return;

        const find = (b: GuiBox): GuiBox | undefined => (b.file === pending.rel && b.line === pending.line ? b : b.children.map(find).find((x) => x));
        const hit = find(view.v.root);

        if (hit)
            setSel(hit.id);

        setPending(null);
    }, [view]);

    const byId = useMemo(() =>
    {
        const m = new Map<number, { box: GuiBox; path: GuiBox[]; }>();
        const walk = (b: GuiBox, path: GuiBox[]): void =>
        {
            m.set(b.id, { box: b, path });

            for (const c of b.children)
                walk(c, [...path, b]);
        };

        if (view?.v)
            walk(view.v.root, []);

        return m;
    }, [view]);

    if (!view)
        return <div className="placeholder">{tr('Laying out…')}</div>;

    if (!view.v)
        return <div className="placeholder">{tr('Nothing to lay out.')}</div>;

    const v = view.v;
    loadFonts(v.fonts);
    const pad = 16;
    const fitScale = Math.min(1, (width - 2 * pad) / v.bounds.w);
    const scale = zoom ?? fitScale;
    const zoomTo = (z: number | null): void => setZoom(canvasZoom = z === null ? null : Math.max(0.1, Math.min(3, z)));
    // Ctrl + wheel: zoom around the pointer (the native listener below calls it: it must stop the page's own zoom)
    wheel.current = (e: WheelEvent): void =>
    {
        const el = stage.current;

        if (!e.ctrlKey || !el)
            return;

        e.preventDefault();
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left + el.scrollLeft - pad;
        const py = e.clientY - r.top + el.scrollTop - pad;
        const next = Math.max(0.1, Math.min(3, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        zoomTo(next);
        requestAnimationFrame(() =>
        {
            el.scrollLeft = (px / scale) * next + pad - (e.clientX - r.left);
            el.scrollTop = (py / scale) * next + pad - (e.clientY - r.top);
        });
    };
    // (a widget's switch: on → in `hidden`; off → out of `hidden`, and in `shown` when it is hidden by default)
    const offIds = new Set(v.toggles.filter((t) => t.off).map((t) => t.id));
    const toggle = (id: number): void =>
    {
        const t = v.toggles.find((x) => x.id === id);
        const off = offIds.has(id);
        const nextHidden = off ? hidden.filter((h) => h !== id) : [...hidden, id];
        const nextShown = off && t?.alt ? [...shown, id] : shown.filter((h) => h !== id);
        hiddenOf.set(key, nextHidden);
        shownOf.set(key, nextShown);
        setHidden(nextHidden);
        setShown(nextShown);
    };
    const selected = sel !== null ? byId.get(sel) : undefined;
    /** a change of a widget's statement (the property grid, a drag on the canvas): one undo step */
    const editBox = (box: GuiBox, req: Omit<GuiEditRequest, 'at'>): void => editAt({ rel: box.file, where: box.where, line: box.line, key: box.key, mod: box.mod }, req);
    /** a change of any statement as written: a widget, or one of its property blocks */
    const editAt = (at: GuiEditRequest['at'], req: Omit<GuiEditRequest, 'at'>): void =>
    {
        setBusy(true);
        setMsg(null);
        api.editGui({ at, ...req })
            .then((r: ScriptEditResult) =>
            {
                setMsg(r.notes.length ? { notes: r.notes } : null);

                // (a new or moved widget: selected once laid out, where the edit put it)
                if (req.insert || req.shift || req.moveInto)
                    setPending({ rel: r.rel, line: r.line });

                setEdits((n) => n + 1);
            })
            .catch((e: Error) => setMsg({ error: errorText(e) }))
            .finally(() => setBusy(false));
    };

    /** A widget of the toolbox added: into `target` (the selected widget, else the root), at `at` (game pixels in it) when dropped. */
    const add = (key: string, props: string[], target?: GuiBox, at?: [number, number]): void =>
    {
        const into = target ?? selected?.box ?? v.root;
        const ps = at && !PLACING.has(into.kind) ? [`position = { ${Math.round(at[0])} ${Math.round(at[1])} }`, ...props] : props;
        editBox(into, { insert: snippet(key, ps), label: tr('New {key} in {name}', { key, name: into.name ?? into.key }) });
    };
    const drop = (e: React.DragEvent): void =>
    {
        const tool = e.dataTransfer.getData('text/x-gui-tool');

        if (!tool)
            return;

        e.preventDefault();
        const { key, props: ps } = JSON.parse(tool) as { key: string; props: string[]; };
        const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.classList.contains('gui-box')) as HTMLElement | undefined;
        // (into the nearest widget written in this definition itself (not inside a shared type or template, whose change
        // would reach every use) that holds children: not an icon or a text)
        const found = hit ? byId.get(Number(hit.dataset.id)) : undefined;
        const chain = found ? [...found.path, found.box].reverse() : [];
        const target = chain.find((b) => !b.via?.some((x) => x.startsWith('type ') || x.startsWith('template ')) && !LEAVES.has(b.kind));
        const r = (e.currentTarget as HTMLElement).querySelector('.gui-canvas')!.getBoundingClientRect();
        // (the drop point in game pixels, relative to the target's top left)
        const gx = (e.clientX - r.left - pad) / scale + v.bounds.x;
        const gy = (e.clientY - r.top - pad) / scale + v.bounds.y;
        const t = target ?? v.root;
        add(key, ps, t, [gx - t.x, gy - t.y]);
    };
    const toolProps = (t: { key: string; props: string[]; }): React.HTMLAttributes<HTMLButtonElement> & { draggable: boolean; } => ({
        draggable: true,
        onDragStart: (e) => e.dataTransfer.setData('text/x-gui-tool', JSON.stringify({ key: t.key, props: t.props }))
    });

    return (
        <div className="gui-preview">
            <div className="gui-toolbox">
                <span className="dim" title={tr('Click: into the selected widget (else the window). Drag: onto a widget on the canvas — where it is dropped, unless a row or column places it')}>
                    {tr('Add')}</span>
                {TOOLS.map((t) => (
                    <button key={t.key} className="gui-tool" title={t.title} disabled={busy} onClick={() => add(t.key, t.props)} {...toolProps(t)}>
                        {t.label}
                    </button>
                ))}
                <input
                    className="gui-type-input"
                    list="gui-type-names"
                    placeholder={tr('Type…')}
                    value={typeName}
                    onChange={(e) => setTypeName(e.target.value)}
                    onKeyDown={(e) =>
                    {
                        if (e.key === 'Enter' && types.includes(typeName.trim()))
                        {
                            add(typeName.trim(), []);
                            setTypeName('');
                        }
                    }}
                    title={tr('A type of the game\'s interface files by name (Enter adds it)')}
                />
                <datalist id="gui-type-names">{types.map((t) => <option key={t} value={t} />)}</datalist>
                {selected && <span className="dim">{tr('into {name}', { name: selected.box.name ?? selected.box.key })}</span>}
            </div>
            <div className="gui-preview-bar">
                <span className="dim">
                    {tr('{round}×{round2} · on a {w}×{h} screen, UI scale 100%', { round: Math.round(v.root.w), round2: Math.round(v.root.h), w: v.screen.w, h: v.screen.h })}</span>
                <span className="gap" />
                <label>
                    <input type="checkbox" checked={textures} onChange={(e) => setTextures(drawTextures = e.target.checked)} /> {' '}{tr('Textures')}</label>
                <label>
                    <input type="checkbox" checked={outlines} onChange={(e) => setOutlines(drawOutlines = e.target.checked)} /> {' '}{tr('Outlines')}</label>
                <label title={tr('How many rows a list bound to the game\'s data shows (datamodel + item)')}>
                    {tr('List rows')}<input type="number" className="gui-rows" min={0} max={20} value={rows} onChange={(e) => setRows(listRows = Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
                </label>
                <label className="gui-zoom" title={tr('Zoom (Ctrl + mouse wheel on the canvas)')}>
                    {tr('Zoom')}<Slider min={10} max={300} step={5} value={Math.round(scale * 100)} defaultValue={Math.round(fitScale * 100)} defaultLabel={tr('fit')} onReset={() => zoomTo(null)} onChange={(v) => zoomTo(v / 100)} />
                    <span className="pct">{Math.round(scale * 100)}%</span>
                </label>
                <button className={'gui-kind' + (zoom === null ? ' on' : '')} onClick={() => zoomTo(null)} title={tr('Fit the canvas to the stage\'s width')}>
                    {tr('Fit')}</button>
                <button className={'gui-kind' + (zoom === 1 ? ' on' : '')} onClick={() => zoomTo(1)} title={tr('The game\'s pixels')}>
                    100%
                </button>
            </div>
            <div className="gui-work">
                <div
                    className={'gui-stage' + (textures ? ' tex' : '') + (outlines ? '' : ' no-lines')}
                    ref={stage}
                    onClick={() => setSel(null)}
                    onScroll={(e) =>
                    {
                        const el = e.currentTarget;
                        setScroll({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
                    }}
                    onDragOver={(e) => e.dataTransfer.types.includes('text/x-gui-tool') && e.preventDefault()}
                    onDrop={drop}
                >
                    <div className="gui-canvas" style={{ width: v.bounds.w * scale + 2 * pad, height: v.bounds.h * scale + 2 * pad }}>
                        <div style={{ position: 'absolute', left: pad, top: pad, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
                            <Box b={v.root} ox={v.bounds.x} oy={v.bounds.y} sel={sel} hover={hover} onSel={setSel} onHover={setHover} textures={textures} />
                            {selected && <Handles key={selected.box.id} box={selected.box} ox={v.bounds.x} oy={v.bounds.y} scale={scale} busy={busy} onSel={setSel} onEdit={(req) => editBox(selected.box, req)} onNote={(n) => setMsg({ error: n })} />}
                        </div>
                    </div>
                </div>
                <div className="gui-side">
                    <Minimap root={v.root} bounds={v.bounds} scale={scale} pad={pad} scroll={scroll} stage={stage} />
                    <WidgetTree
                        root={v.root}
                        sel={sel}
                        path={selected?.path ?? []}
                        busy={busy}
                        onSel={setSel}
                        isInside={(a, b) => !!byId.get(b)?.path.some((p) => p.id === a)}
                        onEdit={(box, req, then) =>
                        {
                            editBox(box, req);

                            if (then)
                                setPending(then);
                        }}
                        onNote={(n) => setMsg({ error: n })}
                    />
                </div>
            </div>
            {selected && (
                <BoxInfo
                    box={selected.box}
                    path={selected.path}
                    onSel={setSel}
                    hidden={offIds.has(selected.box.id)}
                    toggle={toggle}
                    busy={busy}
                    msg={msg}
                    run={(req) => editBox(selected.box, req)}
                    runAt={editAt}
                    sample={samples[selected.box.id]}
                    onSample={(text) =>
                    {
                        const next = { ...samples };

                        if (text === undefined)
                            delete next[selected.box.id];
                        else
                            next[selected.box.id] = text;

                        samplesOf.set(key, next);
                        setSamples(next);
                    }}
                />
            )}
            {v.toggles.length > 0 && (
                <section className="gui-section">
                    <h3>
                        {tr('Shown by the game’s data')}{' '}<span className="n">{v.toggles.length}</span>
                    </h3>
                    <div className="gui-toggles">
                        {v.toggles.map((t) => (
                            <label key={t.id} title={`${t.file}:${t.line}\nvisible = ${t.visible}`} className={sel === t.id ? 'on' : undefined}>
                                <input type="checkbox" checked={!t.off} onChange={() => toggle(t.id)} />
                                <span className="name" onClick={(e) => (e.preventDefault(), setSel(t.id))}>{t.label}</span>
                                <code>{t.visible.replace(/^\[|\]$/g, '')}</code>
                            </label>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function Box(props: { b: GuiBox; ox: number; oy: number; sel: number | null; hover: number | null; onSel: (id: number) => void; onHover: (id: number | null) => void; textures: boolean; }): React.JSX.Element
{
    const { b } = props;
    const cls = ['gui-box', 'k-' + b.kind];

    if (props.sel === b.id)
        cls.push('sel');

    if (props.hover === b.id)
        cls.push('hover');

    if (b.sample)
        cls.push('sample');

    return (
        <div
            className={cls.join(' ')}
            data-id={b.id}
            style={{ left: b.x - props.ox, top: b.y - props.oy, width: Math.max(1, b.w), height: Math.max(1, b.h), overflow: b.clip ? 'hidden' : undefined }}
            onClick={(e) =>
            {
                e.stopPropagation();
                props.onSel(b.id);
            }}
            onMouseOver={(e) =>
            {
                e.stopPropagation();
                props.onHover(b.id);
            }}
            onMouseOut={() => props.onHover(null)}
            title={`${b.name ? b.name + ' · ' : ''}${b.key}${b.key !== b.kind ? ' (' + b.kind + ')' : ''}: ${Math.round(b.w)}×${Math.round(b.h)}`}
        >
            {props.textures && b.paint?.map((p, i) => <Paint key={i} p={p} />)}
            {b.text !== undefined && <span className={'gui-text' + (props.textures && b.textStyle ? ' set' : '')} style={props.textures && b.textStyle ? textCss(b.textStyle) : undefined}>{props.textures && b.runs ? <Runs runs={b.runs} size={b.textStyle?.size ?? 14} /> : b.text}</span>}
            {b.children.map((c, i) => <Box key={c.id + ':' + i} {...props} b={c} ox={b.x} oy={b.y} />)}
        </div>
    );
}

/** the game's fonts loaded into the page (FontFace, family `ck3-<name>`), once per name */
const loadedFonts = new Set<string>();

function loadFonts(fonts: Record<string, GuiFontFiles>): void
{
    for (const [name, files] of Object.entries(fonts))
    {
        if (loadedFonts.has(name))
            continue;

        loadedFonts.add(name);
        const faces: [string | undefined, FontFaceDescriptors][] = [
            [files.regular, {}],
            [files.bold, { weight: 'bold' }],
            [files.italic, { style: 'italic' }],
            [files.boldItalic, { weight: 'bold', style: 'italic' }]
        ];

        for (const [file, desc] of faces)
            if (file)
            {
                const face = new FontFace('ck3-' + name, `url("ck3://font/${file.split('/').map(encodeURIComponent).join('/')}")`, desc);
                document.fonts.add(face);
                void face.load().catch(() => undefined);
            }
    }
}

/** A text's runs: each in its format's colour and style, text icons as pictures a line high. */
function Runs(props: { runs: GuiRun[]; size: number; }): React.JSX.Element
{
    return (
        <span className="gui-runs">
            {props.runs.map((r, i) =>
                r.icon ?
                    <img key={i} className="gui-texticon" src={imgUrl(r.icon, Math.ceil(props.size * 2))} style={{ height: props.size * 1.3 }} draggable={false} /> :
                    (
                        <span
                            key={i}
                            style={{
                                color: r.color ? `rgb(${r.color.map((x) => Math.round(x * 255)).join(',')})` : undefined,
                                fontStyle: r.italic ? 'italic' : undefined,
                                fontWeight: r.bold ? 'bold' : undefined
                            }}
                        >
                            {r.t}
                        </span>
                    )
            )}
        </span>
    );
}

/** A text set as the game would: its font, size, colour, alignment (`align`: left / center / right, top or the middle). */
function textCss(t: GuiTextStyle): React.CSSProperties
{
    // `align = center|nobaseline`: the parts, across (left / center / right) and down (top / vcenter / bottom)
    const parts = (t.align ?? '').toLowerCase().split('|');
    const h = parts.includes('center') || parts.includes('hcenter') ? 'center' : parts.includes('right') ? 'right' : 'left';
    const v = parts.includes('top') ? 'top' : parts.includes('bottom') ? 'bottom' : parts.includes('vcenter') || parts.includes('center') ? 'middle' : undefined;
    const c = t.color ?? [0.61, 0.6, 0.56];
    return {
        fontFamily: `"ck3-${t.font ?? 'StandardGameFont'}", serif`,
        fontSize: t.size,
        color: `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`,
        fontStyle: t.italic ? 'italic' : undefined,
        fontWeight: t.bold ? 'bold' : undefined,
        justifyContent: h === 'center' ? 'center' : h === 'right' ? 'flex-end' : 'flex-start',
        textAlign: h,
        // (a multiline text from the top unless its align says otherwise)
        alignItems: v === 'top' || (t.multiline && !v) ? 'flex-start' : v === 'bottom' ? 'flex-end' : 'center',
        whiteSpace: t.multiline ? 'pre-wrap' : 'nowrap',
        padding: t.pad ? t.pad.map((x) => x + 'px').join(' ') : undefined,
        // (elide: cut with …; the runs' span is the one that overflows)
        overflow: t.elide ? 'hidden' : 'visible'
    };
}

/** One texture of a widget: nine-slice, a frame of a sheet, or the picture fitted into the rectangle. */
function Paint(props: { p: GuiPaint; }): React.JSX.Element
{
    const { p } = props;
    const [natural, setNatural] = useState<{ w: number; h: number; } | null>(null);
    const frameUrl = useFrameUrl(p);
    const fid = 'tint' + useId().replace(/[^\w]/g, '');
    const style: React.CSSProperties = { left: p.x, top: p.y, width: Math.max(0, p.w), height: Math.max(0, p.h), opacity: p.alpha };

    if (p.mirror)
        style.transform = `scale(${p.mirror.includes('horizontal') ? -1 : 1}, ${p.mirror.includes('vertical') ? -1 : 1})`;

    // stand-ins for what the game draws from its data
    if (p.stand === 'portrait')
        return <div className="gui-paint gui-portrait" style={style} title={tr('A character\'s portrait (from the game\'s data)')} />;

    if (p.stand === 'coa')
        return <div className="gui-paint gui-coa" style={{ ...style, ...(p.mask ? { maskImage: `url("${imgUrl(p.mask)}")`, maskSize: '100% 100%' } : {}) }} title={tr('A coat of arms (from the game\'s data)')} />;

    if (!p.texture)
        return <div className="gui-paint bound" style={style} title={p.bound} />;

    // a progressbar's progress: the bar drawn whole, shown up to its share
    if (p.fill)
    {
        const { part, vertical } = p.fill;
        const outer: React.CSSProperties = vertical ?
            { left: p.x, top: p.y + p.h * (1 - part), width: p.w, height: p.h * part } :
            { left: p.x, top: p.y, width: p.w * part, height: p.h };
        return (
            <div className="gui-paint" style={{ ...outer, overflow: 'hidden' }}>
                <Paint p={{ ...p, fill: undefined, x: 0, y: vertical ? -p.h * (1 - part) : 0 }} />
            </div>
        );
    }

    const url = imgUrl(p.texture);
    const d = p.density ?? 1;
    // `color` / `tintcolor` multiplies the texture: an SVG colour matrix
    let defs: React.JSX.Element | null = null;

    if (p.color)
    {
        const [r, g, b, a] = p.color;
        style.filter = `url(#${fid})`;
        defs = (
            <svg className="gui-defs" aria-hidden>
                <filter id={fid} colorInterpolationFilters="sRGB">
                    <feColorMatrix type="matrix" values={`${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 ${a} 0`} />
                </filter>
            </svg>
        );
    }

    // alphamultiply masks: a nine-slice one as the mask's border image, the others stretched over the rectangle
    const nine = p.masks?.find((m) => m.sprite && m.border);

    if (nine)
    {
        const [l, t, r, b] = nine.border!;
        const md = nine.density ?? 1;
        style.WebkitMaskBoxImage = `url("${imgUrl(nine.texture)}") ${t} ${r} ${b} ${l} fill / ${t / md}px ${r / md}px ${b / md}px ${l / md}px ${nine.sprite === 'tiled' ? 'round' : 'stretch'}`;
    }

    const plain = p.masks?.filter((m) => m !== nine) ?? [];

    if (plain.length)
    {
        style.maskImage = plain.map((m) => `url("${imgUrl(m.texture)}")`).join(', ');
        style.maskSize = '100% 100%';
        style.maskRepeat = 'no-repeat';
        style.maskComposite = 'intersect';
    }

    return (
        <Fragment>
            {defs}
            {paintElement(p, url, d, style, natural, setNatural, frameUrl)}
        </Fragment>
    );
}

/** frames cut out of their sheets (a data URL per sheet and frame), for nine-slicing one frame */
const frameCache = new Map<string, Promise<string | null>>();
// (a sheet an index update changed is cut again)
onIndexChange((files) =>
{
    if (!files || files.some((f) => /^gfx\//i.test(f)))
        frameCache.clear();
});

/**
 * A nine-sliced frame of a sheet (`framesize` + `spriteType = Cornered…`, e.g. editor_button.dds: 16×16 frames, 4 px
 * borders): `border-image` can't take a part of an image, so the frame is cut out on a canvas first. null until then.
 */
function useFrameUrl(p: GuiPaint): string | null
{
    const key = p.texture && p.frame && p.sprite && p.border ? `${p.texture}|${p.frame.w}|${p.frame.h}|${p.frame.n}` : '';
    const [got, setGot] = useState<{ key: string; url: string | null; } | null>(null);

    useEffect(() =>
    {
        if (!key)
            return;

        let job = frameCache.get(key);

        if (!job)
        {
            const f = p.frame!;
            job = new Promise<string | null>((resolve) =>
            {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () =>
                {
                    const cols = Math.max(1, Math.floor(img.naturalWidth / f.w));
                    const k = f.n - 1;
                    const c = document.createElement('canvas');
                    c.width = f.w;
                    c.height = f.h;
                    c.getContext('2d')!.drawImage(img, (k % cols) * f.w, Math.floor(k / cols) * f.h, f.w, f.h, 0, 0, f.w, f.h);
                    resolve(c.toDataURL());
                };
                img.onerror = () => resolve(null);
                img.src = imgUrl(p.texture!);
            });
            frameCache.set(key, job);
        }

        let cancelled = false;
        void job.then((url) => !cancelled && setGot({ key, url }));
        return () =>
        {
            cancelled = true;
        };
    }, [key]);

    return got?.key === key ? got.url : null;
}

function paintElement(p: GuiPaint, url: string, d: number, style: React.CSSProperties, natural: { w: number; h: number; } | null, setNatural: (n: { w: number; h: number; }) => void, frameUrl: string | null): React.JSX.Element
{
    // a nine-sliced frame: drawn once it is cut out of its sheet
    if (p.sprite && p.border && p.frame && !frameUrl)
        return <div className="gui-paint" style={style} />;

    // nine-slice: the corners at their size (texels / density), the edges and the middle tiled or stretched
    if (p.sprite && p.border)
    {
        const [l, t, r, b] = p.border;
        url = frameUrl ?? url;
        return (
            <div
                className="gui-paint"
                style={{
                    ...style,
                    boxSizing: 'border-box',
                    borderStyle: 'solid',
                    borderColor: 'transparent',
                    borderWidth: `${t / d}px ${r / d}px ${b / d}px ${l / d}px`,
                    borderImageSource: `url("${url}")`,
                    borderImageSlice: tr('{t} {r} {b} {l} fill', { t, r, b, l }),
                    borderImageRepeat: p.sprite === 'tiled' ? 'round' : 'stretch'
                }}
            />
        );
    }

    // a frame of a sheet: the sheet scaled so one frame fills the rectangle, shifted to the frame (left to right, then down)
    if (p.frame)
    {
        const cols = natural ? Math.max(1, Math.floor(natural.w / p.frame.w)) : 1;
        const k = p.frame.n - 1;
        const sx = p.w / p.frame.w;
        const sy = p.h / p.frame.h;
        return (
            <div className="gui-paint" style={{ ...style, overflow: 'hidden' }}>
                <img
                    src={url}
                    draggable={false}
                    onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        transformOrigin: '0 0',
                        transform: `scale(${sx}, ${sy}) translate(${-(k % cols) * p.frame.w}px, ${-Math.floor(k / cols) * p.frame.h}px)`,
                        visibility: natural ? undefined : 'hidden'
                    }}
                />
            </div>
        );
    }

    return <img className="gui-paint" src={url} draggable={false} style={{ ...style, objectFit: p.fit === 'centercrop' ? 'cover' : p.fit === 'fit' ? 'contain' : 'fill' }} />;
}

interface EditMsg
{
    error?: string;
    notes?: string[];
}

/**
 * The selected widget's frame on the canvas: its body drags it (→ `position`; not in a box that places its children, nor
 * with a bound position), its eight handles resize it (→ `size`, and `position` where its widgetanchor would move the
 * opposite edge). One undo step per drag. A click without a drag selects what lies under the pointer.
 */
function Handles(props: { box: GuiBox; ox: number; oy: number; scale: number; busy: boolean; onSel: (id: number) => void; onEdit: (req: Omit<GuiEditRequest, 'at'>) => void; onNote: (note: string) => void; }): React.JSX.Element
{
    const { box: b } = props;
    const pl = b.place;
    const canMove = !!pl && !pl.inBox && !!pl.pos;
    const canSize = !!pl && !pl.boundSize;
    const [drag, setDrag] = useState<{ mode: string; dx: number; dy: number; } | null>(null);

    /** the frame after a drag of (dx, dy) game pixels */
    const geometry = (mode: string, dx: number, dy: number): { x: number; y: number; w: number; h: number; } =>
    {
        if (mode === 'move')
            return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };

        let { x, y, w, h } = b;

        if (mode.includes('e'))
            w = Math.max(1, w + dx);

        if (mode.includes('w'))
        {
            const d = Math.min(dx, w - 1);
            x += d;
            w -= d;
        }

        if (mode.includes('s'))
            h = Math.max(1, h + dy);

        if (mode.includes('n'))
        {
            const d = Math.min(dy, h - 1);
            y += d;
            h -= d;
        }

        return { x, y, w, h };
    };

    const commit = (mode: string, dx: number, dy: number): void =>
    {
        if (!pl)
            return;

        if (mode === 'move')
        {
            props.onEdit({ set: { key: 'position', value: `{ ${pl.pos![0] + dx} ${pl.pos![1] + dy} }` }, label: tr('Moved {name} by {dx}, {dy}', { name: b.name ?? b.key, dx, dy }) });
            return;
        }

        const g = geometry(mode, dx, dy);
        const req: Omit<GuiEditRequest, 'at'> = { set: { key: 'size', value: `{ ${Math.round(g.w)} ${Math.round(g.h)} }` }, label: tr('Resized {name} to {round}×{round2}', { name: b.name ?? b.key, round: Math.round(g.w), round2: Math.round(g.h) }) };

        // x = anchor + position − widgetanchor·w: the edge not dragged stays where it is
        if (!pl.inBox && pl.pos)
        {
            const [wx, wy] = pl.wa;
            const px = pl.pos[0] + (mode.includes('w') ? (g.x - b.x) * (1 - wx) : 0) + (mode.includes('e') ? wx * (g.w - b.w) : 0);
            const py = pl.pos[1] + (mode.includes('n') ? (g.y - b.y) * (1 - wy) : 0) + (mode.includes('s') ? wy * (g.h - b.h) : 0);
            const rx = Math.round(px);
            const ry = Math.round(py);

            if (rx !== pl.pos[0] || ry !== pl.pos[1])
                req.also = [{ set: { key: 'position', value: `{ ${rx} ${ry} }` } }];
        }

        props.onEdit(req);
    };

    const start = (mode: string) => (e: React.MouseEvent): void =>
    {
        e.stopPropagation();
        e.preventDefault();

        if (props.busy)
            return;

        const x0 = e.clientX;
        const y0 = e.clientY;
        const delta = (ev: MouseEvent): [number, number] => [Math.round((ev.clientX - x0) / props.scale), Math.round((ev.clientY - y0) / props.scale)];
        const move = (ev: MouseEvent): void =>
        {
            const [dx, dy] = delta(ev);

            if (mode !== 'move' || canMove)
                setDrag({ mode, dx, dy });
        };
        const up = (ev: MouseEvent): void =>
        {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            setDrag(null);
            const [dx, dy] = delta(ev);

            if (!dx && !dy)
            {
                // a click: the widget under the pointer (the frame itself let through)
                if (mode === 'move')
                {
                    const hit = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el instanceof HTMLElement && el.classList.contains('gui-box'));
                    const id = hit ? Number((hit as HTMLElement).dataset.id) : NaN;

                    if (Number.isFinite(id) && id !== b.id)
                        props.onSel(id);
                }

                return;
            }

            if (mode === 'move' && !canMove)
            {
                props.onNote(pl?.inBox ? tr('{name} is placed by its parent (a box lays out its children: position does nothing there) — reorder it in the widget tree.', { name: b.name ?? b.key }) : tr('{name}’s position comes from the game’s data.', { name: b.name ?? b.key }));
                return;
            }

            commit(mode, dx, dy);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };

    const g = drag ? geometry(drag.mode, drag.dx, drag.dy) : b;
    const handles = canSize ? ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] : [];
    return (
        <div
            className={'gui-handles' + (canMove ? ' movable' : '') + (drag ? ' dragging' : '')}
            style={{ left: g.x - props.ox, top: g.y - props.oy, width: Math.max(1, g.w), height: Math.max(1, g.h) }}
            onMouseDown={start('move')}
            onClick={(e) => e.stopPropagation()}
        >
            {handles.map((h) => <span key={h} className={'gui-handle h-' + h} style={{ transform: `scale(${1 / props.scale})` }} onMouseDown={start(h)} />)}
            {drag && <span className="gui-drag-size" style={{ transform: `scale(${1 / props.scale})` }}>{drag.mode === 'move' ? `${drag.dx >= 0 ? '+' : ''}${drag.dx}, ${drag.dy >= 0 ? '+' : ''}${drag.dy}` : `${Math.round(g.w)}×${Math.round(g.h)}`}</span>}
        </div>
    );
}

/**
 * The minimap: the whole definition in small (its boxes as rectangles: windows, pictures and texts in their own shades),
 * the part the stage shows framed; a click or a drag moves the stage there.
 */
function Minimap(props: { root: GuiBox; bounds: { x: number; y: number; w: number; h: number; }; scale: number; pad: number; scroll: { x: number; y: number; w: number; h: number; }; stage: React.RefObject<HTMLDivElement | null>; }): React.JSX.Element
{
    const canvas = useRef<HTMLCanvasElement>(null);
    const { bounds } = props;
    const W = 260;
    const m = Math.min(W / bounds.w, 180 / bounds.h);
    const cw = Math.max(1, Math.round(bounds.w * m));
    const ch = Math.max(1, Math.round(bounds.h * m));

    useEffect(() =>
    {
        const g = canvas.current?.getContext('2d');

        if (!g)
            return;

        g.clearRect(0, 0, cw, ch);
        const walk = (b: GuiBox, depth: number): void =>
        {
            const x = (b.x - bounds.x) * m;
            const y = (b.y - bounds.y) * m;
            const w = b.w * m;
            const h = b.h * m;

            if (b.kind === 'window')
            {
                g.fillStyle = 'rgba(40, 44, 54, 0.95)';
                g.fillRect(x, y, w, h);
            }
            else if (b.paint?.length || b.kind === 'icon')
            {
                g.fillStyle = 'rgba(201, 164, 92, 0.22)';
                g.fillRect(x, y, w, h);
            }
            else if (b.text !== undefined)
            {
                g.fillStyle = 'rgba(200, 220, 200, 0.35)';
                g.fillRect(x, y + h * 0.3, w, Math.max(1, h * 0.4));
            }

            if (depth < 3 && w > 3 && h > 3)
            {
                g.strokeStyle = 'rgba(201, 164, 92, 0.45)';
                g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            }

            for (const c of b.children)
                walk(c, depth + 1);
        };
        walk(props.root, 0);
    }, [props.root, bounds, cw, ch]);

    // the stage's visible part, in game pixels
    const vx = (props.scroll.x - props.pad) / props.scale;
    const vy = (props.scroll.y - props.pad) / props.scale;
    const el = props.stage.current;
    const vw = (props.scroll.w || el?.clientWidth || 0) / props.scale;
    const vh = (props.scroll.h || el?.clientHeight || 0) / props.scale;
    const goTo = (e: React.MouseEvent): void =>
    {
        const st = props.stage.current;

        if (!st)
            return;

        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        // (the point clicked in the middle of the stage)
        const gx = (e.clientX - r.left) / m;
        const gy = (e.clientY - r.top) / m;
        st.scrollLeft = gx * props.scale + props.pad - st.clientWidth / 2;
        st.scrollTop = gy * props.scale + props.pad - st.clientHeight / 2;
    };
    return (
        <div className="gui-minimap" title={tr('The whole window: click or drag to move the stage there')}>
            <div
                className="frame-host"
                style={{ width: cw, height: ch }}
                onMouseDown={(e) =>
                {
                    goTo(e);
                    const host = e.currentTarget;
                    const move = (ev: MouseEvent): void => goTo({ clientX: ev.clientX, clientY: ev.clientY, currentTarget: host } as unknown as React.MouseEvent);
                    const up = (): void =>
                    {
                        window.removeEventListener('mousemove', move);
                        window.removeEventListener('mouseup', up);
                    };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                }}
            >
                <canvas ref={canvas} width={cw} height={ch} />
                <div className="view" style={{ left: Math.max(0, vx * m), top: Math.max(0, vy * m), width: Math.min(cw, vw * m), height: Math.min(ch, vh * m) }} />
            </div>
        </div>
    );
}

/** a box written inside a shared type or template (a change there reaches every use) */
const sharedOf = (b: GuiBox): string | undefined => b.via?.find((v) => v.startsWith('type ') || v.startsWith('template '));

/**
 * The widget tree (stage 3): every widget of the definition as laid out, folded below the second level (the selected
 * widget's ancestors open). The selected row moves up / down among its siblings or is deleted; a row dragged onto another
 * moves into it (same file). Widgets from shared types and templates are shown in italics.
 */
function WidgetTree(
    props: { root: GuiBox; sel: number | null; path: GuiBox[]; busy: boolean; onSel: (id: number) => void; isInside: (a: number, b: number) => boolean; onEdit: (box: GuiBox, req: Omit<GuiEditRequest, 'at'>, then?: { rel: string; line: number; }) => void; onNote: (note: string) => void; }
): React.JSX.Element
{
    const [open, setOpen] = useState<Set<number>>(() => new Set());
    const [dragId, setDragId] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const boxes = useMemo(() =>
    {
        const m = new Map<number, GuiBox>();
        const walk = (b: GuiBox): void =>
        {
            m.set(b.id, b);
            b.children.forEach(walk);
        };
        walk(props.root);
        return m;
    }, [props.root]);

    // (the selected widget's ancestors open, and the row in view)
    useEffect(() =>
    {
        if (props.sel === null)
            return;

        setOpen((o) => new Set([...o, ...props.path.map((p) => p.id)]));
        requestAnimationFrame(() => document.querySelector('.gui-tree-row.sel')?.scrollIntoView({ block: 'nearest' }));
    }, [props.sel]);

    const drop = (target: GuiBox): void =>
    {
        const src = dragId !== null ? boxes.get(dragId) : undefined;
        setDragId(null);
        setOver(null);

        if (!src || src.id === target.id)
            return;

        if (src.file !== target.file)
            props.onNote(tr('{name} is written in {file}, {name2} in {file2}: a widget moves within its own file only.', { name: src.name ?? src.key, file: src.file, name2: target.name ?? target.key, file2: target.file }));
        else if (props.isInside(src.id, target.id))
            props.onNote(tr('{name} can\'t go into one of its own widgets.', { name: src.name ?? src.key }));
        else
            props.onEdit(src, { moveInto: { line: target.line, key: target.key }, label: tr('Moved {name} into {name2}', { name: src.name ?? src.key, name2: target.name ?? target.key }) }, { rel: src.file, line: -1 });
    };

    const rows: React.JSX.Element[] = [];
    const walk = (b: GuiBox, depth: number): void =>
    {
        const isOpen = depth < 2 ? !open.has(-b.id - 1) : open.has(b.id);
        const shared = sharedOf(b);
        const selected = props.sel === b.id;
        rows.push(
            <div
                key={rows.length}
                className={'gui-tree-row' + (selected ? ' sel' : '') + (shared ? ' shared' : '') + (over === b.id ? ' over' : '')}
                style={{ paddingLeft: 4 + depth * 12 }}
                draggable={!props.busy}
                onDragStart={(e) =>
                {
                    e.dataTransfer.setData('text/x-gui-widget', String(b.id));
                    setDragId(b.id);
                }}
                onDragOver={(e) =>
                {
                    if (dragId !== null)
                    {
                        e.preventDefault();
                        setOver(b.id);
                    }
                }}
                onDragLeave={() => setOver((o) => (o === b.id ? null : o))}
                onDrop={(e) =>
                {
                    e.preventDefault();
                    drop(b);
                }}
                onClick={() => props.onSel(b.id)}
                title={`${b.key}${b.key !== b.kind ? ' (' + b.kind + ')' : ''}\n${b.file}:${b.line}${shared ? tr('\nwritten in ') + shared : ''}`}
            >
                <span
                    className="tw"
                    onClick={(e) =>
                    {
                        e.stopPropagation();
                        setOpen((o) =>
                        {
                            const n = new Set(o);
                            // (the first two levels are open unless closed: their key is negative)
                            const k = depth < 2 ? -b.id - 1 : b.id;
                            n.has(k) ? n.delete(k) : n.add(k);
                            return n;
                        });
                    }}
                >
                    {b.children.length ? (isOpen ? '▾' : '▸') : ' '}
                </span>
                <span className="nm">{b.name ?? b.key}</span>
                {b.name && <span className="kd">{b.key}</span>}
                {selected && depth > 0 && (
                    <span className="ops" onClick={(e) => e.stopPropagation()}>
                        <button disabled={props.busy} title={tr('Before the widget above it')} onClick={() => props.onEdit(b, { shift: -1, label: tr('Moved {name} up', { name: b.name ?? b.key }) }, { rel: b.file, line: -1 })}>↑</button>
                        <button disabled={props.busy} title={tr('After the widget below it')} onClick={() => props.onEdit(b, { shift: 1, label: tr('Moved {name} down', { name: b.name ?? b.key }) }, { rel: b.file, line: -1 })}>↓</button>
                        <button disabled={props.busy} title={tr('Delete it (with what is in it)')} onClick={() => props.onEdit(b, { delete: true, label: tr('Deleted {name}', { name: b.name ?? b.key }) })}>✕</button>
                    </span>
                )}
            </div>
        );

        if (isOpen)
        {
            for (const c of b.children)
                walk(c, depth + 1);
        }
    };
    walk(props.root, 0);
    return (
        <div className="gui-tree">
            <div className="gui-tree-head">{tr('Widgets')}</div>
            {rows}
        </div>
    );
}

/** "＋ property": a key and a value, Enter adds them (Esc closes). */
function AddProp(props: { busy: boolean; onAdd: (key: string, value: string) => void; label?: string; }): React.JSX.Element
{
    const [adding, setAdding] = useState<{ key: string; value: string; } | null>(null);
    return adding ?
        (
            <div className="gui-prop adding">
                <input className="k" autoFocus placeholder="property" value={adding.key} onChange={(e) => setAdding({ ...adding, key: e.target.value })} />
                <input
                    className="v"
                    placeholder="value"
                    value={adding.value}
                    onChange={(e) => setAdding({ ...adding, value: e.target.value })}
                    onKeyDown={(e) =>
                    {
                        if (e.key === 'Enter' && adding.key.trim() && adding.value.trim())
                        {
                            props.onAdd(adding.key.trim(), adding.value);
                            setAdding(null);
                        }
                        else if (e.key === 'Escape')
                            setAdding(null);
                    }}
                />
                <span className="dim">{tr('Enter adds it')}</span>
            </div>
        ) :
        (
            <button className="gui-add" disabled={props.busy} onClick={() => setAdding({ key: '', value: '' })}>
                {props.label ?? tr('＋ property')}
            </button>
        );
}

/** new property blocks: what a new one starts with (tabs for its nesting) */
const NEW_BLOCKS: Record<string, string> = {
    background: 'background = {\n\ttexture = "gfx/interface/skinned/tile_window_background.dds"\n\tspriteType = Corneredtiled\n\tspriteborder = { 18 18 }\n}',
    state: 'state = {\n\tname = _show\n\tduration = 0.2\n\talpha = 1\n}',
    modify_texture: 'modify_texture = {\n\ttexture = "gfx/interface/component_masks/mask_rough_edges.dds"\n\tblend_mode = alphamultiply\n}'
};

/**
 * A property block (`background`, `state`, a background's `modify_texture` …) where it is written: its properties
 * changed, removed or added there, its inner blocks, the block deleted. A block from a shared type or template is
 * changed in that definition (every use of it).
 */
function BlockEditor(props: { b: GuiBlock; busy: boolean; runAt: (at: GuiEditRequest['at'], req: Omit<GuiEditRequest, 'at'>) => void; }): React.JSX.Element
{
    const { b } = props;
    const [open, setOpen] = useState(b.own);
    const at: GuiEditRequest['at'] = { rel: b.file, where: b.where, line: b.line, key: b.key, mod: b.mod };
    const run = (req: Omit<GuiEditRequest, 'at'>): void => props.runAt(at, req);
    return (
        <div className={'gui-block' + (b.own ? ' own' : '')}>
            <div className="gui-block-head" onClick={() => setOpen(!open)}>
                <span className="tw">{open ? '▾' : '▸'}</span>
                <b>{b.key}</b>
                {b.name && <span className="nm">{b.name}</span>}
                <span className="dim">{b.own ? `${b.file}:${b.line}` : tr('from {from} — a change applies wherever it is used', { from: b.from })}</span>
                <button
                    className="x"
                    disabled={props.busy}
                    title={tr('Delete the block')}
                    onClick={(e) =>
                    {
                        e.stopPropagation();
                        run({ delete: true, label: tr('Deleted {key}{named}', { key: b.key, named: b.name ? ' ' + b.name : '' }) });
                    }}
                >
                    ✕
                </button>
            </div>
            {open && (
                <div className="gui-block-body">
                    {b.props.map((p, i) => <PropRow key={p.key + ':' + i + ':' + p.value} p={p} busy={props.busy} onSet={(v) => run({ set: { key: p.key, value: v } })} onRemove={() => run({ remove: p.key })} />)}
                    <AddProp busy={props.busy} onAdd={(key, value) => run({ set: { key, value } })} />
                    {b.blocks.map((c) => <BlockEditor key={c.file + ':' + c.line + ':' + c.key} b={c} busy={props.busy} runAt={props.runAt} />)}
                    {b.key === 'background' && (
                        <button className="gui-add" disabled={props.busy} onClick={() => run({ insert: NEW_BLOCKS.modify_texture, label: tr('New modify_texture') })}>
                            ＋ modify_texture
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** A bound text's sample (stage 4): what the preview shows for it, typed here, Enter keeps it, empty goes back to the guessed one. */
function SampleRow(props: { box: GuiBox; sample?: string; onSample: (text: string | undefined) => void; }): React.JSX.Element
{
    const [v, setV] = useState(props.sample ?? props.box.text ?? '');

    useEffect(() => setV(props.sample ?? props.box.text ?? ''), [props.box.id, props.sample]);

    return (
        <label className="gui-sample" title={tr('The game fills this text from {bound} — a sample shows here (only in the preview, nothing is written)', { bound: props.box.bound })}>
            {tr('sample text')}<input
                value={v}
                onChange={(e) => setV(e.target.value)}
                onKeyDown={(e) =>
                {
                    if (e.key === 'Enter')
                        props.onSample(v.trim() ? v : undefined);
                    else if (e.key === 'Escape')
                        setV(props.sample ?? props.box.text ?? '');
                }}
            />
            {props.sample !== undefined && <button onClick={() => props.onSample(undefined)} title={tr('Back to the guessed sample')}>↺</button>}
        </label>
    );
}

function BoxInfo(
    props: {
        box: GuiBox;
        path: GuiBox[];
        onSel: (id: number) => void;
        hidden: boolean;
        toggle: (id: number) => void;
        busy: boolean;
        msg: EditMsg | null;
        run: (req: Omit<GuiEditRequest, 'at'>) => void;
        runAt: (at: GuiEditRequest['at'], req: Omit<GuiEditRequest, 'at'>) => void;
        sample?: string;
        onSample: (text: string | undefined) => void;
    }
): React.JSX.Element
{
    const { box, busy, msg, run } = props;
    // (the widget is written inside a type or template: a change there changes every use of it)
    const shared = box.via?.find((v) => v.startsWith('type ') || v.startsWith('template '));
    return (
        <section className="gui-section gui-box-info">
            <div className="crumbs">
                {props.path.map((p) => (
                    <a key={p.id} onClick={() => props.onSel(p.id)}>
                        {p.name ?? p.key}
                    </a>
                ))}
                <b>{box.name ?? box.key}</b>
            </div>
            <div className="facts">
                <span>
                    {box.key}
                    {box.types && box.types.length > 1 ? ' → ' + box.types.slice(1).join(' → ') : ''}
                    {box.key !== box.kind && !box.types?.includes(box.kind) ? ' → ' + box.kind : ''}
                </span>
                <span>
                    x {Math.round(box.x)} y {Math.round(box.y)} · {Math.round(box.w)}×{Math.round(box.h)}
                </span>
                <a onClick={() => void api.openFile(box.where, box.line)} title={openTitle(box.where, tr('Open {file}:{line} in VS Code', { file: box.file, line: box.line }))}>
                    {box.file}:{box.line}
                </a>
            </div>
            {box.via && <div className="via">{tr('via {via}', { via: box.via.join(' › ') })}</div>}
            {box.visible && (
                <label className="vis">
                    <input type="checkbox" checked={!props.hidden} onChange={() => props.toggle(box.id)} /> {' '}{tr('shown —')}{' '}<code>visible = {box.visible}</code>
                </label>
            )}
            {box.notes?.map((n) => <div key={n} className="note">{n}</div>)}
            {box.bound && <SampleRow box={box} sample={props.sample} onSample={props.onSample} />}
            <div className="gui-props">
                <div className="gui-props-head">
                    <h4>{tr('Properties')}</h4>
                    <span className="dim">
                        {shared ? tr('written in {shared} — a change applies wherever it is used', { shared }) : box.mod ? tr('in {mod}', { mod: box.mod }) : tr('the game’s file: the first change copies it into the active mod')}
                    </span>
                </div>
                {(box.props ?? []).map((p, i) => <PropRow key={p.key + ':' + i + ':' + p.value} p={p} busy={busy} onSet={(v) => run({ set: { key: p.key, value: v } })} onRemove={() => run({ remove: p.key })} />)}
                <AddProp key={box.file + ':' + box.line} busy={busy} onAdd={(key, value) => run({ set: { key, value } })} />
                {msg?.error && <div className="gui-msg error">{msg.error}</div>}
                {msg?.notes?.map((n) => <div key={n} className="gui-msg">{n}</div>)}
            </div>
            <div className="gui-props">
                <div className="gui-props-head">
                    <h4>{tr('Blocks')}</h4>
                    <span className="dim">{tr('backgrounds, states, masks — the widget’s own open; from types and templates folded')}</span>
                </div>
                {(box.blocks ?? []).map((b) => <BlockEditor key={b.file + ':' + b.line + ':' + b.key} b={b} busy={busy} runAt={props.runAt} />)}
                <div className="gui-block-adds">
                    {['background', 'state'].map((k) => (
                        <button key={k} className="gui-add" disabled={busy} onClick={() => run({ insert: NEW_BLOCKS[k], label: tr('New {k} for {name}', { k, name: box.name ?? box.key }) })}>
                            ＋ {k}
                        </button>
                    ))}
                </div>
            </div>
        </section>
    );
}

/** One property: its value editable (Enter writes it, Esc goes back); its own can be removed, one from a type is overridden. */
function PropRow(props: { p: GuiProp; busy: boolean; onSet: (v: string) => void; onRemove: () => void; }): React.JSX.Element
{
    const { p } = props;
    const [v, setV] = useState(p.value);
    const changed = v.trim() !== p.value;
    return (
        <div className={'gui-prop' + (p.own ? ' own' : '')} title={p.own ? tr('Written in the widget itself') : tr('From {from} — a value here is written into the widget itself and wins', { from: p.from })}>
            <span className="k">{p.key}</span>
            <input
                className="v"
                value={v}
                disabled={props.busy}
                onChange={(e) => setV(e.target.value)}
                onKeyDown={(e) =>
                {
                    if (e.key === 'Enter' && changed && v.trim())
                        props.onSet(v);
                    else if (e.key === 'Escape')
                        setV(p.value);
                }}
            />
            {p.own ?
                (
                    <button className="x" disabled={props.busy} onClick={props.onRemove} title={tr('Remove it from the widget')}>
                        ✕
                    </button>
                ) :
                <span className="from">{p.from}</span>}
            {changed && <span className="dim">{tr('Enter')}</span>}
        </div>
    );
}
