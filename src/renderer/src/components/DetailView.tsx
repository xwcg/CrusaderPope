import { useEffect, useState } from 'react';
import { AssetMenu } from './AssetMenu';
import type { CoaKind, EntityDetail, TypeSummary } from '../../../shared/api';
import { api } from '../api';
import type { Navigate, Tab } from '../App';
import { TypeChip, openTitle } from './common';
import { ModBadge, OriginTag, hiddenByText } from './ModChip';
import { OverrideButton } from './OverrideMenu';
import { DUPLICATE_GLYPH, DUPLICATE_TEXT, duplicateAdvice, leadMod, modColor, modName, useHideRemoved, useLoadedMods } from '../modStore';
import { RefColumns } from './RefPanel';
import { SourceView } from './SourceView';
import { EventCard, LocText } from './EventCard';
import { GraphView } from './GraphView';
import { ReadableView } from './StoryView';
import { PortraitReportView } from './PortraitReportView';
import { PORTRAIT_TYPES } from './PortraitViewer';
import { ModelView } from './ModelView';
import { useRevision } from '../revision';
import { MAP_ROUTE } from './map/MapView';
import { CoatOfArms } from './CoatOfArms';

/** entries the map can show (MapView's focus) */
const MAP_TYPES = new Set(['landed_titles', 'culture/cultures', 'faith', 'terrain_types']);
/** entries with a coat of arms, shown in the header */
const COA_KINDS: Record<string, CoaKind> = { landed_titles: 'title', dynasties: 'dynasty', dynasty_houses: 'house', 'coat_of_arms/coat_of_arms': 'coa' };

