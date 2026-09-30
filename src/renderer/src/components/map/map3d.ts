/**
 * The 3D map's scene (docs/map.md, "3D map"), three.js: the terrain as patches of one grid, instanced, displaced by
 * the height raster in the vertex shader and chosen per frame from a quadtree (finer near the eye, skirts hide the
 * seams between sizes); the water plane at the water level; the province raster and the mode's palettes as in the 2D
 * map (gl2d.ts), with a distance field of the mode's borders (map3d-field.ts); the game's terrain materials
 * (map3d-detail.ts), light (map3d-look.ts) and map objects (map3d-objects.ts), loaded after the relief shows; drawn
 * when something changed.
 */
import * as THREE from 'three';
import type { MapInfo, MapTerrainInfo } from '../../../../shared/api';
import { WATER, rgbOf, type Groups, type Style } from './model';
import { MapCamera } from './map3dCamera';
import { SKY_FRAG, SKY_VERT, TERRAIN_FRAG, TERRAIN_VERT, WATER_FRAG, WATER_VERT } from './map3dShaders';
import { detailSupported, loadDetail, tileVectors } from './map3d-detail';
import { RIVER_REGION, groupField } from './map3d-field';
import { loadCube, loadLut, loadTiling, lookUniforms, mapFile, objectSun } from './map3d-look';
import { MapObjects } from './map3d-objects';
import { overlaysOf, riverWidth, type Overlays } from './overlay-data';
import { anisotropy, graphics, mapPixelRatio } from '../../graphics';

/** The terrain shader draws the rivers raster's lines — off: map3dOverlays.ts draws the rivers as smooth lines of their own. */
export const RASTER_RIVERS = false;

/** palette texture width (province id → texel) */
const PAL_W = 4096;
/** quads along a terrain patch's side */
const GRID = 64;
/** a patch is split while the eye is nearer than this many times its size */
const SPLIT = 2.2;
const MAX_PATCHES = 4096;
/**
 * The horizon's colour — the fog far away and around the map, the sky at the horizon, the canvas behind — and the
 * sky's above (display values: the shaders write them as they are).
 */
const HORIZON: [number, number, number] = [0.2, 0.24, 0.29];
const ZENITH: [number, number, number] = [0.07, 0.085, 0.11];
/** the environment cubemap of the terrain's light (jomini/map_lighting.fxh TerrainSunnyEnvironmentMap) */
const TERRAIN_CUBEMAP = 'gfx/map/environment/environment_terrain_sunny.dds';
/** the map modes' painted pattern (gfx/FX bordercolor.fxh PatternTexture) and the water's wave normals (jomini_water_default.fxh) */
const PATTERN = 'gfx/map/textures/political_mapmode_pattern.dds';
const WAVES = 'gfx/map/water/ambient_normal.dds';

/** Something drawn over the terrain by another module (map3dOverlays.ts): its object, a per-frame update, disposal. */
export interface Overlay
{
    object: THREE.Object3D;
    update?: (camera: THREE.PerspectiveCamera) => void;
    dispose: () => void;
}

/** The terrain's rasters (ck3://map/<key>-height.bin, -rivers.bin) with their settings. */
export interface Terrain
{
    info: MapTerrainInfo;
    heights: Uint16Array;
    rivers: Uint8Array | null;
}

function dataTexture(data: Uint8Array | Uint16Array | Uint32Array, w: number, h: number, format: THREE.PixelFormat, type: THREE.TextureDataType): THREE.DataTexture
{
    const t = new THREE.DataTexture(data, w, h, format, type);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
}

/**
 * The heights with their mip levels (averaged on the CPU: generating them needs a renderable format): 16-bit
 * normalized where EXT_texture_norm16 is there, else half floats.
 */
