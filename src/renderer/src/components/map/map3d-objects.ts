/**
 * Trees and other map objects on the 3D map (docs/map.md, "3D map"; map/terrain-objects.ts): per group (a model's
 * instances in a layer) and part one instanced mesh; the instances of the cells in view are copied in as the camera
 * moves (a cell row's cells lie together: one copy per row), groups fade out towards their layer's zoom step.
 * Textures (api.textureData: the DDS's own mip) load when a part is first shown.
 */
import * as THREE from 'three';
import type { MapTerrainInfo } from '../../../../shared/api';
import { api } from '../../api';
import { OBJECT_FRAG, OBJECT_VERT } from './map3dShaders';

type Objects = NonNullable<MapTerrainInfo['objects']>;

/** floats per vertex (position, normal, tangent, uv) and per instance (x, y, z, yaw, scale) */
const VERTEX = 12;
const INSTANCE = 5;
/** instances of a group drawn at most */
const CAP = 200_000;

/** A 1 × 1 texture standing in until a part's own is loaded. */
function pixel(rgba: number[], srgb = false): THREE.DataTexture
{
    const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);

    if (srgb)
        t.colorSpace = THREE.SRGBColorSpace;

    t.needsUpdate = true;
    return t;
}

interface Group
{
    info: Objects['groups'][number];
    data: Float32Array;
    buffer: THREE.InstancedInterleavedBuffer;
    meshes: THREE.Mesh[];
    fade: THREE.IUniform;
    shown: boolean;
    /** the cells last copied in (c0 c1 r0 r1; empty when hidden) */
    cells: string;
}

export class MapObjects
{
    readonly object = new THREE.Group();
    private info: Objects;
    private height: number;
    private instances: Float32Array;
    private cells: Uint32Array;
    private groups: Group[] = [];
    private parts: { geometry: { position: THREE.InterleavedBufferAttribute; normal: THREE.InterleavedBufferAttribute; aTangent: THREE.InterleavedBufferAttribute; uv: THREE.InterleavedBufferAttribute; }; index: THREE.BufferAttribute; }[];
    private textures = new Map<string, Promise<THREE.Texture | null>>();
    private owned: THREE.Texture[] = [];
    private stand = { white: pixel([255, 255, 255, 255], true), normal: pixel([128, 128, 0, 128]), props: pixel([0, 0, 0, 255]) };
    private onChange: () => void;
    private anisotropy: number;
    private alive = true;

