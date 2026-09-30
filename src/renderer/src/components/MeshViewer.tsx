import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelGeometry, PortraitPart, ShaderProgram } from '../../../shared/api';
import { api } from '../api';
import { addViewLights, disposeScene, gameRenderer, geometry, loadEnvironment, material } from '../three/pdx';
import { createGameScene, drawnPositions, gameGeometry, gameMaterial, isSkinned, programFor } from '../three/gameShader';
import { digest, useGfxRevision } from '../revision';
import { viewerPixelRatio } from '../graphics';

/** Parts shown only on request: simplified LOD copies, terrain decal planes, sky domes around court rooms. */
const isExtra = (p: PortraitPart): boolean => !!p.lod || !!p.decal || /skybox/i.test(p.name);

type Programs = (ShaderProgram | Error | null)[];

/**
 * 3D preview of a model file in bind pose: a .mesh with the textures its pdxmesh declares, or one pdxmesh of an
 * .asset. By default every part renders with the game's own shader (its Effect compiled from gfx/FX); parts whose
 * Effect doesn't compile fall back to the viewer's approximation.
 */
export function MeshViewer(props: { path: string; pdxmesh?: string; onLoaded?: (g: ModelGeometry | null) => void; }): React.JSX.Element
{
    const mount = useRef<HTMLDivElement>(null);
    const [data, setData] = useState<ModelGeometry | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [textured, setTextured] = useState(true);
    const [wire, setWire] = useState(false);
    const [extras, setExtras] = useState(false);
    const [gameShaders, setGameShaders] = useState(true);
    const [programs, setPrograms] = useState<Programs | undefined>(undefined);
    const [big, setBig] = useState(false);
    const { onLoaded } = props;

    // again after an index update that changed gfx files (a mesh or texture written into the mod): the model stays until
    // then, and is not redrawn when it is the same
    const gfx = useGfxRevision();
    const shown = useRef('');
    useEffect(() =>
    {
        setData(undefined);
        shown.current = '';
    }, [props.path, props.pdxmesh]);
    useEffect(() =>
    {
        let cancelled = false;
        setError(null);
        api
            .modelGeometry(props.path, props.pdxmesh)
            .then((g) =>
            {
                if (cancelled)
                    return;

                const key = digest(g);

                if (key === shown.current)
                    return;

                shown.current = key;
                setData(g);
                onLoaded?.(g);
            })
            .catch((e: Error) => !cancelled && setError(e.message));
        return () =>
        {
            cancelled = true;
        };
    }, [props.path, props.pdxmesh, onLoaded, gfx]);

    // compile the game's shaders of all parts (cached per Effect and vertex layout)
    useEffect(() =>
    {
        setPrograms(undefined);

        if (!data?.parts.length || !gameShaders)
            return;

        let cancelled = false;
        void Promise.all(
            data.parts.map((p) =>
            {
                const pr = programFor(p);
                return pr ? pr.catch((e: Error) => e) : Promise.resolve(null);
            })
        ).then((list) => !cancelled && setPrograms(list));
        return () =>
        {
            cancelled = true;
        };
    }, [data, gameShaders]);

    useEffect(() =>
    {
        if (!big)
            return;

        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                setBig(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [big]);

    const waiting = gameShaders && textured && !!data?.parts.length && programs === undefined;

    useEffect(() =>
    {
        const el = mount.current;

        if (!el || !data?.parts.length || waiting)
            return;

        const renderer = gameRenderer(el.clientWidth, el.clientHeight);
        // the portrait exposure includes the game's bloom lift: too hot for lit-from-the-front models
        renderer.toneMappingExposure = 1.9;
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        const disposeEnvironment = loadEnvironment(renderer, scene);
        const game = createGameScene(renderer);

        // meshes creatures show get the decal list of the first character showing them (docs/portraits.md, "Creatures")
        if (data.decals?.length)
            game.setDecalList(data.decals);

        const group = new THREE.Group();
        const framed = new THREE.Box3();
        const all = new THREE.Box3();
        const v = new THREE.Vector3();
        data.parts.forEach((part, i) =>
        {
            const extra = isExtra(part);

            if (extra && !extras)
                return;

            const prog = gameShaders && textured ? programs?.[i] : null;
            let mesh: THREE.Mesh;

            if (prog && !(prog instanceof Error))
            {
                const mat = gameMaterial(prog, part, game);
                mat.wireframe = wire;
                mesh = new THREE.Mesh(gameGeometry(part, prog), mat);
                mesh.frustumCulled = false; // game-space vertices: three's culling would test the unmirrored bounds
            }
            else
            {
                const mat = textured ? material(part) : new THREE.MeshStandardMaterial({ color: 0xb8ab98, roughness: 0.75, metalness: 0 });

                if (wire)
                    (mat as THREE.MeshStandardMaterial).wireframe = true;

                mesh = new THREE.Mesh(geometry(part), mat);
                mesh.castShadow = !part.decal;
                mesh.receiveShadow = true;
            }

            mesh.renderOrder = part.cutout ? 2 : 0;
            group.add(mesh);
            // bounds in three.js space (Z mirrored) from the vertices as drawn (GPU-skinned parts posed)
            const box = new THREE.Box3();
            const pos = drawnPositions(part, prog instanceof Error ? null : prog);

            for (let k = 0; k < pos.length; k += 3)
                box.expandByPoint(v.set(pos[k], pos[k + 1], -pos[k + 2]));

            all.union(box);

            if (!extra)
                framed.union(box);
        });
        scene.add(group);

        if (framed.isEmpty())
            framed.copy(all);

        // from the front-left, a little above, just far enough for every corner of the box to fit the view
        const sphere = framed.getBoundingSphere(new THREE.Sphere());
        const r = Math.max(sphere.radius, 1e-3);
        const fov = 30;
        const aspect = el.clientWidth / el.clientHeight;
        const camera = new THREE.PerspectiveCamera(fov, aspect, r / 200, r * 40);
        const center = framed.getCenter(new THREE.Vector3());
        const back = new THREE.Vector3(0.45, 0.3, 1).normalize();
        const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
        const up = back.clone().cross(right);
        const tanV = Math.tan((fov * Math.PI) / 360);
        const tanH = tanV * aspect;
        let dist = 0;

        for (let i = 0; i < 8; i++)
        {
            const c = new THREE.Vector3(i & 1 ? framed.max.x : framed.min.x, i & 2 ? framed.max.y : framed.min.y, i & 4 ? framed.max.z : framed.min.z).sub(center);
            const depth = c.dot(back);
            dist = Math.max(dist, depth + Math.abs(c.dot(right)) / tanH, depth + Math.abs(c.dot(up)) / tanV);
        }

        camera.position.copy(center).addScaledVector(back, Math.max(dist * 1.08, r * 0.2));
        camera.lookAt(center);
        sphere.center.copy(center);
        addViewLights(scene, camera, center, camera.position.distanceTo(center), r * 1.2);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(sphere.center);
        controls.enableDamping = true;
        controls.minDistance = r * 0.05;
        controls.maxDistance = r * 12;
        controls.update();

        let frame = 0;
        const loop = (): void =>
        {
            frame = requestAnimationFrame(loop);
            controls.update();
            game.update(camera);
            renderer.render(scene, camera);
        };
        loop(); // debugging aid (scripts/drive.mjs eval steps): the live view
        (window as unknown as { __meshView?: unknown; }).__meshView = { THREE, renderer, scene, camera, game };
        const ro = new ResizeObserver(() =>
        {
            const w = el.clientWidth;
            const h = el.clientHeight;

            if (!w || !h)
                return;

            renderer.setPixelRatio(viewerPixelRatio(w, h));
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        });
        ro.observe(el);
        return () =>
        {
            cancelAnimationFrame(frame);
            ro.disconnect();
            controls.dispose();
            disposeEnvironment();
            disposeScene(scene);
            game.dispose();
            const w = window as unknown as { __meshView?: { renderer: unknown; }; };

            if (w.__meshView?.renderer === renderer)
                w.__meshView = undefined;

            renderer.dispose();
            el.removeChild(renderer.domElement);
        };
    }, [data, textured, wire, extras, gameShaders, programs, waiting]);

    const vertices = data?.parts.reduce((s, p) => s + p.positions.length / 3, 0) ?? 0;
    const extraCount = data?.parts.filter(isExtra).length ?? 0;
    const failed = (programs ?? []).map((p, i) => (p instanceof Error ? `${data?.parts[i]?.shader}: ${p.message}` : null)).filter(Boolean) as string[];
    const viaGame = (programs ?? []).filter((p) => p && !(p instanceof Error)).length;
    // GPU-skinned parts show the entity's default animation at its first frame, the others the bind pose
    const posed = gameShaders && textured && !!data?.pose && (programs ?? []).some((p) => p && !(p instanceof Error) && isSkinned(p));
    return (
        <div className="mesh-viewer">
            {big && <div className="portrait-backdrop" onClick={() => setBig(false)} />}
            <div className={'portrait-box model-box' + (big ? ' big' : '')} ref={mount}>
                {data === undefined && !error && <div className="portrait-empty">Loading the model…</div>}
                {waiting && <div className="portrait-empty">Compiling the game&apos;s shaders…</div>}
                {error && <div className="portrait-empty">Preview failed: {error}</div>}
                {data === null && <div className="portrait-empty">No geometry to show.</div>}
                {data?.parts.length === 0 && <div className="portrait-empty">This mesh file holds no geometry.</div>}
                {!!data?.parts.length && (
                    <button className="portrait-expand" title={big ? 'Back (Esc)' : 'Enlarge'} onClick={() => setBig(!big)}>
                        {big ? '✕' : '⤢'}
                    </button>
                )}
            </div>
            {!!data?.parts.length && (
                <div className="portrait-info">
                    <span className="pr-dim">
                        {data.parts.length} part{data.parts.length === 1 ? '' : 's'} · {vertices.toLocaleString()} vertices
                        {data.bones ? ` · ${data.bones} bones (${posed ? `GPU-skinned: ${data.pose}, first frame` : 'bind pose'})` : ''}
                        {data.decalsFrom && <span title="A creature shows this mesh: the preview uses the decal list of the first character whose portrait shows it">· colours of {data.decalsFrom}</span>}
                        {gameShaders && programs && (
                            <span title={failed.join('\n\n')}>
                                {' '}
                                · {viaGame === data.parts.length ? 'game shaders' : `game shaders on ${viaGame} of ${data.parts.length} parts`}
                                {failed.length > 0 && <span className="pr-bad-text">({failed.length} failed to compile — hover)</span>}
                            </span>
                        )}
                    </span>
                    <span className="portrait-toggles">
                        <label title="Render with the game's own shaders (gfx/FX effects compiled for WebGL), or with the viewer's approximation">
                            <input type="checkbox" checked={gameShaders} onChange={(e) => setGameShaders(e.target.checked)} /> Game shaders
                        </label>
                        <label title="Materials with their textures, or plain clay to judge the shape">
                            <input type="checkbox" checked={textured} onChange={(e) => setTextured(e.target.checked)} /> Textures
                        </label>
                        <label title="Show the triangles">
                            <input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> Wireframe
                        </label>
                        {extraCount > 0 && (
                            <label title="Simplified LOD copies, terrain decal planes and sky domes (hidden by default)">
                                <input type="checkbox" checked={extras} onChange={(e) => setExtras(e.target.checked)} /> LODs &amp; decals ({extraCount})
                            </label>
                        )}
                    </span>
                </div>
            )}
        </div>
    );
}