export function DetailView(props: { type: string; name: string; tab: Tab; setTab: (t: Tab) => void; navigate: Navigate; }): React.JSX.Element
{
    const { type, name, setTab, navigate } = props;
    const [detail, setDetail] = useState<EntityDetail | null | undefined>(undefined);
    // an index update (the mod's files changed): the same entry again — the old one stays shown until then
    const revision = useRevision();

    useEffect(() =>
    {
        let cancelled = false;
        void api.detail(type, name).then((d) =>
        {
            if (!cancelled)
                setDetail((old) => (old && d && JSON.stringify(old) === JSON.stringify(d) ? old : d));
        });
        return () =>
        {
            cancelled = true;
        };
    }, [type, name, revision]);

    if (detail === undefined)
        return <div className="detail" />;

    if (detail === null)
        return (
            <div className="detail">
                <div className="placeholder">
                    <h2>Not found</h2>
                    <div>
                        {type} / {name}
                    </div>
                </div>
            </div>
        );

    // the Portrait tab only exists for characters, DNA and bookmark portraits: elsewhere show References; model files
    // have no script source, their Model tab shows it
    const tab: Tab = detail.type === 'models' && (props.tab === 'portrait' || props.tab === 'source') ? 'read' : props.tab === 'portrait' && !PORTRAIT_TYPES.has(detail.type) ? 'refs' : props.tab;
    const inCount = detail.incoming.reduce((s, g) => s + g.items.length, 0);
    const outCount = detail.outgoing.reduce((s, g) => s + g.items.length, 0);
    const title = detail.display && detail.display !== detail.name ? detail.display : undefined;
    // definitions the game loads (the others are in files a mod hid)
    const liveDefs = detail.defs.filter((d) => !d.origin?.hiddenBy).length;
    // the winning definition: when it is the active mod's, the override menu can remove it again
    const win = [...detail.defs].reverse().find((d) => !d.origin?.hiddenBy);
    // (the mod's file replaces the game's file of that path: without the definition the entry is gone from the game)
    const replacesFile = !!win && detail.defs.some((d) => d.origin?.hiddenBy?.how === 'file' && d.file === win.file && d.origin.hiddenBy.mod === win.src?.mod);

    return (
        <div className="detail">
            <div className={'detail-header' + (tab === 'read' ? ' compact' : '')}>
                {COA_KINDS[detail.type] && <CoatOfArms kind={COA_KINDS[detail.type]} name={detail.name} size={tab === 'read' ? 38 : 84} className="detail-coa" />}
                {tab !== 'read' && (
                    <>
                        <div className="kicker">
                            <TypeChip type={detail.type} label={detail.typeLabel} />
                            {liveDefs > 1 && <span className="chip warn">defined {liveDefs}×</span>}
                            {detail.defs.some((d) => d.local) && <span className="chip">file-local</span>}
                            {detail.event?.hidden && <span className="chip">hidden</span>}
                            {detail.defs.length === 0 && <span className="chip">no definition (implicit)</span>}
                        </div>
                        {title ? <h1>{title}</h1> : <h1 style={{ fontFamily: 'var(--font-code)', fontSize: 20 }}>{detail.name}</h1>}
                        {title && <div className="key">{detail.name}</div>}
                        {detail.description && (
                            <p className="description">
                                <LocText text={detail.description} refs={detail.textRefs} navigate={navigate} />
                            </p>
                        )}
                        <div className="sites">
                            {detail.defs.map((d, i) => (
                                <span key={i} className={'site' + (d.origin?.hiddenBy ? ' hidden' : '')}>
                                    <OriginTag origin={d.origin} />
                                    <span
                                        className="site-link"
                                        title={openTitle(d.absPath, d.origin?.hiddenBy ? `Open in VS Code — ${hiddenByText(d.origin)}` : 'Open in VS Code')}
                                        style={d.overridden ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}
                                        onClick={() => void api.openFile(d.absPath, d.line)}
                                    >
                                        {d.file}:{d.line}
                                    </span>
                                </span>
                            ))}
                        </div>
                    </>
                )}
                <div className="tabs">
                    <button className={'tab read-tab' + (tab === 'read' ? ' active' : '')} onClick={() => setTab('read')} title={detail.name}>
                        {detail.type === 'events' || detail.type === 'on_action' ? 'Story' : detail.type === 'models' ? 'Model' : 'Summary'}
                    </button>
                    <span className="tab-sep">Expert</span>
                    <button className={'tab' + (tab === 'refs' ? ' active' : '')} onClick={() => setTab('refs')}>
                        References
                        <span className="n">
                            ←{inCount} →{outCount}
                        </span>
                    </button>
                    <button className={'tab' + (tab === 'source' ? ' active' : '')} onClick={() => setTab('source')} disabled={detail.defs.length === 0}>
                        Source<span className="n">{detail.defs.length}</span>
                    </button>
                    <button className={'tab' + (tab === 'graph' ? ' active' : '')} onClick={() => setTab('graph')}>
                        Graph
                    </button>
                    {PORTRAIT_TYPES.has(detail.type) && (
                        <button className={'tab' + (tab === 'portrait' ? ' active' : '')} onClick={() => setTab('portrait')} title="What the 3D portrait is built from: meshes, blend shapes, bone morphs, decals">
                            Portrait
                        </button>
                    )}
                    <span className="tabs-end">
                        <ModBadge touch={detail.mod} />
                        {MAP_TYPES.has(detail.type) && (
                            <button className="ghost show-on-map" onClick={() => navigate({ type: MAP_ROUTE, name: `${detail.type}:${detail.name}` })} title="Show it on the map">
                                Show on map
                            </button>
                        )}
                        {(detail.type === 'images' || detail.type === 'models') && <AssetMenu path={detail.name} navigate={navigate} />}
                        {/* script definitions and localization keys: copy into the active mod, or replace their file there */}
                        {detail.defs.length > 0 && <OverrideButton type={detail.type} name={detail.name} navigate={navigate} own={win?.src} replacesFile={replacesFile} />}
                    </span>
                </div>
            </div>
            {tab === 'graph' ?
                (
                    <div className="detail-body graph-body">
                        <GraphView type={type} name={name} navigate={navigate} />
                    </div>
                ) :
                tab === 'read' && detail.type === 'models' ?
                (
                    <div className="detail-body">
                        <ModelView path={name} navigate={navigate} />
                    </div>
                ) :
                tab === 'read' ?
                (
                    <div className="detail-body read-body">
                        <ModBanner detail={detail} />
                        <ReadableView type={type} name={name} navigate={navigate} />
                    </div>
                ) :
                (
                    <div className="detail-body">
                        <ModBanner detail={detail} />
                        {tab === 'refs' && (
                            <>
                                {detail.event && <EventCard ev={detail.event} navigate={navigate} refs={detail.textRefs} />}
                                {detail.locText !== undefined && (
                                    <>
                                        <div className="loc-block" style={{ whiteSpace: 'pre-wrap' }}>
                                            <LocText text={detail.locPlain ?? ''} refs={detail.textRefs} navigate={navigate} />
                                        </div>
                                        <div className="loc-raw">{detail.locText}</div>
                                    </>
                                )}
                                <RefColumns incoming={detail.incoming} outgoing={detail.outgoing} navigate={navigate} ownType={detail.type} />
                            </>
                        )}
                        {tab === 'source' && <SourceView defs={detail.defs} navigate={navigate} entity={{ type: detail.type, name: detail.name }} />}
                        {tab === 'portrait' && <PortraitReportView type={type} name={name} navigate={navigate} />}
                    </div>
                )}
        </div>
    );
}