    /**
     * @param bin ck3://map/<key>-objects.bin; `mapHeight`: the map's height (its z runs the other way); `terrain` /
     * `objects`: the uniforms trees / other objects share with the scene (light, post-processing, heights …)
     */
    constructor(info: Objects, bin: ArrayBuffer, mapHeight: number, terrain: Record<string, THREE.IUniform>, objects: Record<string, THREE.IUniform>, anisotropy: number, onChange: () => void)
    {
        this.info = info;
        this.height = mapHeight;
        this.onChange = onChange;
        this.anisotropy = anisotropy;
        const vertices = new Float32Array(bin, 0, info.vertices * VERTEX);
        const indices = new Uint32Array(bin, info.vertices * VERTEX * 4, info.indices);
        this.instances = new Float32Array(bin, (info.vertices * VERTEX + info.indices) * 4, info.instances * INSTANCE);
        this.cells = new Uint32Array(bin, (info.vertices * VERTEX + info.indices + info.instances * INSTANCE) * 4);
        this.parts = info.parts.map((p) =>
        {
            const buf = new THREE.InterleavedBuffer(vertices.subarray(p.vertexStart * VERTEX, (p.vertexStart + p.vertexCount) * VERTEX), VERTEX);
            return {
                geometry: {
                    position: new THREE.InterleavedBufferAttribute(buf, 3, 0),
                    normal: new THREE.InterleavedBufferAttribute(buf, 3, 3),
                    aTangent: new THREE.InterleavedBufferAttribute(buf, 4, 6),
                    uv: new THREE.InterleavedBufferAttribute(buf, 2, 10)
                },
                index: new THREE.BufferAttribute(indices.subarray(p.indexStart, p.indexStart + p.indexCount), 1)
            };
        });

        for (const g of info.groups)
        {
            const data = new Float32Array(Math.min(g.count, CAP) * INSTANCE);
            const buffer = new THREE.InstancedInterleavedBuffer(data, INSTANCE).setUsage(THREE.DynamicDrawUsage);
            const fade = { value: 1 };
            const meshes = info.models[g.model].parts.map((pi) =>
            {
                const part = this.parts[pi];
                const geo = new THREE.InstancedBufferGeometry();
                geo.setIndex(part.index);

                for (const [k, a] of Object.entries(part.geometry))
                    geo.setAttribute(k, a);

                geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
                geo.setAttribute('aTurn', new THREE.InterleavedBufferAttribute(buffer, 2, 3));
                geo.instanceCount = 0;
                const tree = info.parts[pi].tree;
                const coverage = !!info.parts[pi].coverage;
                const mat = new THREE.ShaderMaterial({
                    glslVersion: THREE.GLSL3,
                    vertexShader: OBJECT_VERT,
                    fragmentShader: OBJECT_FRAG,
                    side: THREE.DoubleSide,
                    alphaToCoverage: tree || coverage,
                    uniforms: {
                        ...terrain,
                        ...(tree ? {} : objects),
                        uTerrainLight: terrain.uLight,
                        uClamp: { value: g.clamp ? 1 : 0 },
                        uTree: { value: tree ? 1 : 0 },
                        uSnap: { value: info.parts[pi].snap ? 1 : 0 },
                        uCoverage: { value: coverage ? 1 : 0 },
                        uModelHeight: { value: Math.max(info.models[g.model].height, info.models[g.model].radius) },
                        uFade: fade,
                        uDiffuse: { value: this.stand.white },
                        uNormal: { value: this.stand.normal },
                        uProps: { value: this.stand.props },
                        uTint: { value: this.stand.white },
                        uHasTint: { value: 0 }
                    }
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.frustumCulled = false;
                mesh.visible = false;
                mesh.userData.part = pi;
                this.object.add(mesh);
                return mesh;
            });
            this.groups.push({ info: g, data, buffer, meshes, fade, shown: false, cells: '' });
        }
    }

    /** A texture of the objects (loaded once; sRGB for colours). */
    private texture(path: string, srgb: boolean): Promise<THREE.Texture | null>
    {
        const key = `${srgb ? 's' : 'l'}:${path}`;
        let t = this.textures.get(key);

        if (!t)
        {
            t = api
                .textureData(path, 512)
                .then((d) =>
                {
                    if (!d || !this.alive)
                        return null;

                    const tex = new THREE.DataTexture(d.rgba, d.width, d.height);
                    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                    tex.minFilter = THREE.LinearMipmapLinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    tex.generateMipmaps = true;
                    tex.anisotropy = this.anisotropy;
                    tex.needsUpdate = true;
                    this.owned.push(tex);
                    return tex;
                })
                .catch(() => null);
            this.textures.set(key, t);
        }

        return t;
    }

    /** The textures of a group's parts (first time it is shown). */
    private show(g: Group): void
    {
        g.shown = true;

        for (const mesh of g.meshes)
        {
            const u = (mesh.material as THREE.ShaderMaterial).uniforms;
            const t = this.info.parts[mesh.userData.part as number].textures;
            const set = (name: string, path: string | undefined, srgb: boolean, flag?: string): void =>
            {
                if (!path)
                    return;

                void this.texture(path, srgb).then((tex) =>
                {
                    if (!tex)
                        return;

                    u[name].value = tex;

                    if (flag)
                        u[flag].value = 1;

                    this.onChange();
                });
            };
            set('uDiffuse', t.diffuse, true);
            set('uNormal', t.normal, false);
            set('uProps', t.properties, false);
            set('uTint', t.tint, true, 'uHasTint');
        }
    }

    /**
     * Leaves out vegetation (models with tree-shaded parts — trees, bushes, grass) where `drop` says so at its map point
     * (x, y: map pixels, y from the top); objects set on the water level (`clamp_to_water_level`) stay. The game's
     * placement is made for its own water and rivers: where this map draws water or a river line, a tree would stand in it.
     */
    hide(drop: (x: number, y: number) => boolean): void
    {
        let dropped = 0;

        for (const g of this.groups)
        {
            if (g.info.clamp || !this.info.models[g.info.model].parts.some((p) => this.info.parts[p].tree))
                continue;

            const end = (g.info.start + g.info.count) * INSTANCE;

            for (let i = g.info.start * INSTANCE; i < end; i += INSTANCE)
            {
                // (a scale of 0: nothing drawn — the cells keep their ranges)
                if (this.instances[i + 4] && drop(this.instances[i], this.height - this.instances[i + 2]))
                {
                    this.instances[i + 4] = 0;
                    dropped++;
                }
            }

            // (copied in again on the next update)
            g.cells = 'stale';
        }

        if (dropped)
            this.onChange();
    }

    /**
     * The instances in view: `rect` = the ground in view (map x0 z0 x1 z1), `zoom` the camera's zoom step — a group
     * shows until its layer's step, fading over the last one.
     */
    update(rect: [number, number, number, number], zoom: number): void
    {
        const { cell, cols, rows } = this.info;
        const clampC = (v: number, n: number): number => Math.max(0, Math.min(n - 1, Math.floor(v / cell)));
        const c0 = clampC(rect[0], cols);
        const c1 = clampC(rect[2], cols);
        // (cells count rows from the map's bottom)
        const r0 = clampC(this.height - rect[3], rows);
        const r1 = clampC(this.height - rect[1], rows);

        for (const g of this.groups)
        {
            const f = 1 - Math.min(1, Math.max(0, zoom - (g.info.fade - 1)));
            g.fade.value = f;
            // (the same cells as last time: nothing to copy)
            const cells = f > 0 ? `${c0} ${c1} ${r0} ${r1}` : '';

            if (cells === g.cells)
                continue;

            g.cells = cells;
            let n = 0;

            if (f > 0)
            {
                const cap = g.data.length / INSTANCE;

                for (let r = r0; r <= r1 && n < cap; r++)
                {
                    const a = (g.info.cells + r * cols + c0) * 2;
                    const b = (g.info.cells + r * cols + c1) * 2;
                    const start = this.cells[a];
                    const count = Math.min(cap - n, this.cells[b] + this.cells[b + 1] - start);

                    if (count <= 0)
                        continue;

                    const from = (g.info.start + start) * INSTANCE;
                    g.data.set(this.instances.subarray(from, from + count * INSTANCE), n * INSTANCE);
                    n += count;
                }
            }

            if (n && !g.shown)
                this.show(g);

            if (n)
            {
                g.buffer.clearUpdateRanges();
                g.buffer.addUpdateRange(0, n * INSTANCE);
                g.buffer.needsUpdate = true;
            }

            for (const m of g.meshes)
            {
                (m.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
                m.visible = n > 0;
            }
        }
    }

    dispose(): void
    {
        this.alive = false;

        for (const g of this.groups)
            for (const m of g.meshes)
            {
                m.geometry.dispose();
                (m.material as THREE.Material).dispose();
            }

        for (const t of [...this.owned, ...Object.values(this.stand)])
            t.dispose();
    }
}
