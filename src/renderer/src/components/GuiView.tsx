/** The GUI tab (docs/gui-designer.md): the game's `.gui` windows, widgets, types and templates, what they use and who uses them. */
import { useEffect, useMemo, useState } from 'react';
import type { GuiDefView, GuiDetail, GuiItem, GuiKind, GuiUse } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { VirtualList, formatCount, openTitle, revealTitle } from './common';
import { highlight } from './SourceView';
import { hook } from '../testApi';
import { GuiPreview } from './GuiPreview';
import '../styles/gui.css';

import { tr } from '../../../shared/i18n';
import { fold, foldHas } from '../../../shared/fold';
export const GUI_ROUTE = '@gui';

const KINDS: [GuiKind, string, string][] = [
    ['window', 'Windows', 'Windows: `window = { name = … }`'],
    ['root', tr('Widgets'), tr('Other named widgets at the top of a file (tooltips, parts of the HUD, windows made from a type)')],
    ['type', 'Types', 'Reusable widgets: `type name = widget { }` in a `types` group'],
    ['template', 'Templates', 'Reusable properties and blocks: `template name { }`, used with `using = name`']
];
const KIND_LABEL: Record<GuiKind, string> = { window: tr('Window'), root: tr('Widget'), type: 'Type', template: 'Template' };

const USE_ORDER: [GuiUse['kind'], string][] = [
    ['template', tr('Templates')],
    ['type', tr('Types')],
    ['scriptedGui', tr('Scripted GUIs')],
    ['texture', tr('Textures')],
    ['text', tr('Texts')],
    ['function', tr('Data functions')]
];

const route = (kind: GuiKind, name: string): string => `${kind}:${name}`;

function parseRoute(s: string | undefined): { kind: GuiKind; name: string; } | null
{
    const i = s ? s.indexOf(':') : -1;
    return s && i > 0 && KINDS.some(([k]) => k === s.slice(0, i)) ? { kind: s.slice(0, i) as GuiKind, name: s.slice(i + 1) } : null;
}

let cached: { key: string; items: GuiItem[]; } | null = null;
/** the detail page's switch, kept while the app runs */
let lastMode: 'preview' | 'source' = 'preview';