/** An entry a mod removed (how it went, that it is no game data any more — Source still shows it), or one a mod defines as the game does. */
function ModBanner({ detail }: { detail: EntityDetail; }): React.JSX.Element | null
{
    const mods = useLoadedMods();
    const t = detail.mod;

    // defined twice where the game keeps no winner (events, history characters, localization outside replace/)
    if (t?.duplicate)
    {
        const lead = leadMod(t);
        const where = detail.defs.filter((d) => !d.origin?.hiddenBy).map((d) => `${d.file}:${d.line} (${d.origin?.name ?? 'Game'})`);
        return (
            <div className="mod-banner duplicate" style={{ '--mod': lead ? modColor(lead) : 'var(--text-dim)' } as React.CSSProperties}>
                <b>{DUPLICATE_GLYPH} Duplicate</b> — {where.join(' and ')}. {DUPLICATE_TEXT} {duplicateAdvice(detail.type)} The views here read the last one in file order.
            </div>
        );
    }

    // a mod defines it again as the game does: say so, it is no change
    if (t?.state === 'same')
    {
        const lead = leadMod(t);
        const names = t.mods.map((id) => modName(mods, id));
        const where = [...detail.defs].reverse().find((d) => d.origin?.mod === lead)?.file;
        return (
            <div className="mod-banner same" style={{ '--mod': lead ? modColor(lead) : 'var(--text-dim)' } as React.CSSProperties}>
                <b>Same as the game</b> — {names.join(', ')} {t.mods.length > 1 ? 'define' : 'defines'} it again{where ? ` (${where})` : ''}, but as the game does, spacing and comments aside: nothing changes. The Source tab shows both.
            </div>
        );
    }

    if (t?.state !== 'removed')
        return null;

    // (the removing mod is the last to hide one of its definitions)
    const lead = leadMod(t);
    const def = [...detail.defs].reverse().find((d) => d.origin?.hiddenBy?.mod === lead) ?? detail.defs[detail.defs.length - 1];
    const how = def?.origin?.hiddenBy?.how === 'replace_path'
        ? `its replace_path hides the folder that defined it (${def.file.slice(0, def.file.lastIndexOf('/'))})`
        : `it replaces the file that defined it (${def?.file}) with its own version, which doesn't`;
    return (
        <div className="mod-banner" style={{ '--mod': lead ? modColor(lead) : 'var(--text-dim)' } as React.CSSProperties}>
            <b>Removed by {lead ? modName(mods, lead) : 'a mod'}</b> — {how}. With the loaded mods the game doesn’t have this entry; the Source tab shows its former definition.
        </div>
    );
}

export function TypePage({ type }: { type: TypeSummary; }): React.JSX.Element
{
    const [docs, setDocs] = useState<{ file: string; text: string; }[] | null>(null);
    const revision = useRevision();
    useEffect(() => setDocs(null), [type.id]);
    useEffect(() =>
    {
        if (type.hasDoc)
            void api.typeDoc(type.id).then(setDocs);
        else
            setDocs(null);
    }, [type.id, type.hasDoc, revision]);
    // what the loaded mods do to the type, per kind of change (entries they removed hidden when they are)
    const [hideRemoved] = useHideRemoved();
    const removed = hideRemoved ? (type.modStates?.removed ?? 0) : 0;
    const words = { added: 'added', overridden: 'changed', same: 'the same as the game', removed: hideRemoved ? 'removed (hidden)' : 'removed', merged: 'merged' } as const;
    const byMods = (['added', 'overridden', 'same', 'removed', 'merged'] as const)
        .filter((k) => type.modStates?.[k])
        .map((k) => `${type.modStates![k]!.toLocaleString()} ${words[k]}`);
    return (
        <div className="detail">
            <div className="detail-body type-page">
                <h2>{type.label}</h2>
                <div className="sub">
                    {(type.count - removed).toLocaleString()} entries{byMods.length ? ` (loaded mods: ${byMods.join(', ')})` : ''} · <span style={{ fontFamily: 'var(--font-code)' }}>{type.id}</span>
                </div>
                {docs && docs.length > 0 ?
                    (
                        <>
                            <div className="sub">Paradox documentation shipped with the game:</div>
                            {docs.map((d) => (
                                <div key={d.file}>
                                    <div className="site-link" style={{ marginBottom: 4 }}>
                                        {d.file}
                                    </div>
                                    <pre className="type-doc">{d.text}</pre>
                                </div>
                            ))}
                        </>
                    ) :
                    (
                        <div className="placeholder" style={{ height: 'auto', paddingTop: 80 }}>
                            <div>Select an entry on the left, or search with Ctrl+K.</div>
                        </div>
                    )}
            </div>
        </div>
    );
}
