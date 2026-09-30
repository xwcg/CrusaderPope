import { useCallback, useEffect, useState } from 'react';
import { AssetMenu } from './AssetMenu';
import type { AssetFileInfo, MeshFileInfo, ModelImportPlan, ModelInfo, ModelPdxMesh, ModelTexture } from '../../../shared/api';
import { api } from '../api';
import type { Navigate } from '../App';
import { GameImg } from '../img';
import { useActiveMod } from '../modStore';
import { pushNotice, type NoticeAction } from '../notices';
import { reportChange } from '../changes';
import { MeshViewer } from './MeshViewer';
import { SourceView } from './SourceView';
import { openTitle, revealTitle } from './common';
import { errorText } from './ModDialogs';
import { MODS_ROUTE } from './ModsView';
import { digest, useGfxRevision } from '../revision';

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const size = (b: number): string => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(b / 1024))} KB`);
const fmt = (x: number): string => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(1));

/** Link to another model file (asset or mesh). */
function ModelLink(props: { path: string; label?: string; navigate: Navigate; }): React.JSX.Element
{
    return (
        <span className="rt-link model-link" data-ref-type="models" data-ref-name={props.path} title={props.path} onClick={() => props.navigate({ type: 'models', name: props.path })}>
            {props.label ?? base(props.path)}
        </span>
    );
}

/**
 * Thumbnail channel per texture role: packed data maps look black or empty as RGBA — properties keep roughness in
 * alpha (the other channels are mostly 0), normal maps and pattern masks read best without alpha.
 */
function thumbChannel(role: string): string | undefined
{
    if (role === 'diffuse')
        return undefined;

    return role === 'properties' ? 'a' : 'rgb';
}

/** A texture of a material: thumbnail, role, file name; opens the image (channels, users) on click. */
export function TextureTile(props: { t: ModelTexture; navigate: Navigate; size?: number; }): React.JSX.Element
{
    const { t } = props;
    const s = props.size ?? 112;
    return (
        <div
            className={'tex-tile' + (t.path ? '' : ' missing')}
            style={{ width: s + 2 }}
            title={t.path ?? `Not found: ${t.ref}`}
            onClick={t.path ? () => props.navigate({ type: 'images', name: t.path! }) : undefined}
        >
            <div className="tex-img checker" style={{ width: s, height: s }}>
                {t.path ? <GameImg path={t.path} size={s} ch={thumbChannel(t.role)} /> : <span>missing</span>}
            </div>
            {t.path && <AssetMenu path={t.path} navigate={props.navigate} className="tile-menu" />}
            <div className="tex-role" title={t.role === 'properties' ? 'Thumbnail: alpha channel (roughness)' : undefined}>
                {t.role}
            </div>
            <div className="tex-name">{base(t.path ?? t.ref).replace(/\.(dds|png|tga)$/i, '')}</div>
        </div>
    );
}

function Section(props: { title: string; count?: number; children: React.ReactNode; open?: boolean; }): React.JSX.Element
{
    const [open, setOpen] = useState(props.open ?? true);
    return (
        <div className="model-section">
            <header onClick={() => setOpen(!open)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <span className="label">{props.title}</span>
                {props.count !== undefined && <span className="n">{props.count}</span>}
            </header>
            {open && <div className="model-section-body">{props.children}</div>}
        </div>
    );
}

/** Summary of a model file: 3D preview, declarations or geometry facts, textures, source. */
export function ModelView(props: { path: string; navigate: Navigate; }): React.JSX.Element
{
    const [info, setInfo] = useState<ModelInfo | null | undefined>(undefined);
    // again after an index update that changed gfx files (the view stays until then; unchanged: nothing redrawn)
    const gfx = useGfxRevision();
    useEffect(() => setInfo(undefined), [props.path]);
    useEffect(() =>
    {
        let cancelled = false;
        void api.modelInfo(props.path).then((i) => !cancelled && setInfo((old) => (old && i && digest(old) === digest(i) ? old : i)));
        return () =>
        {
            cancelled = true;
        };
    }, [props.path, gfx]);

    if (info === undefined)
        return <div className="read-loading">Reading the model…</div>;

    if (info === null)
        return <div className="placeholder">Model file not found.</div>;

    return info.kind === 'asset' ? <AssetView info={info} navigate={props.navigate} /> : <MeshView info={info} navigate={props.navigate} />;
}

function Head(props: { info: ModelInfo; kind: string; extra?: React.ReactNode; }): React.JSX.Element
{
    const { info } = props;
    return (
        <div className="model-head">
            <div className="rpg-kind">3D model · {props.kind}</div>
            <h1>{base(info.path)}</h1>
            <div className="model-path">
                <span className="site-link" title={revealTitle(info.abs)} onClick={() => void api.revealFile(info.abs)}>
                    {info.path}
                </span>
                <span className="pr-dim">· {size(info.bytes)}</span>
                {info.kind === 'asset' && (
                    <span className="site-link" title={openTitle(info.abs)} onClick={() => void api.openFile(info.abs)}>
                        {' '}
                        · open in editor
                    </span>
                )}
                {props.extra}
            </div>
        </div>
    );
}

const plural = (n: number, one: string, many = one + 's'): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The Blender round trip (docs/blender.md) for a .mesh file or an .asset's pdxmesh: export as glTF with PNG textures,
 * import an edited glTF/GLB back into the active mod (mesh and changed textures at their game paths).
 */
function BlenderBar(props: { path: string; pdxmesh?: string; navigate: Navigate; }): React.JSX.Element
{
    const { path, pdxmesh, navigate } = props;
    const active = useActiveMod();
    const [plan, setPlan] = useState<ModelImportPlan | null>(null);
    const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
    useEffect(() =>
    {
        let alive = true;
        setPlan(null);
        void api.importModelPlan(path, pdxmesh).then(
            (p) => alive && setPlan(p),
            (e) => alive && setPlan({ problem: errorText(e) })
        );
        return () =>
        {
            alive = false;
        };
    }, [path, pdxmesh, active.id, active.loaded]);

    const exportModel = async (): Promise<void> =>
    {
        setBusy('export');

        try
        {
            const r = await api.exportModel(path, pdxmesh);

            if (!r)
                return;

            const c = r.counts;
            const counts = [plural(c.shapes, 'shape'), plural(c.triangles, 'triangle'), plural(c.materials, 'material'), plural(c.textures, 'texture')];

            if (c.joints)
                counts.push(plural(c.joints, 'joint'));

            if (c.blendShapes)
                counts.push(`${plural(c.blendShapes, 'blend shape')} (shape keys)`);

            pushNotice({
                kind: 'ok',
                title: 'Exported for Blender',
                text: r.gltf,
                details: [
                    `${counts.join(', ')} — ${plural(r.files.length, 'file')} written.`,
                    'In Blender: File › Import › glTF 2.0. When done, export as glTF 2.0 (.glb or .gltf) and bring it back with “Import from Blender…”.',
                    ...r.warnings.map((w) => '⚠ ' + w)
                ],
                actions: [{ label: 'Reveal', run: () => void api.revealFile(r.gltf) }]
            });
        }
        catch (e)
        {
            pushNotice({ kind: 'error', title: 'Export failed', text: errorText(e) });
        }
        finally
        {
            setBusy('');
        }
    };

    const importModel = async (): Promise<void> =>
    {
        setBusy('import');

        try
        {
            const r = await api.importModel(path, pdxmesh);

            if (!r)
                return;

            const actions: NoticeAction[] = [{ label: 'Reveal', run: () => void api.revealFile(r.files[0].abs) }];

            if (!r.reindex)
                actions.push({ label: 'Open the Mods page', run: () => navigate({ type: MODS_ROUTE }) });

            reportChange({
                kind: 'ok',
                text: `Imported ${plural(r.files.length, 'file')} from ${r.source.slice(Math.max(r.source.lastIndexOf('/'), r.source.lastIndexOf('\\')) + 1)}`,
                mod: r.mod.name,
                where: r.files[0]?.rel,
                details: [
                    ...r.files.map((f) => `${f.rel} — ${f.what}`),
                    ...r.notes,
                    ...r.warnings.map((w) => '⚠ ' + w),
                    ...(r.reindex ? [] : [`${r.mod.name} is not in the loaded mod list: the explorer does not show the change.`])
                ],
                actions,
                undo: r.step
            });
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: 'Nothing imported', details: [errorText(e)] });
        }
        finally
        {
            setBusy('');
        }
    };

    const importTitle = !plan
        ? 'Checking the active mod…'
        : (plan.problem ??
            `Writes ${plan.mesh} and the textures you changed into ${plan.mod!.name} — a file of the same path in a mod replaces the game’s${plan.mod!.loaded ? '' : `. ${plan.mod!.name} is not in the loaded mod list.`}`);
    return (
        <div className="blender-bar">
            <button
                onClick={() => void exportModel()}
                disabled={!!busy}
                title="Writes the mesh as glTF 2.0 (.gltf + .bin), its textures as PNG and a manifest into a folder you choose — for Blender (File › Import › glTF 2.0)"
            >
                {busy === 'export' ? 'Exporting…' : 'Export for Blender…'}
            </button>
            <span title={importTitle}>
                <button onClick={() => void importModel()} disabled={!!busy || !plan || !!plan.problem}>
                    {busy === 'import' ? 'Importing…' : 'Import from Blender…'}
                </button>
            </span>
            {plan?.mod && !plan.problem && <span className="pr-dim">into {plan.mod.name}</span>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// .asset
// ---------------------------------------------------------------------------

function AssetView({ info, navigate }: { info: AssetFileInfo; navigate: Navigate; }): React.JSX.Element
{
    const withFile = info.meshes.filter((m) => m.file);
    const [sel, setSel] = useState<string | undefined>(withFile[0]?.name);
    useEffect(() => setSel(withFile[0]?.name), [info.path]); // eslint-disable-line react-hooks/exhaustive-deps
    const select = useCallback((name: string) =>
    {
        setSel(name);
        document.querySelector('.detail-body')?.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);
    const counts = [
        info.meshes.length && `${info.meshes.length} mesh${info.meshes.length === 1 ? '' : 'es'}`,
        info.entities.length && `${info.entities.length} entit${info.entities.length === 1 ? 'y' : 'ies'}`,
        ...info.other.map((o) => `${o.count} ${o.key}`)
    ].filter(Boolean);
    return (
        <div className="model-view">
            <Head info={info} kind="asset file" extra={counts.length > 0 && <span className="pr-dim">· {counts.join(' · ')}</span>} />
            {sel ?
                (
                    <>
                        {withFile.length > 1 && (
                            <div className="model-picker">
                                {withFile.map((m) => (
                                    <button key={m.name} className={'chip' + (m.name === sel ? ' accent' : '')} onClick={() => setSel(m.name)}>
                                        {m.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <BlenderBar path={info.path} pdxmesh={sel} navigate={navigate} />
                        <MeshViewer path={info.path} pdxmesh={sel} />
                    </>
                ) :
                <div className="pr-dim model-note">No mesh declared here{info.entities.some((e) => e.pdxmeshAsset) ? ' — entities use meshes from other files (linked below)' : ''}.</div>}

            {info.meshes.length > 0 && (
                <Section title="Meshes (pdxmesh)" count={info.meshes.length}>
                    {info.meshes.map((m) => <PdxMeshBlock key={m.name + m.line} m={m} selected={m.name === sel} onShow={m.file ? () => select(m.name) : undefined} navigate={navigate} />)}
                </Section>
            )}

            {info.entities.length > 0 && (
                <Section title="Entities" count={info.entities.length}>
                    {info.entities.map((e) => (
                        <div key={e.name + e.line} className="model-block">
                            <div className="model-block-head">
                                <span className="pr-code">{e.name}</span>
                                {e.scale !== undefined && <span className="chip">scale {e.scale}</span>}
                                {e.attributes > 0 && <span className="chip">{e.attributes} attributes</span>}
                            </div>
                            <div className="model-kv">
                                {e.pdxmesh && (
                                    <>
                                        <span className="pr-dim">mesh</span>
                                        <span>
                                            {e.pdxmeshAsset ?
                                                (
                                                    <>
                                                        <ModelLink path={e.pdxmeshAsset} label={e.pdxmesh} navigate={navigate} /> <span className="pr-dim">in {base(e.pdxmeshAsset)}</span>
                                                    </>
                                                ) :
                                                info.meshes.some((m) => m.name === e.pdxmesh && m.file) ?
                                                (
                                                    <span className="rt-link" onClick={() => select(e.pdxmesh!)}>
                                                        {e.pdxmesh}
                                                    </span>
                                                ) :
                                                <span className="pr-code">{e.pdxmesh}</span>}
                                        </span>
                                    </>
                                )}
                                {e.defaultState && (
                                    <>
                                        <span className="pr-dim">default state</span>
                                        <span className="pr-code">{e.defaultState}</span>
                                    </>
                                )}
                                {e.states.length > 0 && (
                                    <>
                                        <span className="pr-dim">states</span>
                                        <span className="pr-chips">
                                            {e.states.map((s, i) => (
                                                <span key={i} className="chip" title={s.animation ? `animation ${s.animation}` : undefined}>
                                                    {s.name}
                                                    {s.animation && s.animation !== s.name ? <span className="pr-dim">→ {s.animation}</span> : null}
                                                </span>
                                            ))}
                                        </span>
                                    </>
                                )}
                                {e.attaches.length > 0 && (
                                    <>
                                        <span className="pr-dim">attached</span>
                                        <span className="pr-chips">
                                            {e.attaches.map((a, i) => (
                                                <span key={i} className="chip">
                                                    <span className="pr-dim">{a.node} ←</span>
                                                    {a.asset ? <ModelLink path={a.asset} label={a.entity} navigate={navigate} /> : a.entity}
                                                </span>
                                            ))}
                                        </span>
                                    </>
                                )}
                                {e.variation && (
                                    <>
                                        <span className="pr-dim">colour variation</span>
                                        <span className="pr-code">{e.variation}</span>
                                    </>
                                )}
                            </div>
                            {e.patternMask && (
                                <div className="tex-row">
                                    <TextureTile t={e.patternMask} navigate={navigate} size={88} />
                                </div>
                            )}
                        </div>
                    ))}
                </Section>
            )}

            {info.accessories.length > 0 && (
                <Section title="Portrait accessories using these entities" count={info.accessories.length}>
                    <div className="pr-chips">
                        {info.accessories.map((a) => (
                            <span key={a} className="chip">
                                {a}
                            </span>
                        ))}
                    </div>
                </Section>
            )}

            {info.textures.length > 0 && (
                <Section title="Textures" count={info.textures.length}>
                    <div className="tex-row">
                        {info.textures.map((t, i) => <TextureTile key={i} t={t} navigate={navigate} />)}
                    </div>
                </Section>
            )}

            <Section title="Source" open={!info.meshes.length && !info.entities.length}>
                <SourceView defs={[info.source]} navigate={navigate} />
            </Section>
        </div>
    );
}

function PdxMeshBlock({ m, selected, onShow, navigate }: { m: ModelPdxMesh; selected: boolean; onShow?: () => void; navigate: Navigate; }): React.JSX.Element
{
    const [showBlend, setShowBlend] = useState(false);
    // shapes sharing one texture set (LOD copies) are listed once
    const groups: { shapes: string[]; shader?: string; textures: ModelTexture[]; }[] = [];

    for (const s of m.settings)
    {
        const key = s.shader + '|' + s.textures.map((t) => t.path ?? t.ref).join('|');
        const g = groups.find((x) => x.shader + '|' + x.textures.map((t) => t.path ?? t.ref).join('|') === key);

        if (g)
            g.shapes.push(s.shape);
        else
            groups.push({ shapes: [s.shape], shader: s.shader, textures: s.textures });
    }

    return (
        <div className={'model-block' + (selected ? ' selected' : '')}>
            <div className="model-block-head">
                <span className="pr-code">{m.name}</span>
                {m.scale !== undefined && <span className="chip">scale {m.scale}</span>}
                {onShow && !selected && (
                    <button className="chip link-chip" onClick={onShow}>
                        show in 3D
                    </button>
                )}
                {selected && <span className="chip accent">shown above</span>}
            </div>
            <div className="model-kv">
                <span className="pr-dim">mesh file</span>
                <span>{m.file ? <ModelLink path={m.file} navigate={navigate} /> : <span className="pr-bad-text">{m.fileRef || '—'} (not found)</span>}</span>
            </div>
            {groups.map((g, i) => (
                <div key={i} className="model-material">
                    <div className="model-material-head">
                        <span className="pr-dim">{g.shapes.length > 1 ? `${g.shapes.length} shapes` : g.shapes[0]}</span>
                        {g.shader && <span className="chip">{g.shader}</span>}
                    </div>
                    {g.shapes.length > 1 && <div className="pr-dim model-shapes">{g.shapes.join(', ')}</div>}
                    {g.textures.length > 0 && (
                        <div className="tex-row">
                            {g.textures.map((t, k) => <TextureTile key={k} t={t} navigate={navigate} size={96} />)}
                        </div>
                    )}
                </div>
            ))}
            {m.animations.length > 0 && (
                <div className="model-kv">
                    <span className="pr-dim">animations</span>
                    <span className="pr-chips">
                        {m.animations.map((a, i) => (
                            <span key={i} className="chip" title={a.ref}>
                                {a.additive && <span className="pr-dim">+</span>}
                                {a.id}
                            </span>
                        ))}
                    </span>
                </div>
            )}
            {m.blendShapes.length > 0 && (
                <div className="model-kv">
                    <span className="pr-dim">blend shapes</span>
                    <span>
                        <span className="site-link" onClick={() => setShowBlend(!showBlend)}>
                            {showBlend ? 'hide' : 'show'} {m.blendShapes.length}
                        </span>
                        {showBlend && (
                            <span className="pr-chips" style={{ marginTop: 4 }}>
                                {m.blendShapes.map((b, i) => (
                                    <span key={i} className="chip">
                                        {b.file ? <ModelLink path={b.file} label={b.id} navigate={navigate} /> : b.id}
                                    </span>
                                ))}
                            </span>
                        )}
                    </span>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// .mesh
// ---------------------------------------------------------------------------

function MeshView({ info, navigate }: { info: MeshFileInfo; navigate: Navigate; }): React.JSX.Element
{
    const vertices = info.shapes.reduce((s, p) => s + p.vertices, 0);
    const triangles = info.shapes.reduce((s, p) => s + p.triangles, 0);
    // texture sets per material, shared sets listed once
    const sets: { shapes: string[]; shader?: string; textures: ModelTexture[]; }[] = [];

    for (const s of info.shapes)
    {
        if (!s.textures.length)
            continue;

        const key = s.textures.map((t) => t.path ?? t.ref).join('|');
        const g = sets.find((x) => x.textures.map((t) => t.path ?? t.ref).join('|') === key);

        if (g)
        {
            if (!g.shapes.includes(s.name))
                g.shapes.push(s.name);
        }
        else
            sets.push({ shapes: [s.name], shader: s.shader, textures: s.textures });
    }

    const [showBones, setShowBones] = useState(false);
    return (
        <div className="model-view">
            <Head info={info} kind="mesh file" extra={<span className="pr-dim">· {info.shapes.length} parts · {vertices.toLocaleString()} vertices · {triangles.toLocaleString()} triangles</span>} />
            {info.error ? <div className="placeholder">Could not read this mesh: {info.error}</div> : (
                <>
                    <BlenderBar path={info.path} navigate={navigate} />
                    <MeshViewer path={info.path} />
                </>
            )}

            {(info.declaredIn.length > 0 || info.blendShapeOf.length > 0) && (
                <Section title="Declared in">
                    <div className="model-kv">
                        {info.declaredIn.map((d, i) => (
                            <span key={i} className="model-decl">
                                <ModelLink path={d.asset} navigate={navigate} /> <span className="pr-dim">pdxmesh</span> <span className="pr-code">{d.pdxmesh}</span>
                            </span>
                        ))}
                        {info.blendShapeOf.map((d, i) => (
                            <span key={'b' + i} className="model-decl">
                                <span className="pr-dim">blend shape</span> <span className="pr-code">{d.id}</span> <span className="pr-dim">of</span> <ModelLink path={d.asset} label={d.pdxmesh} navigate={navigate} />
                            </span>
                        ))}
                    </div>
                </Section>
            )}
            {info.declaredIn.length === 0 && info.blendShapeOf.length === 0 && !info.error && <div className="pr-dim model-note">No .asset file declares this mesh; textures come from the material names inside the file.</div>}

            {info.shapes.length > 0 && (
                <Section title="Parts" count={info.shapes.length}>
                    <div className="pr-table">
                        {info.shapes.map((s, i) => (
                            <div key={i} className="pr-row model-part">
                                <span className="pr-code" title={s.name}>
                                    {s.name}
                                </span>
                                <span className="pr-num">{s.vertices.toLocaleString()} v</span>
                                <span className="pr-num">{s.triangles.toLocaleString()} tris</span>
                                <span className="pr-dim">
                                    {s.shader}
                                    {s.skinned ? ' · skinned' : ''}
                                    {s.uvSets > 1 ? ` · ${s.uvSets} UV sets` : ''}
                                    {s.lod ? ` · LOD ${s.lod}` : ''}
                                    {s.decal ? ' · decal' : ''}
                                </span>
                                <span className="pr-dim" title={`min ${s.min.map(fmt).join(', ')}\nmax ${s.max.map(fmt).join(', ')}`}>
                                    {s.max.map((x, k) => fmt(x - s.min[k])).join(' × ')}
                                </span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {sets.length > 0 && (
                <Section title="Textures" count={sets.reduce((n, s) => n + s.textures.length, 0)}>
                    {sets.map((g, i) => (
                        <div key={i} className="model-material">
                            {sets.length > 1 && (
                                <div className="model-material-head">
                                    <span className="pr-dim" title={g.shapes.join('\n')}>
                                        {g.shapes.length > 1 ? `${g.shapes.length} parts` : g.shapes[0]}
                                    </span>
                                    {g.shader && <span className="chip">{g.shader}</span>}
                                </div>
                            )}
                            <div className="tex-row">
                                {g.textures.map((t, k) => <TextureTile key={k} t={t} navigate={navigate} />)}
                            </div>
                        </div>
                    ))}
                </Section>
            )}

            {info.bones.length > 0 && (
                <Section title="Skeleton" count={info.bones.length} open={false}>
                    <div className="pr-chips">
                        {(showBones ? info.bones : info.bones.slice(0, 40)).map((b) => (
                            <span key={b} className="chip">
                                {b}
                            </span>
                        ))}
                        {info.bones.length > 40 && (
                            <span className="site-link" onClick={() => setShowBones(!showBones)}>
                                {showBones ? 'fewer' : `all ${info.bones.length}`}
                            </span>
                        )}
                    </div>
                </Section>
            )}
        </div>
    );
}