export function GuiView(props: { navigate: Navigate; reloadKey: string; selected?: string; }): React.JSX.Element
{
    const sel = parseRoute(props.selected);
    const [items, setItems] = useState<GuiItem[] | null>(cached?.key === props.reloadKey ? cached.items : null);
    const [kind, setKind] = useState<GuiKind>(sel?.kind ?? 'window');
    const [filter, setFilter] = useState('');
    const [detail, setDetail] = useState<{ key: string; d: GuiDetail | null; } | null>(null);

    useEffect(() =>
    {
        if (cached?.key === props.reloadKey)
            return;

        let cancelled = false;
        void api.guiList().then((l) =>
        {
            cached = { key: props.reloadKey, items: l };

            if (!cancelled)
                setItems(l);
        });
        return () =>
        {
            cancelled = true;
        };
    }, [props.reloadKey]);

    // (a link to a definition of another kind opens that kind's list)
    useEffect(() =>
    {
        if (sel)
            setKind(sel.kind);
    }, [sel?.kind, sel?.name]);

    const key = props.selected ?? '';
    useEffect(() =>
    {
        if (!sel)
        {
            setDetail(null);
            return;
        }

        let cancelled = false;
        void api.guiDetail(sel.kind, sel.name).then((d) => !cancelled && setDetail({ key, d }));
        return () =>
        {
            cancelled = true;
        };
    }, [key, props.reloadKey]);

    const counts = useMemo(() =>
    {
        const c: Record<GuiKind, number> = { window: 0, root: 0, type: 0, template: 0 };

        for (const i of items ?? [])
            c[i.kind]++;

        return c;
    }, [items]);
    const shown = useMemo(() =>
    {
        const f = fold(filter.trim());
        return (items ?? []).filter((i) => i.kind === kind && (!f || foldHas(i.name, f) || foldHas(i.file, f) || foldHas(i.base, f)));
    }, [items, kind, filter]);
    const selectedIndex = sel ? shown.findIndex((i) => i.name === sel.name && i.kind === sel.kind) : -1;
    const open = (k: GuiKind, name: string): void => props.navigate({ type: GUI_ROUTE, name: route(k, name) });

    useEffect(() => hook('gui', { loaded: () => items !== null && (!sel || detail?.key === key) }), [items, sel?.kind, sel?.name, detail, key]);

    return (
        <div className="gui-main">
            <div className="gui-experimental" role="note">
                <b>{tr('Experimental')}</b>
                {tr('The interface designer is still experimental: the preview approximates the game’s layout, and edits write into your active mod’s copy of the file — check the result in the game. Every change can be undone.')}</div>
            <div className="entity-list">
                <div className="head">
                    <div className="title">
                        <h2>{tr('Interface')}</h2>
                        <span className="count">{items ? tr('{count} definitions', { count: formatCount(items.length) }) : ''}</span>
                    </div>
                    <div className="gui-kinds">
                        {KINDS.map(([k, label, tip]) => (
                            <button key={k} className={'gui-kind' + (k === kind ? ' on' : '')} onClick={() => setKind(k)} title={tip}>
                                {label} <span className="n">{formatCount(counts[k])}</span>
                            </button>
                        ))}
                    </div>
                    <div className="row">
                        <input placeholder={tr('Filter by name, file or kind of widget…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                    </div>
                </div>
                {items === null ? <div className="list-empty">{tr('Reading the interface files…')}</div> : shown.length === 0 ? <div className="list-empty">{tr('Nothing here.')}</div> : (
                    <VirtualList
                        items={shown}
                        rowHeight={42}
                        scrollToIndex={selectedIndex}
                        resetKey={[kind, filter]}
                        render={(it, _i, style) => (
                            <div
                                key={it.file + ':' + it.line}
                                className={'entity-row' + (sel && it.kind === sel.kind && it.name === sel.name ? ' active' : '')}
                                style={style}
                                onClick={() => open(it.kind, it.name)}
                                title={`${it.file}:${it.line}`}
                            >
                                <div className="line1">
                                    <span className="name">{it.name}</span>
                                    {it.local && <span className="refs" title={tr('Only its own file can use it')}>{tr('local')}</span>}
                                </div>
                                <div className="display">
                                    {it.base || it.group || ' '}
                                    {it.base && it.group ? ` · ${it.group}` : ''}
                                    {` · ${it.file.replace(/^gui\//, '')}`}
                                </div>
                            </div>
                        )}
                    />
                )}
            </div>
            <div className="detail">
                {!sel ?
                    (
                        <div className="placeholder">
                            <h2>{tr('The game’s interface')}</h2>
                            <div>{tr('Pick a window, widget, type or template. Its source, what it uses and who uses it show here.')}</div>
                        </div>
                    ) :
                    detail?.key !== key
                    ? <div className="placeholder">{tr('Loading…')}</div>
                    : !detail.d
                    ? <div className="placeholder">{tr('No {kind} “{name}” in the loaded files.', { kind: KIND_LABEL[sel.kind].toLowerCase(), name: sel.name })}</div>
                    : <GuiDetailView detail={detail.d} navigate={props.navigate} open={open} reloadKey={props.reloadKey} />}
            </div>
        </div>
    );
}

function GuiDetailView(props: { detail: GuiDetail; navigate: Navigate; open: (k: GuiKind, name: string) => void; reloadKey: string; }): React.JSX.Element
{
    const { detail } = props;
    const first = detail.defs[0].item;
    const [mode, setMode] = useState(lastMode);
    // (a template is properties to put in place: nothing to lay out)
    const canPreview = detail.kind !== 'template';
    const pick = (m: 'preview' | 'source'): void =>
    {
        lastMode = m;
        setMode(m);
    };
    return (
        <>
            <div className="detail-header">
                <div className="kicker">
                    <span className="chip accent">{KIND_LABEL[detail.kind]}</span>
                    {first.group && <span className="chip" title={tr('The `types` group it is in')}>{first.group}</span>}
                    {first.local && <span className="chip" title={tr('`local_type` / `local_template`: only its own file can use it')}>{tr('local')}</span>}
                    {detail.defs.length > 1 && <span className="chip warn" title={tr('Defined in several files — which one the game takes is not settled here')}>{tr('defined {defsCount}×', { defsCount: detail.defs.length })}</span>}
                </div>
                <h1>{detail.name}</h1>
                <div className="key">{first.base ? `${detail.kind === 'type' ? tr('based on') : tr('made from')} ${first.base}` : ' '}</div>
                {canPreview && (
                    <div className="gui-modes">
                        <button className={'gui-kind' + (mode === 'preview' ? ' on' : '')} onClick={() => pick('preview')} title={tr('Laid out as the game would: a box per widget')}>
                            {tr('Preview')}</button>
                        <button className={'gui-kind' + (mode === 'source' ? ' on' : '')} onClick={() => pick('source')} title={tr('The definition as written, what it uses, who uses it')}>
                            {tr('Source')}</button>
                    </div>
                )}
            </div>
            <div className="detail-body">
                {canPreview && mode === 'preview' && <GuiPreview kind={detail.kind} name={detail.name} reloadKey={props.reloadKey} />}
                {(!canPreview || mode === 'source') && detail.defs.map((d) => <GuiDef key={d.item.file + ':' + d.item.line} def={d} open={props.open} navigate={props.navigate} />)}
                {(!canPreview || mode === 'source') && detail.usedByCount > 0 && (
                    <section className="gui-section">
                        <h3>
                            {tr('Used by')}{' '}<span className="n">{formatCount(detail.usedByCount)}</span>
                        </h3>
                        <div className="gui-links">
                            {detail.usedBy.map((u) => (
                                <a key={u.kind + u.name + u.file + u.line} className="gui-link" onClick={() => props.open(u.kind, u.name)} title={`${u.file}:${u.line}`}>
                                    {u.name}
                                    <span className="k">{KIND_LABEL[u.kind].toLowerCase()}</span>
                                </a>
                            ))}
                            {detail.usedByCount > detail.usedBy.length && <span className="gui-more">{tr('… and {more} more', { more: formatCount(detail.usedByCount - detail.usedBy.length) })}</span>}
                        </div>
                    </section>
                )}
            </div>
        </>
    );
}

function GuiDef(props: { def: GuiDefView; open: (k: GuiKind, name: string) => void; navigate: Navigate; }): React.JSX.Element
{
    const { def } = props;
    const highlighted = useMemo(() => highlight(def.text, []), [def.text]);
    const lines = def.endLine - def.item.line + 1;
    const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => def.item.line + i).join('\n'), [lines, def.item.line]);
    return (
        <>
            <div className="def-site">
                <header>
                    <span className="path" title={def.where}>
                        {def.item.file}:{def.item.line}–{def.endLine}
                    </span>
                    {def.item.mod && <span className="chip" title={tr('The file is from a loaded mod')}>{def.item.mod}</span>}
                    <button onClick={() => void api.openFile(def.where, def.item.line)} title={openTitle(def.where, tr('Open {file}:{line} in VS Code', { file: def.item.file, line: def.item.line }))}>
                        {tr('Open in VS Code')}</button>
                    <button onClick={() => void api.revealFile(def.where)} title={revealTitle(def.where, tr('Show the file in its folder'))}>
                        {tr('Reveal')}</button>
                </header>
                <div className="code">
                    <pre className="gutter">{gutter}</pre>
                    <pre>{highlighted}</pre>
                </div>
            </div>
            <Uses uses={def.uses} open={props.open} navigate={props.navigate} />
        </>
    );
}

