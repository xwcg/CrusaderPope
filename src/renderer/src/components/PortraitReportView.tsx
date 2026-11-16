import { useEffect, useState } from 'react';
import type { PortraitEntityReport, PortraitReport } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { openTitle, revealTitle } from './common';
import { digest, useRevision } from '../revision';

import { errorText } from '../errors';
import { tr } from '../../../shared/i18n';
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const fmt = (x: number): string => (Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));

/**
 * Expert "Portrait" tab: what the 3D portrait is built from (entities, mesh files, vertex counts, blend shapes
 * (applied, at zero, skipped and why), bone morphs, decals, tags and portrait modifiers). For checking mesh mods.
 */
export function PortraitReportView(props: { type: string; name: string; navigate: Navigate; }): React.JSX.Element
{
    const [dressed, setDressed] = useState(true);
    const [figLeaf, setFigLeaf] = useState(true);
    const [report, setReport] = useState<PortraitReport | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);

    // again after an index update (the old report stays until the new one is there)
    const revision = useRevision();
    useEffect(() => setReport(undefined), [props.type, props.name, dressed, figLeaf]);
    useEffect(() =>
    {
        let cancelled = false;
        setError(null);
        api
            .portraitReport(props.type, props.name, { naked: !dressed, figLeaf })
            .then((r) => !cancelled && setReport((old) => (old && r && digest(old) === digest(r) ? old : r)))
            .catch((e: Error) => !cancelled && setError(errorText(e)));
        return () =>
        {
            cancelled = true;
        };
    }, [props.type, props.name, dressed, figLeaf, revision]);

    if (error)
        return <div className="placeholder">{tr('Portrait report failed: {error}', { error })}</div>;

    if (report === undefined)
        return <div className="placeholder">{tr('Building the portrait…')}</div>;

    if (report === null)
        return <div className="placeholder">{tr('No portrait for this entry.')}</div>;

    const vertices = report.entities.reduce((s, e) => s + e.parts.reduce((t, p) => t + p.vertices, 0), 0);
    return (
        <div className="portrait-report">
            <div className="pr-summary">
                <span className="chip accent">{report.kind}</span>
                <span>
                    {report.label} · {report.gender}, {report.age}
                </span>
                <span className="pr-dim">{report.source}</span>
                <span className="pr-dim">
                    {tr('{entitiesCount} entities · {vertices} vertices', { entitiesCount: report.entities.length, vertices: vertices.toLocaleString() })}</span>
                <span className="portrait-toggles">
                    <label title={tr('Undressed uses the game\'s naked outfit')}>
                        <input type="checkbox" checked={dressed} onChange={(e) => setDressed(e.target.checked)} /> {' '}{tr('dressed')}</label>
                    {!dressed && (
                        <label>
                            <input type="checkbox" checked={figLeaf} onChange={(e) => setFigLeaf(e.target.checked)} /> {' '}{tr('fig leaf')}</label>
                    )}
                </span>
            </div>

            {report.entities.map((e, i) => <EntityBlock key={e.role + i} e={e} navigate={props.navigate} />)}

            <div className="ref-group">
                <header>
                    <span className="label">{tr('Decals')}</span>
                    <span className="n">{report.decals.length}</span>
                </header>
                <div className="pr-table pr-decals">
                    {report.decals.map((d, i) => (
                        <div key={i} className="pr-row">
                            <span className="pr-dim">{d.bodyPart}</span>
                            <span className="pr-file site-link" title={d.texture} onClick={() => props.navigate({ type: 'images', name: d.texture })}>
                                {base(d.texture)}
                            </span>
                            <span className="pr-num">{d.weight.toFixed(2)}</span>
                            <span className="pr-dim">{d.post ? tr('after skin colour') : tr('before skin colour')}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="ref-group">
                <header>
                    <span className="label">{tr('Tags')}</span>
                    <span className="n">{report.tags.length}</span>
                </header>
                <div className="pr-chips">
                    {report.tags.map((t) => (
                        <span key={t} className="chip">
                            {t}
                        </span>
                    ))}
                </div>
            </div>
            <div className="ref-group">
                <header>
                    <span className="label">{tr('Portrait modifiers applied')}</span>
                    <span className="n">{report.modifiers.length}</span>
                </header>
                <div className="pr-chips">
                    {report.modifiers.map((m) => (
                        <span key={m} className="chip">
                            {m}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}

function EntityBlock({ e, navigate }: { e: PortraitEntityReport; navigate: Navigate; }): React.JSX.Element
{
    const [open, setOpen] = useState(e.role === 'torso' || e.role === 'head');
    const [showZero, setShowZero] = useState(false);
    const problems = e.blendShapes.filter((b) => b.status === 'missing' || b.status === 'topology');
    const applied = e.blendShapes.filter((b) => b.status === 'applied').sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const zero = e.blendShapes.filter((b) => b.status === 'zero');
    const vertices = e.parts.reduce((s, p) => s + p.vertices, 0);
    return (
        <div className="ref-group">
            <header onClick={() => setOpen(!open)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <span className="label">
                    {e.role}
                    {e.accessory && <span className="pr-dim">· {e.accessory}</span>}
                </span>
                {problems.length > 0 && <span className="chip warn">{tr('{problemsCount} blend shapes skipped', { problemsCount: problems.length })}</span>}
                <span className="n">
                    {tr('{vertices} vertices · {appliedCount} blend shapes · {boneMorphsCount} bone morphs', { vertices: vertices.toLocaleString(), appliedCount: applied.length, boneMorphsCount: e.boneMorphs.length })}</span>
            </header>
            {open && (
                <div className="pr-body">
                    <div className="pr-files">
                        <span className="pr-dim">{tr('entity')}</span>
                        <span className="pr-code">{e.entity}</span>
                        <span className="pr-dim">{tr('asset')}</span>
                        <span>
                            <span className="site-link" title={tr('Declarations, textures and preview')} onClick={() => navigate({ type: 'models', name: e.asset })}>
                                {e.asset}
                            </span>
                            <span className="pr-ext" title={openTitle(e.assetAbs)} onClick={() => void api.openFile(e.assetAbs)}>
                                ↗
                            </span>
                        </span>
                        <span className="pr-dim">{tr('mesh')}</span>
                        <span>
                            <span className="site-link" title={tr('3D preview, parts and textures')} onClick={() => navigate({ type: 'models', name: e.mesh })}>
                                {e.mesh}
                            </span>
                            <span className="pr-ext" title={revealTitle(e.meshAbs)} onClick={() => void api.revealFile(e.meshAbs)}>
                                ↗
                            </span>
                        </span>
                        <span className="pr-dim">{tr('skeleton')}</span>
                        <span>
                            {tr('{pose} pose · {bones} bones', { pose: e.pose, bones: e.bones })}{e.idle && <span className="pr-dim">{tr('· idle {base}', { base: base(e.idle) })}</span>}
                        </span>
                    </div>

                    <div className="pr-table">
                        {e.parts.map((p, i) => (
                            <div key={i} className="pr-row pr-part">
                                <span className="pr-code">{p.shape}</span>
                                <span className="pr-num">{p.vertices.toLocaleString()} v</span>
                                <span className="pr-num">{tr('{triangles} tris', { triangles: p.triangles.toLocaleString() })}</span>
                                <span className="pr-dim">{p.shader}</span>
                                <span className="pr-dim" title={tr('min {min}\nmax {max}', { min: p.min.map(fmt).join(', '), max: p.max.map(fmt).join(', ') })}>
                                    {p.max.map((x, k) => fmt(x - p.min[k])).join(' × ')}
                                </span>
                            </div>
                        ))}
                    </div>

                    {problems.length + applied.length + zero.length > 0 && (
                        <div className="pr-table">
                            {[...problems, ...applied, ...(showZero ? zero : [])].map((b) => (
                                <div key={b.attribute} className={'pr-row pr-bs' + (b.status === 'missing' || b.status === 'topology' ? ' pr-bad' : b.status === 'zero' ? ' pr-zero' : '')}>
                                    <span className="pr-code">{b.attribute}</span>
                                    <span className="pr-num">{b.weight.toFixed(3)}</span>
                                    <span className={'pr-file' + (b.target.endsWith('.mesh') ? ' site-link' : '')} title={b.target} onClick={b.target.endsWith('.mesh') ? () => navigate({ type: 'models', name: b.target }) : undefined}>
                                        {base(b.target)}
                                    </span>
                                    <span className="pr-dim">
                                        {b.status}
                                        {b.detail && `: ${b.detail}`}
                                    </span>
                                </div>
                            ))}
                            {zero.length > 0 && (
                                <div className="pr-more site-link" onClick={() => setShowZero(!showZero)}>
                                    {showZero ? 'hide' : 'show'} {tr('{zeroCount} blend shapes at zero', { zeroCount: zero.length })}</div>
                            )}
                        </div>
                    )}

                    {e.boneMorphs.length > 0 && (
                        <div className="pr-table">
                            {e.boneMorphs.map((m) => (
                                <div key={m.attribute} className="pr-row pr-bs">
                                    <span className="pr-code">{m.attribute}</span>
                                    <span className="pr-num">u {m.u.toFixed(3)}</span>
                                    <span className="pr-file" title={m.animation}>
                                        {base(m.animation)}
                                    </span>
                                    <span className="pr-dim">{tr('bone morph')}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