function heightTexture(renderer: THREE.WebGLRenderer, heights: Uint16Array, w: number, h: number): THREE.DataTexture
{
    const norm16 = renderer.extensions.has('EXT_texture_norm16');
    let conv = (a: Uint16Array): Uint16Array => a;

    if (!norm16)
    {
        const lut = new Uint16Array(65536);

        for (let i = 0; i < 65536; i++)
            lut[i] = THREE.DataUtils.toHalfFloat(i / 65535);

        conv = (a) =>
        {
            const out = new Uint16Array(a.length);

            for (let i = 0; i < a.length; i++)
                out[i] = lut[a[i]];

            return out;
        };
    }

    const levels: { data: Uint16Array; width: number; height: number; }[] = [{ data: conv(heights), width: w, height: h }];
    let src = heights;
    let lw = w;
    let lh = h;

    while (lw > 1 || lh > 1)
    {
        const nw = Math.max(1, lw >> 1);
        const nh = Math.max(1, lh >> 1);
        const next = new Uint16Array(nw * nh);

        for (let y = 0; y < nh; y++)
        {
            const r0 = Math.min(lh - 1, y * 2) * lw;
            const r1 = Math.min(lh - 1, y * 2 + 1) * lw;

            for (let x = 0; x < nw; x++)
            {
                const x0 = Math.min(lw - 1, x * 2);
                const x1 = Math.min(lw - 1, x * 2 + 1);
                next[y * nw + x] = (src[r0 + x0] + src[r0 + x1] + src[r1 + x0] + src[r1 + x1] + 2) >> 2;
            }
        }

        levels.push({ data: conv(next), width: nw, height: nh });
        [src, lw, lh] = [next, nw, nh];
    }

    const t = new THREE.DataTexture(null, w, h, THREE.RedFormat, norm16 ? THREE.UnsignedShortType : THREE.HalfFloatType);
    t.normalized = norm16;
    t.mipmaps = levels as unknown as THREE.DataTexture['mipmaps'];
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    // (the copies are on the GPU now)
    t.onUpdate = () =>
    {
        t.mipmaps = [];
    };
    return t;
}

/**
 * The map pixels the river lines cover (a bit each, row by row): along each river of the finest level, discs of its
 * half width and a bank's margin (0.6 pixels) every half pixel; null without rivers.
 */
function riverMask(o: Overlays | null, w: number, h: number): Uint8Array | null
{
    const r = o?.info.rivers;
    const L = o?.levels[0];

    if (!r || !L)
        return null;

    const bits = new Uint8Array(Math.ceil((w * h) / 8));
    const disc = (cx: number, cy: number, rad: number): void =>
    {
        for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++)
            for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++)
            {
                if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > rad * rad)
                    continue;

                const at = y * w + x;
                bits[at >> 3] |= 1 << (at & 7);
            }
    };
    const P = L.points;

    for (let k = 0; k < L.rivers.length; k += 2)
    {
        const first = L.rivers[k];
        const last = first + L.rivers[k + 1] - 1;

        for (let i = first; i < last; i++)
        {
            const [x0, y0, x1, y1] = [P[i * 2], P[i * 2 + 1], P[i * 2 + 2], P[i * 2 + 3]];
            const rad0 = riverWidth(r, L.classes[i]) / 2 + 0.6;
            const rad1 = riverWidth(r, L.classes[i + 1]) / 2 + 0.6;
            const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));

            for (let t = 0; t <= steps; t++)
                disc(x0 + ((x1 - x0) * t) / steps, y0 + ((y1 - y0) * t) / steps, rad0 + ((rad1 - rad0) * t) / steps);
        }
    }

    return bits;
}

/** The terrain patch: a grid of GRID × GRID quads over 0 … 1 (x, z) and its border again as a skirt (y = 1). */
function patchGeometry(): THREE.InstancedBufferGeometry
{
    const n = GRID;
    const pos: number[] = [];
    const idx: number[] = [];
    const v = (i: number, j: number): number => j * (n + 1) + i;

    for (let j = 0; j <= n; j++)
        for (let i = 0; i <= n; i++)
            pos.push(i / n, 0, j / n);

    for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++)
            idx.push(v(i, j), v(i, j + 1), v(i + 1, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1));

    const ring: number[] = [];

    for (let i = 0; i < n; i++)
        ring.push(v(i, 0));

    for (let j = 0; j < n; j++)
        ring.push(v(n, j));

    for (let i = n; i > 0; i--)
        ring.push(v(i, n));

    for (let j = n; j > 0; j--)
        ring.push(v(0, j));

    const base = pos.length / 3;

    for (const r of ring)
        pos.push(pos[r * 3], 1, pos[r * 3 + 2]);

    for (let k = 0; k < ring.length; k++)
    {
        const k1 = (k + 1) % ring.length;
        idx.push(ring[k], base + k, ring[k1], ring[k1], base + k, base + k1);
    }

    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aPatch', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PATCHES * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    return g;
}