function Uses(props: { uses: GuiUse[]; open: (k: GuiKind, name: string) => void; navigate: Navigate; }): React.JSX.Element | null
{
    const [all, setAll] = useState<Record<string, boolean>>({});

    if (!props.uses.length)
        return null;

    return (
        <section className="gui-section">
            <h3>{tr('Uses')}</h3>
            {USE_ORDER.map(([k, label]) =>
            {
                const rows = props.uses.filter((u) => u.kind === k);

                if (!rows.length)
                    return null;

                const list = all[k] ? rows : rows.slice(0, 40);
                return (
                    <div key={k} className="gui-use-group">
                        <h4>
                            {label} <span className="n">{rows.length}</span>
                        </h4>
                        <div className="gui-links">
                            {list.map((u) => (
                                <a
                                    key={u.name}
                                    className={'gui-link' + (u.gui || u.entry ? '' : ' plain')}
                                    onClick={u.gui ? () => props.open(u.gui!.kind, u.gui!.name) : u.entry ? () => props.navigate(u.entry!) : undefined}
                                    title={u.text ?? (u.gui || u.entry ? undefined : tr('Not found in the loaded files'))}
                                >
                                    {k === 'texture' ? u.name.replace(/^gfx\//, '') : u.name}
                                    {u.count > 1 && <span className="k">×{u.count}</span>}
                                </a>
                            ))}
                            {rows.length > list.length && (
                                <a className="gui-more" onClick={() => setAll({ ...all, [k]: true })}>
                                    {tr('… and {more} more', { more: rows.length - list.length })}</a>
                            )}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