/** Stand-ins for textures of every sampler kind until the real ones load (a sampler without its kind fails the draw). */
function standIns(): { detail: THREE.DataTexture; array: THREE.DataArrayTexture; cube: THREE.CubeTexture; lut: THREE.DataTexture; pattern: THREE.DataTexture; waves: THREE.DataTexture; tint: THREE.DataTexture; }
{
    const detail = dataTexture(new Uint16Array([255, 255, 255, 255]), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
    detail.internalFormat = 'RGBA16UI';
    const array = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
    array.needsUpdate = true;
    const faces = Array.from({ length: 6 }, () => dataTexture(new Uint8Array([90, 110, 130, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType));
    const cube = new THREE.CubeTexture(faces as unknown as HTMLImageElement[]);
    cube.needsUpdate = true;
    const grey = (v: number): THREE.DataTexture => dataTexture(new Uint8Array([v, v, v, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    // (the pattern's mean: a neutral overlay; waves: a flat normal; the shadow tint's mean)
    const rgba = (c: number[]): THREE.DataTexture => dataTexture(new Uint8Array(c), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    return { detail, array, cube, lut: grey(128), pattern: grey(115), waves: rgba([128, 128, 255, 255]), tint: rgba([49, 45, 57, 203]) };
}

export class Map3D
{
    readonly cam: MapCamera;
    /** called after each drawn frame (labels) */
    onFrame?: () => void;
    /** settles when the terrain's materials, light and map objects have loaded (or failed) */
    readonly loaded: Promise<void>;
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private patches: THREE.InstancedBufferGeometry;
    private terrain: THREE.Mesh;
    private water: THREE.Mesh;
    private sky: THREE.Mesh;
    private skyRadius = { value: 1 };
    private uniforms: Record<string, THREE.IUniform>;
    /** the light of map objects other than trees (MAP_OBJECTS_SUNNY_*) */
    private objectUniforms: Record<string, THREE.IUniform>;
    private tex: Record<'ids' | 'color' | 'group' | 'height' | 'rivers' | 'field', THREE.DataTexture>;
    private stand = standIns();
    /** textures loaded later (materials, cubemap, table) */
    private owned: THREE.Texture[] = [];
    private objects: MapObjects | null = null;
    private back: THREE.Texture;
    private waterTex: THREE.Texture;
    private style: Style = 'terrain';
    private size: [number, number];
    private canvas: HTMLCanvasElement;
    private t: Terrain;
    private raf = 0;
    private last = 0;
    private overlays: Overlay[] = [];
    private alive = true;

    /** Throws with a message for the user (no WebGL2, the map larger than the GPU's textures). */
    constructor(canvas: HTMLCanvasElement, info: MapInfo, ids: Uint16Array, t: Terrain)
    {
        this.canvas = canvas;
        this.t = t;
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: graphics().antialias, powerPreference: 'high-performance' });
        const max = renderer.capabilities.maxTextureSize;

        if (info.width > max || info.height > max || t.info.width > max)
        {
            renderer.dispose();
            throw new Error(`The map (${info.width} × ${info.height}) is larger than this GPU's textures (${max})`);
        }

        this.renderer = renderer;
        // (the clear colour is colour managed: given as sRGB it comes out as these values)
        renderer.setClearColor(new THREE.Color().setRGB(...HORIZON, THREE.SRGBColorSpace));
        this.size = [info.width, info.height];
        const rows = Math.ceil(info.count / PAL_W);
        const rv = t.info.rivers;
        this.tex = {
            ids: dataTexture(ids, info.width, info.height, THREE.RedIntegerFormat, THREE.UnsignedShortType),
            color: dataTexture(new Uint8Array(PAL_W * rows * 4), PAL_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType),
            group: dataTexture(new Uint32Array(PAL_W * rows), PAL_W, rows, THREE.RedIntegerFormat, THREE.UnsignedIntType),
            height: heightTexture(renderer, t.heights, t.info.width, t.info.height),
            rivers: t.rivers && rv ? dataTexture(t.rivers, rv.width, rv.height, THREE.RedIntegerFormat, THREE.UnsignedByteType) : dataTexture(new Uint8Array(1), 1, 1, THREE.RedIntegerFormat, THREE.UnsignedByteType),
            field: dataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType)
        };
        this.back = dataTexture(new Uint8Array([90, 85, 75, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        this.waterTex = dataTexture(new Uint8Array([40, 70, 80, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
        const look = t.info.look;
        this.uniforms = {
            uIds: { value: this.tex.ids },
            uColor: { value: this.tex.color },
            uGroup: { value: this.tex.group },
            uBack: { value: this.back },
            uHeight: { value: this.tex.height },
            uRivers: { value: this.tex.rivers },
            uWater: { value: this.waterTex },
            uField: { value: this.tex.field },
            uStyle: { value: 0 },
            uSize: { value: new THREE.Vector2(info.width, info.height) },
            uHSize: { value: new THREE.Vector2(t.info.width, t.info.height) },
            uRSize: { value: t.rivers && rv ? new THREE.Vector2(rv.width, rv.height) : new THREE.Vector2(0, 0) },
            uHeightScale: { value: t.info.heightScale },
            uWaterLevel: { value: t.info.waterLevel },
            uHover: { value: 0 },
            uSel: { value: 0 },
            uFog: { value: new THREE.Vector3(...HORIZON) },
            uFogRange: { value: new THREE.Vector2(1e9, 2e9) },
            uZoom: { value: 0 },
            uPxScale: { value: 1 },
            uRiversOn: { value: RASTER_RIVERS ? 1 : 0 },
            uGrid: { value: GRID },
            ...lookUniforms(look),
            uDetail: { value: this.stand.detail },
            uDiffuseArr: { value: this.stand.array },
            uNormalArr: { value: this.stand.array },
            uPropsArr: { value: this.stand.array },
            uHasDetail: { value: 0 },
            uDetailSize: { value: new THREE.Vector2(1, 1) },
            uTileOffset: { value: new THREE.Vector2(0, 0) },
            uTileDefault: { value: 1 },
            uTiles: { value: Array.from({ length: 64 }, () => new THREE.Vector4(1, 1, 1, 1)) },
            uBlendRange: { value: 0.25 },
            uNormalScale: { value: 1 }
        };
        this.uniforms.uEnv.value = this.stand.cube;
        this.uniforms.uLut.value = this.stand.lut;
        this.uniforms.uPattern = { value: this.stand.pattern };
        this.uniforms.uShadowTint.value = this.stand.tint;
        this.uniforms.uWaves = { value: this.stand.waves };
        const os = objectSun(look);
        this.objectUniforms = { uLight: { value: os.dir }, uSunColor: { value: os.color }, uIbl: { value: 0 } };
        this.patches = patchGeometry();
        this.terrain = new THREE.Mesh(this.patches, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, side: THREE.DoubleSide }));
        this.terrain.frustumCulled = false;
        this.scene.add(this.terrain);
        // (around the map too: it lies in a sea)
        const plane = new THREE.PlaneGeometry(info.width * 3, info.height * 3).rotateX(-Math.PI / 2).translate(info.width / 2, t.info.waterLevel, info.height / 2);
        this.water = new THREE.Mesh(plane, new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true }));
        this.water.renderOrder = 1;
        this.water.frustumCulled = false;
        this.scene.add(this.water);
        // (the sky follows the eye: a dome just inside the far plane, drawn first)
        this.sky = new THREE.Mesh(
            new THREE.SphereGeometry(1, 48, 24),
            new THREE.ShaderMaterial({
                glslVersion: THREE.GLSL3,
                uniforms: { uFog: this.uniforms.uFog, uZenith: { value: new THREE.Vector3(...ZENITH) }, uRadius: this.skyRadius },
                vertexShader: SKY_VERT,
                fragmentShader: SKY_FRAG,
                side: THREE.BackSide,
                depthTest: false,
                depthWrite: false
            })
        );
        this.sky.renderOrder = -1;
        this.sky.frustumCulled = false;
        this.scene.add(this.sky);
        this.cam = new MapCamera(t.info.camera, this.size, (x, z) => this.surface(x, z));
        this.resize();
        this.loaded = Promise.all([this.loadLook(), this.loadDetail(), this.loadObjects(info, ids)]).then(() => undefined);
    }

    /** The environment cubemap, the tone mapping table, the map modes' pattern and the shadow tint. */
    private async loadLook(): Promise<void>
    {
        const look = this.t.info.look;
        const [cube, lut, pattern, waves, tint] = await Promise.all([
            loadCube(TERRAIN_CUBEMAP).catch((e: Error) => console.warn('3D map: no environment cubemap:', e?.message ?? e)),
            look.lut && look.tonemap === 'TonyMcMapface' ? loadLut(look.lut).catch((e: Error) => console.warn('3D map: no tone mapping table:', e.message)) : undefined,
            loadTiling(PATTERN, 1024).catch(() => undefined),
            loadTiling(WAVES, 1024).catch(() => undefined),
            // (repeated hundreds of times over the map: a small copy does)
            loadTiling(look.shadowTint.texture, 256).catch(() => undefined)
        ]);

        for (const t of [cube, lut, pattern, waves, tint])
            if (t)
                this.owned.push(t);

        if (!this.alive)
            return;

        if (pattern)
            this.uniforms.uPattern.value = pattern;

        if (waves)
            this.uniforms.uWaves.value = waves;

        if (tint)
            this.uniforms.uShadowTint.value = tint;

        if (cube)
        {
            this.uniforms.uEnv.value = cube;
            this.uniforms.uIbl.value = look.cubemapIntensity * look.sun.ibl;
            this.objectUniforms.uIbl.value = look.cubemapIntensity * look.objectSun.ibl;
        }

        if (lut)
        {
            this.uniforms.uLut.value = lut;
            this.uniforms.uHasLut.value = 1;
        }

        this.invalidate();
    }

    /** The terrain's materials (when the GPU takes BC3 array textures). */
    private async loadDetail(): Promise<void>
    {
        const d = this.t.info.detail;

        if (!d || !detailSupported(this.renderer))
            return;

        const tex = await loadDetail(d, anisotropy(this.renderer.capabilities.getMaxAnisotropy())).catch((e: Error) => void console.warn('3D map: no terrain materials:', e.message));

        if (!tex)
            return;

        this.owned.push(tex.detail, ...tex.arrays);

        if (!this.alive)
            return;

        const u = this.uniforms;
        u.uDetail.value = tex.detail;
        [u.uDiffuseArr.value, u.uNormalArr.value, u.uPropsArr.value] = tex.arrays;
        u.uDetailSize.value = new THREE.Vector2(d.width, d.height);
        u.uTileOffset.value = new THREE.Vector2(...d.offset);
        u.uTileDefault.value = (d.layers[0]?.tile ?? 300) / this.size[0];
        u.uTiles.value = tileVectors(d, this.size[0], d.layers[0]?.tile ?? 300);
        u.uBlendRange.value = d.blendRange;
        u.uNormalScale.value = d.normalScale;
        u.uHasDetail.value = 1;
        this.invalidate();
    }

    /** Trees and other map objects; vegetation off the water (the province raster `ids`: water provinces). */
    private async loadObjects(info: MapInfo, ids: Uint16Array): Promise<void>
    {
        const o = this.t.info.objects;

        // (graphics setting: no trees and objects)
        if (!o || !graphics().mapObjects)
            return;

        const [bin, lines] = await Promise.all([
            mapFile(`${o.key}-objects.bin`).catch((e: Error) => void console.warn('3D map: no map objects:', e.message)),
            overlaysOf(info).catch(() => null)
        ]);

        if (!bin || !this.alive)
            return;

        this.objects = new MapObjects(o, bin, this.size[1], this.uniforms, this.objectUniforms, anisotropy(this.renderer.capabilities.getMaxAnisotropy()), () => this.invalidate());
        this.objects.object.visible = this.style === 'terrain';
        this.scene.add(this.objects.object);
        // no tree in the water: on water provinces, where the ground is below the water level (water is drawn there), on the
        // river lines (their smoothing moves them off the pixels the game's placement kept free)
        const [W, H] = this.size;
        const water = new Uint8Array(info.count);

        for (let p = 0; p < info.count; p++)
            water[p] = WATER.has(info.kinds[info.province.kind[p]]) ? 1 : 0;

        const rivers = riverMask(lines, W, H);
        const level = this.t.info.waterLevel;
        this.objects.hide((x, y) =>
        {
            const xi = Math.floor(x);
            const yi = Math.floor(y);

            if (xi < 0 || yi < 0 || xi >= W || yi >= H)
                return false;

            const at = yi * W + xi;
            return water[ids[at]] === 1 || (rivers !== null && (rivers[at >> 3] & (1 << (at & 7))) !== 0) || this.terrainAt(x, y) < level;
        });
        this.invalidate();
    }

    /** The terrain's height at a map point (world units; bilinear, as the GPU samples it). */
    terrainAt(x: number, z: number): number
    {
        const { width: hw, height: hh, heightScale } = this.t.info;
        const h = this.t.heights;
        const fx = Math.max(0, Math.min(hw - 1, (x * hw) / this.size[0] - 0.5));
        const fz = Math.max(0, Math.min(hh - 1, (z * hh) / this.size[1] - 0.5));
        const x0 = Math.floor(fx);
        const z0 = Math.floor(fz);
        const x1 = Math.min(hw - 1, x0 + 1);
        const z1 = Math.min(hh - 1, z0 + 1);
        const ax = fx - x0;
        const az = fz - z0;
        const top = h[z0 * hw + x0] + (h[z0 * hw + x1] - h[z0 * hw + x0]) * ax;
        const bottom = h[z1 * hw + x0] + (h[z1 * hw + x1] - h[z1 * hw + x0]) * ax;
        return ((top + (bottom - top) * az) * heightScale) / 65535;
    }

    /** What the eye sees at a map point: the terrain, or the water over it. */
    surface(x: number, z: number): number
    {
        return Math.max(this.terrainAt(x, z), this.t.info.waterLevel);
    }

    /** The map point (world x, z = map pixel column, row) under a canvas point, or null. */
    pick(sx: number, sy: number): [number, number] | null
    {
        const { origin: o, direction: d } = this.cam.ray(sx, sy);

        if (d.y >= -1e-6)
            return null;

        const floor = this.t.info.waterLevel;
        const t0 = Math.max(0, (this.t.info.heightScale - o.y) / d.y);
        const t1 = (floor - o.y) / d.y;

        if (t1 <= t0)
            return null;

        const step = Math.max((t1 - t0) / 800, 0.25);
        const above = (t: number): boolean => o.y + d.y * t > this.surface(o.x + d.x * t, o.z + d.z * t);
        let a = t0;
        let b = t1;

        for (let t = t0 + step; t < t1; t += step)
        {
            if (!above(t))
            {
                b = t;
                break;
            }

            a = t;
        }

        for (let i = 0; i < 16; i++)
        {
            const m = (a + b) / 2;

            if (above(m))
                a = m;
            else
                b = m;
        }

        const x = o.x + d.x * b;
        const z = o.z + d.z * b;
        return x >= 0 && z >= 0 && x < this.size[0] && z < this.size[1] ? [x, z] : null;
    }

    /** Adds an overlay (drawn with the scene, updated before each frame, disposed with the map). */
    addOverlay(o: Overlay): void
    {
        this.overlays.push(o);
        this.scene.add(o.object);
        this.invalidate();
    }

    /** Another read of the province raster (the map's data at another date: the same map). */
    setIds(ids: Uint16Array): void
    {
        const img = this.tex.ids.image as { data: Uint16Array; };

        // (another map's raster comes with its own terrain: a new scene)
        if (img.data === ids || img.data.length !== ids.length)
            return;

        img.data = ids;
        this.tex.ids.needsUpdate = true;
        this.invalidate();
    }

    /**
     * The mode's palettes: colour + kind (alpha: bit 0 water, bit 1 coloured, bit 2 inland water — lakes and rivers)
     * and the group + 1 per province; the field of the mode's borders.
     */
    setGroups(info: MapInfo, groups: Groups): void
    {
        const color = this.tex.color.image.data as Uint8Array;
        const group = this.tex.group.image.data as Uint32Array;
        color.fill(0);
        group.fill(0);
        const P = info.province;
        // (the palettes have room for the map the scene was made for)
        const n = Math.min(info.count, group.length);
        // the regions of the border field: the group, water one of its own, rivers none
        const region = new Uint32Array(n);

        for (let p = 0; p < n; p++)
        {
            const kind = info.kinds[P.kind[p]];
            const water = WATER.has(kind) ? 1 | (kind === 'lake' || kind === 'river' ? 4 : 0) : 0;
            const gi = groups.of[p];

            if (gi >= 0)
            {
                const [r, g, b] = rgbOf(groups.color(gi) ?? '#808080');
                color.set([r, g, b, water | 2], p * 4);
                group[p] = gi + 1;
            }
            else
                color[p * 4 + 3] = water;

            region[p] = kind === 'river' ? RIVER_REGION : water ? 0xffffffff : gi + 1;
        }

        this.tex.color.needsUpdate = true;
        this.tex.group.needsUpdate = true;
        const ids = (this.tex.ids.image as { data: Uint16Array; }).data;
        const f = groupField(ids, this.size[0], this.size[1], region);
        const field = this.tex.field;
        field.image = { data: f.data, width: f.w, height: f.h };
        field.minFilter = field.magFilter = THREE.LinearFilter;
        // (another size than the stand-in's: a new texture on the GPU)
        field.dispose();
        field.needsUpdate = true;
        this.invalidate();
    }

    /** What is under the mode's colours: the picture (terrain colour map, paper map; null: plain). */
    setStyle(style: Style, img: HTMLImageElement | null): void
    {
        this.style = style;
        this.uniforms.uStyle.value = style === 'terrain' ? 0 : style === 'paper' ? 1 : 2;

        // (trees and buildings stand on the terrain; the paper and plain maps are maps)
        if (this.objects)
            this.objects.object.visible = style === 'terrain';

        if (img)
        {
            const t = new THREE.Texture(img);
            // (the image's top row at v = 0, as the rasters: the map's north)
            t.flipY = false;
            t.anisotropy = anisotropy(this.renderer.capabilities.getMaxAnisotropy());
            t.minFilter = THREE.LinearMipmapLinearFilter;
            t.needsUpdate = true;
            this.back.dispose();
            this.back = this.uniforms.uBack.value = t;
        }

        this.invalidate();
    }

    /** The game's water colour map (water.settings). */
    setWater(img: HTMLImageElement): void
    {
        const t = new THREE.Texture(img);
        t.flipY = false;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.needsUpdate = true;
        this.waterTex.dispose();
        this.waterTex = this.uniforms.uWater.value = t;
        this.invalidate();
    }

    /** @param hover the hovered group + 1 (0: none), `sel` the selected one */
    setHighlight(hover: number, sel: number): void
    {
        if (this.uniforms.uHover.value === hover && this.uniforms.uSel.value === sel)
            return;

        this.uniforms.uHover.value = hover;
        this.uniforms.uSel.value = sel;
        this.invalidate();
    }

    /** The canvas's size changed. */
    resize(): void
    {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;

        if (!w || !h)
            return;

        this.renderer.setPixelRatio(mapPixelRatio());
        this.renderer.setSize(w, h, false);
        this.cam.setSize(w, h);
        this.invalidate();
    }

    /** Draws on the next animation frame (again while the camera moves). */
    invalidate(): void
    {
        if (!this.raf)
            this.raf = requestAnimationFrame(this.frame);
    }

    private frame = (now: number): void =>
    {
        this.raf = 0;
        const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
        const moving = this.cam.step(dt);
        this.last = moving ? now : 0;
        this.draw();
        this.onFrame?.();

        if (moving)
            this.invalidate();
    };

    /** The patches for the view: split while near the eye, down to about a height pixel per quad; those in view only. */
    private select(): void
    {
        const camera = this.cam.camera;
        const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        const eye = camera.position;
        const [W, H] = this.size;
        const texel = W / this.t.info.width;
        const top = this.t.info.heightScale;
        const attr = this.patches.getAttribute('aPatch') as THREE.InstancedBufferAttribute;
        const out = attr.array as Float32Array;
        const box = new THREE.Box3();
        let n = 0;
        const visit = (x: number, z: number, s: number): void =>
        {
            if (x >= W || z >= H || n >= MAX_PATCHES)
                return;

            const skirt = (s / GRID) * 3 + 1;
            box.min.set(x, -skirt, z);
            box.max.set(Math.min(x + s, W), top, Math.min(z + s, H));

            if (!frustum.intersectsBox(box))
                return;

            if (s / GRID > texel * 1.5 && box.distanceToPoint(eye) < s * SPLIT)
            {
                const h = s / 2;
                visit(x, z, h);
                visit(x + h, z, h);
                visit(x, z + h, h);
                visit(x + h, z + h, h);
                return;
            }

            out.set([x, z, s, skirt], n * 4);
            n++;
        };
        visit(0, 0, Math.max(W, H));
        attr.needsUpdate = true;
        this.patches.instanceCount = n;
    }

    /** The ground in view (map x0 z0 x1 z1): the canvas corners' rays on the water level, far ones cut at 12 camera heights. */
    private groundRect(): [number, number, number, number]
    {
        const c = this.cam.camera;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const reach = (c.position.y - this.t.info.waterLevel) * 12;
        const r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];

        for (
            const [sx, sy] of [
                [0, 0],
                [w, 0],
                [0, h],
                [w, h]
            ]
        )
        {
            const ray = this.cam.ray(sx, sy);
            const at = this.cam.onLevel(sx, sy, this.t.info.waterLevel);
            const p = at && at.distanceTo(ray.origin) < reach ? at : ray.at(reach, new THREE.Vector3());
            r[0] = Math.min(r[0], p.x);
            r[1] = Math.min(r[1], p.z);
            r[2] = Math.max(r[2], p.x);
            r[3] = Math.max(r[3], p.z);
        }

        return r;
    }

    private draw(): void
    {
        this.cam.apply();
        this.skyRadius.value = this.cam.camera.far * 0.9;
        this.select();
        const [near, far] = this.cam.fogRange();
        (this.uniforms.uFogRange.value as THREE.Vector2).set(near, far);
        this.uniforms.uZoom.value = this.cam.zoom;
        // (drawing buffer pixels per world unit at distance 1: how tall objects are on screen)
        this.uniforms.uPxScale.value = this.canvas.height / (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360));

        if (this.objects?.object.visible)
            this.objects.update(this.groundRect(), this.cam.zoom);

        for (const o of this.overlays)
            o.update?.(this.cam.camera);

        this.renderer.render(this.scene, this.cam.camera);
    }

    dispose(): void
    {
        this.alive = false;
        cancelAnimationFrame(this.raf);

        for (const o of this.overlays)
            o.dispose();

        this.objects?.dispose();
        this.patches.dispose();
        this.water.geometry.dispose();
        this.sky.geometry.dispose();
        (this.sky.material as THREE.Material).dispose();
        (this.terrain.material as THREE.Material).dispose();
        (this.water.material as THREE.Material).dispose();

        for (const t of [...Object.values(this.tex), ...Object.values(this.stand), ...this.owned, this.back, this.waterTex])
            t.dispose();

        this.renderer.dispose();
        this.renderer.forceContextLoss();
    }
}
