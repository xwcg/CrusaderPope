/**
 * Rendering with the game's own shaders (compiled from gfx/FX effect files by the index worker, see docs/shaders.md).
 *
 * Meshes stay in game space (Y up, left-handed): the mirror to three.js' right-handed space is part of the
 * ViewProjectionMatrix we hand the engine code, triangle winding is flipped instead. The engine's constant buffers
 * are plain uniforms of the same names — camera, sun, environment cubemap, shadow settings — filled from a
 * GameScene per view; per-object data (`Data[]`: world matrix, opacity, user colours) and the material textures per
 * mesh.
 */
import * as THREE from 'three';
import type { PartSkin, PortraitData, PortraitDecal, PortraitPart, ShaderProgram, ShaderRequest, TextureData } from '../../../shared/api';
import { api } from '../api';
import { imgUrl } from '../img';
import { viewerShaderRequest } from '../../../shared/shaders';
import { effectMarker } from './shaderErrors';
import { gameRenderer, hsvLight, loadTracked, markLoading } from './pdx';

const MIRROR_Z = new THREE.Matrix4().makeScale(1, 1, -1);

export interface ViewEnvironment
{
    cubemap: string;
    cubemapSize: number;
    cubemapIntensity: number;
    sunColor: THREE.Color;
    sunIntensity: number;
    exposure: number;
    /** 'camera': one directional light from the viewer's upper left; 'portrait': the portrait light rig (setPortraitLights) */
    lights: 'camera' | 'portrait';
}

/** Preview lighting like the game's own 3D previews (gfx/map/environment/environment_unit_preview.txt). */
export const PREVIEW_ENVIRONMENT: ViewEnvironment = {
    lights: 'camera',
    cubemap: 'gfx/map/environment/environment_mapobjects_sunny.dds',
    cubemapSize: 512,
    cubemapIntensity: 10,
    /** sun_color = hsv{ 0.08 0.12 1 } of the map environment */
    sunColor: hsvLight(0.08, 0.12, 1).color,
    sunIntensity: 20,
    exposure: 1.8
};

/**
 * Portraits: gfx/portraits/environments/portrait_environments.txt, environment_standard — castle cubemap at
 * @main_cubemap_intensity 0.4, fixed exposure 1.5 plus the bloom lift the portrait viewer approximates (×1.85).
 */
export const PORTRAIT_ENVIRONMENT: ViewEnvironment = {
    lights: 'portrait',
    cubemap: 'gfx/portraits/environments/castle_interior_01_fire.dds',
    cubemapSize: 512,
    cubemapIntensity: 0.4,
    sunColor: new THREE.Color(1, 1, 1),
    sunIntensity: 0,
    exposure: 1.5 * 1.85
};

/**
 * environment_standard's lights: type 2 spot / 1 directional, colour hsv (value = intensity), position cylindrical
 * { radius height angle } around camera_torso_look_at, look_at height offset, spot range / falloff / cone angles.
 */
const PORTRAIT_LIGHTS = [
    { type: 2, hsv: [0.1, 0.45, 1.5], radius: 160, height: 260, angle: 30, lookAt: 0, range: 1000, falloff: 10, inner: 5, outer: 25, shadow: true },
    { type: 2, hsv: [0.05, 0.8, 0.3], radius: 160, height: 200, angle: -120, lookAt: -35, range: 1000, falloff: 50, inner: 0, outer: 18, shadow: false },
    { type: 1, hsv: [0.6, 0.3, 1.6], radius: 200, height: 100, angle: -160, lookAt: 18, range: 0, falloff: 0, inner: 0, outer: 0, shadow: true }
] as const;

function flat(r: number, g: number, b: number, a: number): THREE.DataTexture
{
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
    t.needsUpdate = true;
    return t;
}

/** Stand-ins for textures a material doesn't have: neutral diffuse, flat "RRxG" normal, rough dielectric properties. */
const NEUTRAL = {
    white: flat(255, 255, 255, 255),
    black: flat(0, 0, 0, 0),
    normal: flat(128, 128, 255, 128),
    properties: flat(0, 0, 0, 200)
};

/** 1×1 integer textures for buffer samplers that get no data (decal lists …): all zero = empty */
const INTEGER = {
    uint: (() =>
    {
        const t = new THREE.DataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        t.internalFormat = 'RGBA32UI';
        t.needsUpdate = true;
        return t;
    })(),
    int: (() =>
    {
        const t = new THREE.DataTexture(new Int32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.IntType);
        t.internalFormat = 'RGBA32I';
        t.needsUpdate = true;
        return t;
    })()
};

/** decal blend modes as the engine numbers them (jomini/texture_decals_base.fxh BLEND_MODE_*) */
const DECAL_BLEND = { overlay: 0, replace: 1, hard_light: 2, multiply: 3 } as const;

/** n zero vectors, the first one optionally set */
function vec4s(n: number, first?: THREE.Vector4): THREE.Vector4[]
{
    const out = Array.from({ length: n }, () => new THREE.Vector4());

    if (first)
        out[0].copy(first);

    return out;
}

function loadTexture(path: string, srgb: boolean): THREE.Texture
{
    // baked portrait textures arrive as data URLs
    const t = loadTracked(path.startsWith('data:') ? path : imgUrl(path));
    t.flipY = false; // DirectX UVs
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
}

/** Layer size of the pattern texture arrays (the DDS mip of that size; smaller textures set the size). */
const PATTERN_SIZE = 512;

/**
 * Pixels for a texture array: every path decoded at one common size (the DDS's own mip levels, so masks keep their
 * exact values), missing layers filled with `fill`.
 */
async function arrayLayers(paths: (string | undefined)[], fill: number[]): Promise<{ size: number; data: Uint8Array; }>
{
    const get = (p: string | undefined, s: number): Promise<TextureData | null> => (p ? api.textureData(p, s).catch(() => null) : Promise.resolve(null));
    let layers = await Promise.all(paths.map((p) => get(p, PATTERN_SIZE)));
    const sizes = layers.flatMap((l) => (l ? [Math.min(l.width, l.height)] : []));
    const size = sizes.length ? Math.min(PATTERN_SIZE, ...sizes) : 1;
    layers = await Promise.all(layers.map((l, i) => (l && (l.width !== size || l.height !== size) ? get(paths[i], size) : Promise.resolve(l))));
    const data = new Uint8Array(size * size * 4 * paths.length);
    layers.forEach((l, i) =>
    {
        const o = i * size * size * 4;

        if (l && l.width === size && l.height === size)
            data.set(l.rgba.subarray(0, size * size * 4), o);
        else if (l)
        {
            // no mip of that size (non-square, or no mip chain): nearest-neighbour resample
            for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++)
                {
                    const s = (Math.floor((y * l.height) / size) * l.width + Math.floor((x * l.width) / size)) * 4;
                    data.set(l.rgba.subarray(s, s + 4), o + (y * size + x) * 4);
                }
        }
        else
            for (let k = 0; k < size * size; k++)
                data.set(fill, o + k * 4);
    });
    return { size, data };
}

/** Layer size of the whole-list decal arrays (setDecalList); the marker mip is its level log2(size) − 4. */
const DECAL_LIST_SIZE = 512;

/** An RGBA image at size×size (nearest neighbour when it has another size). */
function squareRgba(l: TextureData, size: number): Uint8Array
{
    if (l.width === size && l.height === size)
        return l.rgba.subarray(0, size * size * 4);

    const out = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
        {
            const s = (Math.floor((y * l.height) / size) * l.width + Math.floor((x * l.width) / size)) * 4;
            out.set(l.rgba.subarray(s, s + 4), (y * size + x) * 4);
        }

    return out;
}

/** Next smaller mip of a square RGBA image (2×2 box). */
function halveRgba(src: Uint8Array, size: number): Uint8Array
{
    const h = size >> 1;
    const out = new Uint8Array(h * h * 4);

    for (let y = 0; y < h; y++)
        for (let x = 0; x < h; x++)
            for (let c = 0; c < 4; c++)
            {
                const o = (y * 2 * size + x * 2) * 4 + c;
                out[(y * h + x) * 4 + c] = (src[o] + src[o + 4] + src[o + size * 4] + src[o + size * 4 + 4] + 2) >> 2;
            }

    return out;
}

/**
 * A decal texture array for the whole list: every path a layer with a full mip chain, raw bytes (the engine does not
 * sRGB-decode decal arrays). AGOT reads its codes with texelFetch at `AGOT_MarkerLod()` = 6 − (10 − log2(size)), the
 * 16×16 level: that level is the DDS's own 16×16 mip, not a filtered one (the codes are painted into it); the levels
 * between are box-filtered from the top. Uploaded as an uncompressed CompressedArrayTexture — three.js uploads user
 * mip levels only for those (a DataArrayTexture would filter its own and lose the codes).
 */
async function decalArray(paths: string[]): Promise<THREE.CompressedArrayTexture | null>
{
    if (!paths.length)
        return null;

    const top = DECAL_LIST_SIZE;
    const levels = Math.log2(top) + 1;
    const chains = await Promise.all(
        paths.map(async (p) =>
        {
            const [big, small] = await Promise.all([api.textureData(p, top).catch(() => null), api.textureData(p, 16).catch(() => null)]);
            const chain: Uint8Array[] = [big ? squareRgba(big, top) : new Uint8Array(top * top * 4)];

            for (let s = top >> 1; s >= 1; s >>= 1)
                chain.push(s === 16 && small?.width === 16 && small.height === 16 ? small.rgba.subarray(0, 1024) : halveRgba(chain[chain.length - 1], s * 2));

            return chain;
        })
    );
    const mipmaps = Array.from({ length: levels }, (_, level) =>
    {
        const s = top >> level;
        const data = new Uint8Array(s * s * 4 * paths.length);
        chains.forEach((chain, i) => data.set(chain[level], i * s * s * 4));
        return { data, width: s, height: s };
    });
    // RGBA is not a compressed format, but three.js uploads it level by level with texSubImage3D
    const tex = new THREE.CompressedArrayTexture(mipmaps, top, top, paths.length, THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * A game cubemap with its own prefiltered mip chain (the engine picks mips by roughness): every mip of every face
 * through the ck3:// protocol, which serves the DDS mip nearest to the requested size.
 */
function gameCube(path: string, size: number): THREE.CubeTexture
{
    const levels = Math.floor(Math.log2(size)) + 1;
    const cube = new THREE.CubeTexture();
    cube.colorSpace = THREE.NoColorSpace;
    cube.generateMipmaps = false;
    cube.minFilter = THREE.LinearMipmapLinearFilter;
    cube.magFilter = THREE.LinearFilter;
    const load = (face: number, w: number): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) =>
        {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = imgUrl(path) + `?w=${w}&face=${face}`;
        });
    const faces = [0, 1, 2, 3, 4, 5];
    void Promise.all(Array.from({ length: levels }, (_, m) => Promise.all(faces.map((f) => load(f, Math.max(1, size >> m))))))
        .then((mips) =>
        {
            cube.images = mips[0];
            cube.mipmaps = mips.slice(1).map((images) => ({ image: images })) as unknown as THREE.CubeTexture['mipmaps'];
            cube.needsUpdate = true;
        })
        .catch(() =>
        {});
    return cube;
}

export interface GameScene
{
    /** engine constant buffer members shared by all materials of the view */
    uniforms: Record<string, THREE.IUniform>;
    /** game texture, loaded once per view (disposed with it) */
    texture(path: string, srgb: boolean): THREE.Texture;
    /**
     * A baked normal map (x in R, y in G — see decals.ts) re-packed to the game's "RRxG" layout (x in G, y in A) as a raw
     * data texture, so no browser alpha handling touches it.
     */
    bakedNormal(dataUrl: string): THREE.Texture;
    /**
     * portrait environment: places the portrait light rig around the chest (game space; k = figure scale). `reach`:
     * spot ranges and falloffs grow with k too (creatures many times a human's size would sit outside the ranges).
     */
    setPortraitLights(chest: THREE.Vector3, k: number, reach?: boolean): void;
    /** a colour palette row as a 1-pixel-high texture (raw values, as the engine samples palettes) */
    palette(colors: [number, number, number][]): THREE.Texture;
    /**
     * A 2D texture array (one layer per path) as a uniform shared by all materials of the view: a stand-in first, the
     * real array once decoded.
     */
    textureArray(paths: (string | undefined)[], fill: [number, number, number, number]): THREE.IUniform;
    /**
     * Portraits: the decal list the shaders read — only the data decals the bake leaves out (PortraitData.dataDecals):
     * DecalDataBuffer records, DecalDiffuseArray with their 16×16 mips, DecalCount / PreSkinColorDecalCount.
     */
    setDecals(decals: NonNullable<PortraitData['dataDecals']>): void;
    /**
     * Creatures and their model previews: the whole decal list their shaders walk (PortraitDecal — AGOT's dragons are
     * coloured by it), every decal texture a layer of the diffuse / normal / properties arrays (see decalArray).
     */
    setDecalList(decals: PortraitDecal[]): void;
    /** call before rendering: camera matrices and the camera-relative sun */
    update(camera: THREE.PerspectiveCamera): void;
    dispose(): void;
}

/** Uniforms of one view: camera, lights (camera sun or portrait rig), environment cubemap, shadows off. */
export function createGameScene(renderer: THREE.WebGLRenderer, env: ViewEnvironment = PREVIEW_ENVIRONMENT): GameScene
{
    // the shadow sampler needs a real depth texture with compare mode (three's empty stand-in fails every draw with
    // "mismatch between texture format and sampler type"): 1×1, cleared to the far plane = fully lit
    const shadowTarget = new THREE.WebGLRenderTarget(1, 1);
    shadowTarget.depthTexture = new THREE.DepthTexture(1, 1);
    shadowTarget.depthTexture.compareFunction = THREE.LessEqualCompare;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(shadowTarget);
    renderer.clear();
    renderer.setRenderTarget(previous);
    const cube = gameCube(env.cubemap, env.cubemapSize);
    const sun = env.sunColor;
    const u: Record<string, THREE.IUniform> = {
        ViewProjectionMatrix: { value: new THREE.Matrix4() },
        InvViewProjectionMatrix: { value: new THREE.Matrix4() },
        ViewMatrix: { value: new THREE.Matrix4() },
        InvViewMatrix: { value: new THREE.Matrix4() },
        ProjectionMatrix: { value: new THREE.Matrix4() },
        InvProjectionMatrix: { value: new THREE.Matrix4() },
        CameraPosition: { value: new THREE.Vector3() },
        CameraLookAtDir: { value: new THREE.Vector3() },
        CameraUpDir: { value: new THREE.Vector3() },
        CameraRightDir: { value: new THREE.Vector3() },
        ZNear: { value: 0.1 },
        ZFar: { value: 1000 },
        CameraFoV: { value: 0.5 },
        ToSunDir: { value: new THREE.Vector3(0, 1, 0) },
        SunDiffuse: { value: new THREE.Vector3(sun.r, sun.g, sun.b) },
        SunIntensity: { value: env.sunIntensity },
        CubemapIntensity: { value: env.cubemapIntensity },
        CubemapYRotation: { value: new THREE.Matrix4() },
        EnvironmentMap: { value: cube },
        // shadows off. NumSamples must stay ≥ 1 (the engine divides by it: 0 gave NaN = black, flickering pixels) and
        // the shadow lookup lands outside the map, where the engine fades the shadow term to exactly 1
        ShadowFadeFactor: { value: 0 },
        Bias: { value: 0 },
        KernelScale: { value: 0 },
        ShadowScreenSpaceScale: { value: 1 },
        NumSamples: { value: 1 },
        DiscSamples: { value: vec4s(16) },
        ShadowMapTextureMatrix: { value: new THREE.Matrix4().set(0, 0, 0, -10, 0, 0, 0, -10, 0, 0, 0, 0, 0, 0, 0, 1) },
        ShadowTexture: { value: shadowTarget.depthTexture },
        WorldSpaceToTerrain0To1: { value: new THREE.Vector2() },
        FogOfWarAlpha: { value: NEUTRAL.white },
        GlobalTime: { value: 0 },
        PdxViewerExposure: { value: env.exposure },
        // portrait shaders (jomini/portrait.shader): three lights of their own — here one directional light = the
        // preview sun (type 1; the shader lights along -Direction), the others off (type 0); decals baked on the CPU
        // (counts 0 unless setDecals hands over data decals)
        // (arrays longer than any program declares: three reads as many entries as the program has — the court
        // shader declares the same names with 20 lights)
        Light_Color_Falloff: { value: vec4s(32, new THREE.Vector4(sun.r * env.sunIntensity, sun.g * env.sunIntensity, sun.b * env.sunIntensity, 0)) },
        Light_Direction_Type: { value: vec4s(32, new THREE.Vector4(0, -1, 0, 1)) },
        Light_Position_Radius: { value: vec4s(32) },
        Light_InnerCone_OuterCone_AffectedByShadows: { value: vec4s(32) },
        vSkinPropertyMult: { value: new THREE.Vector4(1, 1, 1, 1) },
        vEyesPropertyMult: { value: new THREE.Vector4(1, 1, 1, 1) },
        vHairPropertyMult: { value: new THREE.Vector4(1, 1, 1, 1) },
        DecalCount: { value: 0 },
        PreSkinColorDecalCount: { value: 0 },
        TotalDecalCount: { value: 0 },
        // the decal list (setDecals): empty unless a portrait has data decals
        DecalDataBuffer: { value: INTEGER.uint },
        DecalDiffuseArray: { value: null },
        // normal and properties layers of the whole list (setDecalList, creatures)
        DecalNormalArray: { value: null },
        DecalPropertiesArray: { value: null }
    };
    const textures = new Map<string, THREE.Texture>();
    const arrays = new Map<string, THREE.IUniform>();
    let disposed = false;
    const start = performance.now();
    // sun from the viewer's upper left, a little in front (camera space), like the preview rig
    const sunView = new THREE.Vector3(-0.55, 0.65, 0.5).normalize();
    const tmp = new THREE.Vector3();
    return {
        uniforms: u,
        texture(path, srgb)
        {
            const key = path.toLowerCase() + (srgb ? '|srgb' : '');
            let tex = textures.get(key);

            if (!tex)
                textures.set(key, tex = loadTexture(path, srgb));

            return tex;
        },
        update(camera)
        {
            camera.updateMatrixWorld();
            const view = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, MIRROR_Z);
            // the engine's halves: its view space looks down +z and its projection takes w = z, three's look down -z with
            // w = -z — the same product (a flip of z on both sides), but code rebuilding the camera from its vectors (AGOT's
            // particle cards: View_Matrix_From, Projection_Matrix_From) needs the engine's convention
            const engineView = view.clone().premultiply(MIRROR_Z);
            (u.ViewMatrix.value as THREE.Matrix4).copy(engineView);
            (u.InvViewMatrix.value as THREE.Matrix4).copy(engineView).invert();
            (u.ProjectionMatrix.value as THREE.Matrix4).multiplyMatrices(camera.projectionMatrix, MIRROR_Z);
            (u.InvProjectionMatrix.value as THREE.Matrix4).multiplyMatrices(MIRROR_Z, camera.projectionMatrixInverse);
            const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view);
            (u.ViewProjectionMatrix.value as THREE.Matrix4).copy(vp);
            (u.InvViewProjectionMatrix.value as THREE.Matrix4).copy(vp).invert();
            const game = (v: THREE.Vector3): THREE.Vector3 => v.set(v.x, v.y, -v.z);
            (u.CameraPosition.value as THREE.Vector3).copy(game(tmp.copy(camera.position)));
            (u.CameraLookAtDir.value as THREE.Vector3).copy(game(camera.getWorldDirection(tmp)));
            (u.CameraUpDir.value as THREE.Vector3).copy(game(tmp.set(0, 1, 0).transformDirection(camera.matrixWorld)));
            (u.CameraRightDir.value as THREE.Vector3).copy(game(tmp.set(1, 0, 0).transformDirection(camera.matrixWorld)));
            (u.ToSunDir.value as THREE.Vector3).copy(game(tmp.copy(sunView).transformDirection(camera.matrixWorld)));

            if (env.lights === 'camera')
            {
                const toSun = u.ToSunDir.value as THREE.Vector3;
                (u.Light_Direction_Type.value as THREE.Vector4[])[0].set(-toSun.x, -toSun.y, -toSun.z, 1);
            }

            u.ZNear.value = camera.near;
            u.ZFar.value = camera.far;
            u.CameraFoV.value = (camera.fov * Math.PI) / 180;
            u.GlobalTime.value = (performance.now() - start) / 1000;
        },
        bakedNormal(dataUrl)
        {
            let tex = textures.get(dataUrl);

            if (tex)
                return tex;

            const data = new THREE.DataTexture(new Uint8Array([128, 128, 0, 128]), 1, 1);
            data.flipY = false;
            data.needsUpdate = true;
            textures.set(dataUrl, data);
            tex = data;
            // decoded from the bytes: the page's CSP (connect-src 'self') refuses fetch() of data URLs
            const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
            const bytes = new Uint8Array(bin.length);

            for (let i = 0; i < bin.length; i++)
                bytes[i] = bin.charCodeAt(i);

            const decoded = createImageBitmap(new Blob([bytes], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
            markLoading(data, decoded);
            void decoded
                .then((bmp) =>
                {
                    const c = new OffscreenCanvas(bmp.width, bmp.height);
                    const g = c.getContext('2d')!;
                    g.drawImage(bmp, 0, 0);
                    const src = g.getImageData(0, 0, bmp.width, bmp.height).data;
                    const out = new Uint8Array(src.length);

                    for (let i = 0; i < src.length; i += 4)
                    {
                        out[i] = src[i];
                        out[i + 1] = src[i];
                        out[i + 2] = 0;
                        out[i + 3] = src[i + 1];
                    }

                    data.image = { data: out, width: bmp.width, height: bmp.height };
                    data.generateMipmaps = true;
                    data.minFilter = THREE.LinearMipmapLinearFilter;
                    data.magFilter = THREE.LinearFilter;
                    data.needsUpdate = true;
                })
                .catch(() =>
                {});
            return tex;
        },
        setPortraitLights(chest, k, reach)
        {
            const colors = u.Light_Color_Falloff.value as THREE.Vector4[];
            const dirs = u.Light_Direction_Type.value as THREE.Vector4[];
            const posRadius = u.Light_Position_Radius.value as THREE.Vector4[];
            const cones = u.Light_InnerCone_OuterCone_AffectedByShadows.value as THREE.Vector4[];
            const r = reach ? k : 1;
            PORTRAIT_LIGHTS.forEach((l, i) =>
            {
                const { color } = hsvLight(l.hsv[0], l.hsv[1], 1);
                // positive angles to the viewer's left (as the three.js rig); game space mirrors three's Z
                const a = (-l.angle * Math.PI) / 180;
                const pos = new THREE.Vector3(chest.x + Math.sin(a) * l.radius * k, chest.y + l.height * k, chest.z - Math.cos(a) * l.radius * k);
                const target = new THREE.Vector3(chest.x, chest.y + l.lookAt * k, chest.z);
                const dir = target.clone()
                    .sub(pos)
                    .normalize();
                colors[i].set(color.r * l.hsv[2], color.g * l.hsv[2], color.b * l.hsv[2], l.falloff * r);
                dirs[i].set(dir.x, dir.y, dir.z, l.type);
                posRadius[i].set(pos.x, pos.y, pos.z, l.range * r);
                cones[i].set(Math.cos((l.inner * Math.PI) / 180), Math.cos((l.outer * Math.PI) / 180), l.shadow ? 1 : 0, 0);
            });
        },
        palette(colors)
        {
            const key = 'palette:' + JSON.stringify(colors);
            let tex = textures.get(key);

            if (tex)
                return tex;

            const px = new Uint8Array(colors.length * 4);
            colors.forEach((c, i) => px.set([Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255], i * 4));
            const t = new THREE.DataTexture(px, colors.length, 1);
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.needsUpdate = true;
            textures.set(key, tex = t);
            return tex;
        },
        setDecals(decals)
        {
            const n = decals.length;

            if (!n)
                return;

            // 15 values per decal (portrait_decals.fxh GetDecalData): diffuse / normal / properties index (65535 = none),
            // body part, diffuse / normal / properties blend mode, weight (16-bit unorm), atlas position, UV offset, UV
            // tiling, atlas size — one value per texel of the buffer emulation (element i at (i % 4096, i / 4096))
            const px = new Uint32Array(15 * n * 4);
            decals.forEach((d, i) =>
            {
                const rec = [i, 65535, 65535, 0, DECAL_BLEND[d.blend], 0, 0, Math.round(d.weight * 65535), 0, 0, 0, 0, 1, 1, 1];
                rec.forEach((v, k) => (px[(i * 15 + k) * 4] = v));
            });
            const buf = new THREE.DataTexture(px, 15 * n, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
            buf.internalFormat = 'RGBA32UI';
            buf.needsUpdate = true;
            textures.set('decal-data', buf);
            u.DecalDataBuffer.value = buf;
            u.DecalCount.value = n;
            u.TotalDecalCount.value = n;
            u.PreSkinColorDecalCount.value = decals.filter((d) => !d.post).length;
            // their 16×16 mips, where AGOT's codes sit (its AGOT_MarkerLod reads level 0 of a 16-pixel array)
            void Promise.all(decals.map((d) => api.textureData(d.diffuse, 16).catch(() => null))).then((layers) =>
            {
                if (disposed)
                    return;

                const data = new Uint8Array(16 * 16 * 4 * n);
                layers.forEach((l, i) =>
                {
                    if (!l)
                        return;

                    for (let y = 0; y < 16; y++)
                        for (let x = 0; x < 16; x++)
                        {
                            const s = (Math.floor((y * l.height) / 16) * l.width + Math.floor((x * l.width) / 16)) * 4;
                            data.set(l.rgba.subarray(s, s + 4), (i * 256 + y * 16 + x) * 4);
                        }
                });
                const tex = new THREE.DataArrayTexture(data, 16, 16, n);
                tex.magFilter = tex.minFilter = THREE.NearestFilter;
                tex.generateMipmaps = false;
                tex.needsUpdate = true;
                textures.set('decal-diffuse', tex);
                u.DecalDiffuseArray.value = tex;
            });
        },
        setDecalList(decals)
        {
            const n = decals.length;

            if (!n)
                return;

            // one layer per distinct texture and kind; records as GetDecalData reads them (see setDecals)
            const layerOf = (kind: 'diffuse' | 'normal' | 'properties'): { paths: string[]; index: (p?: string) => number; } =>
            {
                const paths = [...new Set(decals.map((d) => d[kind]).filter((p): p is string => !!p))];
                return { paths, index: (p) => (p ? paths.indexOf(p) : 65535) };
            };
            const kinds = { diffuse: layerOf('diffuse'), normal: layerOf('normal'), properties: layerOf('properties') };
            const px = new Uint32Array(15 * n * 4);
            decals.forEach((d, i) =>
            {
                const rec = [
                    kinds.diffuse.index(d.diffuse),
                    kinds.normal.index(d.normal),
                    kinds.properties.index(d.properties),
                    0,
                    DECAL_BLEND[d.blend.diffuse],
                    DECAL_BLEND[d.blend.normal],
                    DECAL_BLEND[d.blend.properties],
                    Math.round(d.weight * 65535),
                    0,
                    0,
                    0,
                    0,
                    d.tiling?.[0] ?? 1,
                    d.tiling?.[1] ?? 1,
                    1
                ];
                rec.forEach((v, k) => (px[(i * 15 + k) * 4] = v));
            });
            const buf = new THREE.DataTexture(px, 15 * n, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
            buf.internalFormat = 'RGBA32UI';
            buf.needsUpdate = true;
            textures.set('decal-data', buf);
            u.DecalDataBuffer.value = buf;
            u.DecalCount.value = n;
            u.TotalDecalCount.value = n;
            u.PreSkinColorDecalCount.value = decals.filter((d) => !d.post).length;

            for (
                const [kind, name] of [
                    ['diffuse', 'DecalDiffuseArray'],
                    ['normal', 'DecalNormalArray'],
                    ['properties', 'DecalPropertiesArray']
                ] as const
            )
            {
                void decalArray(kinds[kind].paths).then((tex) =>
                {
                    if (!tex)
                        return;

                    if (disposed)
                        return tex.dispose();

                    textures.set('decal-list-' + kind, tex);
                    u[name].value = tex;
                });
            }
        },
        textureArray(paths, fill)
        {
            const key = paths.join('|') + '|' + fill.join(',');
            let uniform = arrays.get(key);

            if (uniform)
                return uniform;

            const stub = new THREE.DataArrayTexture(new Uint8Array(fill), 1, 1, 1);
            stub.needsUpdate = true;
            textures.set('array-stub:' + key, stub);
            uniform = { value: stub };
            arrays.set(key, uniform);
            const u = uniform;
            const layers = arrayLayers(paths, fill);
            markLoading(u, layers);
            void layers.then(({ size, data }) =>
            {
                if (disposed)
                    return;

                // a new texture: its storage has another size than the stand-in's
                const tex = new THREE.DataArrayTexture(data, size, size, paths.length);
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.magFilter = THREE.LinearFilter;
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                tex.generateMipmaps = true;
                tex.anisotropy = 8;
                tex.needsUpdate = true;
                textures.set('array:' + key, tex);
                u.value = tex;
            });
            return uniform;
        },
        dispose()
        {
            disposed = true;
            cube.dispose();
            shadowTarget.dispose();

            for (const tex of textures.values())
                tex.dispose();

            textures.clear();
            arrays.clear();
        }
    };
}

// ---------------------------------------------------------------------------
// Programs, geometry, materials
// ---------------------------------------------------------------------------

const programs = new Map<string, Promise<ShaderProgram>>();

/** Compiled programs belong to one build — the loaded mods can replace FX files: dropped when the index is rebuilt. */
export function resetShaderPrograms(): void
{
    programs.clear();
}

/** The Effect a part's material names, compiled for this mesh's vertex layout (cached). */
export function programFor(part: PortraitPart): Promise<ShaderProgram> | null
{
    if (!part.shader || !part.shaderFile)
        return null;

    // the shared request shape: indexing compiled these ahead of time under the same key
    const req = viewerShaderRequest(part.shaderFile, part.shader, !!part.uvs2, part.shaderDefines);
    const key = JSON.stringify(req);
    let p = programs.get(key);

    if (!p)
    {
        p = api.shader(req);
        programs.set(key, p);
    }

    // a program compiled skinned draws only parts bringing its bone streams and joints (not portraits)
    return p.then((prog) =>
    {
        const problem = skinProblem(prog, part);

        if (problem)
            throw new Error(problem);

        return prog;
    });
}

/** Game-space geometry with the attributes the program reads (a_Position, a_Normal, a_Tangent, a_UV0, a_UV1 …). */
export function gameGeometry(part: PortraitPart, prog: ShaderProgram): THREE.BufferGeometry
{
    const g = new THREE.BufferGeometry();
    const n = part.positions.length / 3;
    const skin = isSkinned(prog) ? part.skin : undefined;

    for (const a of prog.attributes)
    {
        // GPU skinning: bone streams, positions in the rig's scaled space
        const skinned = skin && skinAttribute(a.field, part.positions, skin);

        if (skinned)
        {
            g.setAttribute(a.name, skinned);
            continue;
        }

        let data: Float32Array | undefined;
        let size = 3;

        switch (a.field)
        {
            case 'Position':
                data = part.positions;
                break;
            case 'Normal':
                data = part.normals;
                break;
            case 'Tangent':
                size = 4;
                data = part.tangents ?? new Float32Array(n * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0));
                break;
            case 'UV0':
                size = 2;
                data = part.uvs;
                break;
            case 'UV1':
            case 'UV2':
                size = 2;
                data = part.uvs2 ?? part.uvs;
                break;
        }

        if (!data)
        {
            size = /^(float|u?int)$/.test(a.type) ? 1 : Number(/(\d)$/.exec(a.type)?.[1] ?? 4);

            // integer inputs (bone indices) need integer data: three binds Uint32/Int32 arrays with vertexAttribIPointer
            if (/^(u?int|[iu]vec\d)$/.test(a.type))
            {
                g.setAttribute(a.name, new THREE.BufferAttribute(/^u/.test(a.type) ? new Uint32Array(n * size) : new Int32Array(n * size), size));
                continue;
            }

            data = new Float32Array(n * size);
        }

        g.setAttribute(a.name, new THREE.BufferAttribute(Float32Array.from(data), size));
    }

    // mirroring into right-handed space flips the winding: swap two corners so front faces stay front faces
    const idx = Uint32Array.from(part.indices);

    for (let i = 0; i < idx.length; i += 3)
    {
        const t = idx[i + 1];
        idx[i + 1] = idx[i + 2];
        idx[i + 2] = t;
    }

    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
}

/** Texture for a sampler: the material's texture by role or index, a fixed game file, or a neutral stand-in. */
function samplerValue(s: ShaderProgram['samplers'][number], part: PortraitPart, scene: GameScene): THREE.Texture
{
    const tex = part.textures ?? {};
    const byRole = (role: string, srgb: boolean): THREE.Texture | undefined => (tex[role] ? scene.texture(tex[role], srgb) : undefined);

    if (s.ref === 'JominiEnvironmentMap' || s.type === 'samplerCube')
        return scene.uniforms.EnvironmentMap.value as THREE.Texture;

    switch (s.name)
    {
        case 'DiffuseMap':
            // portrait skin with decals baked in (data URL) replaces the material's own diffuse
            if (part.diffuse?.startsWith('data:'))
                return scene.texture(part.diffuse, true);

            return byRole('diffuse', true) ?? NEUTRAL.white;
        case 'NormalMap':
            if (part.bakedNormal && part.normal?.startsWith('data:'))
                return scene.bakedNormal(part.normal);

            return byRole('normal', false) ?? NEUTRAL.normal;
        case 'PropertiesMap':
        case 'SpecularMap':
            return byRole('properties', false) ?? NEUTRAL.properties;
    }

    if (s.index !== undefined && tex[`texture ${s.index}`])
        return scene.texture(tex[`texture ${s.index}`], false);

    if (s.file)
        return scene.texture(s.file, false);

    return NEUTRAL.white;
}

const BLEND: Record<string, THREE.BlendingDstFactor | THREE.BlendingSrcFactor> = {
    ZERO: THREE.ZeroFactor,
    ONE: THREE.OneFactor,
    SRC_COLOR: THREE.SrcColorFactor,
    INV_SRC_COLOR: THREE.OneMinusSrcColorFactor,
    SRC_ALPHA: THREE.SrcAlphaFactor,
    INV_SRC_ALPHA: THREE.OneMinusSrcAlphaFactor,
    DEST_ALPHA: THREE.DstAlphaFactor,
    INV_DEST_ALPHA: THREE.OneMinusDstAlphaFactor,
    DEST_COLOR: THREE.DstColorFactor,
    INV_DEST_COLOR: THREE.OneMinusDstColorFactor
};

/** RawShaderMaterial running the compiled Effect, with the Effect's blend / raster / depth states. */
export function gameMaterial(prog: ShaderProgram, part: PortraitPart, scene: GameScene): THREE.RawShaderMaterial
{
    // Data[]: world matrix columns 0..3, constants 4 (opacity …), user data 5.. (colours, atlas slot)
    const data = Array.from({ length: 48 }, () => new THREE.Vector4());
    data[0].set(1, 0, 0, 0);
    data[1].set(0, 1, 0, 0);
    data[2].set(0, 0, 1, 0);
    data[3].set(0, 0, 0, 1);
    data[4].set(1, 0, 0, 0);
    data[5].set(1, 1, 1, 1);
    data[6].set(1, 1, 1, 1);
    data[7].set(0, 0, 1, 1);
    // portrait user data at 5 + 24: random number, colour override offset (-1 = none), colour mask interval 0..1
    // (palette-coloured parts whose palette is already baked in — decal-baked skin — get the interval 0..0: no second tint)
    const baked = (part.kind === 'skin' || part.kind === 'eye' || part.kind === 'hair' || part.kind === 'teeth') && !part.color && !!part.diffuse?.startsWith('data:');
    data[5 + 24].set(0.5, -1, 0, baked ? 0 : 1);
    // accessory variation (jomini/portrait_user_data.fxh, SVariationRenderConstants): per mask channel the pattern's UV
    // transform (+0..3) and cloth fresnel (+8..11), texture array layers (+16 colour mask, +18 normal, +20 properties),
    // opacity flags (+22); the second colour mask (SECOND_COLOR_MASK meshes: patterns 4 and 5 = properties red, normal
    // blue) has its own transforms (+4..7), fresnel (+12..15) and layers (+17, +19, +21 → array layers 4 and 5; +23).
    // The palette texture holds only the picked row, so the random number (its V coordinate) is irrelevant.
    const v = part.variation;

    if (v)
    {
        for (let i = 0; i < 4; i++)
        {
            const p = v.patterns[i];
            const q = i < 2 ? v.patterns[4 + i] : null;
            data[5 + i].set(p?.scale || 1, p?.rotation ?? 0, p?.offset[0] ?? 0, p?.offset[1] ?? 0);
            data[5 + 4 + i].set(q?.scale || 1, q?.rotation ?? 0, q?.offset[0] ?? 0, q?.offset[1] ?? 0);
            // inner_exp / inner_scale / rim_exp / rim_scale: no vanilla file sets them — neutral (colour × 1)
            data[5 + 8 + i].set(1, 0, 0, 1);
            data[5 + 12 + i].set(1, 0, 0, 1);
        }

        for (const row of [16, 18, 20])
            data[5 + row].set(0, 1, 2, 3);

        for (const row of [17, 19, 21])
            data[5 + row].set(4, 5, 0, 0);

        for (const row of [22, 23])
            data[5 + row].set(0, 0, 0, 0);
    }

    // opaque materials write alpha 1: their texture alpha is data (masks), on a transparent canvas it shows the page
    const keepAlpha = /^yes$/i.test(prog.states.blend?.BlendEnable ?? '') || /^yes$/i.test(prog.states.blend?.AlphaToCoverage ?? '');
    // palette colours of portrait parts: the part's own colour for its kind (skin/eye/hair), neutral defaults else
    const palette = (kind: PortraitPart['kind'], fallback: [number, number, number]): THREE.Vector4 =>
    {
        const c = part.kind === kind && part.color ? part.color : fallback;
        return new THREE.Vector4(c[0], c[1], c[2], 1);
    };
    const uniforms: Record<string, THREE.IUniform> = {
        ...scene.uniforms,
        Data: { value: data },
        PdxViewerKeepAlpha: { value: keepAlpha ? 1 : 0 },
        vPaletteColorSkin: { value: palette('skin', [0.82, 0.64, 0.52]) },
        vPaletteColorEyes: { value: palette('eye', [0.36, 0.46, 0.56]) },
        vPaletteColorHair: { value: palette('hair', [0.32, 0.21, 0.12]) }
    };
    // one array layer per pattern; the second colour mask's two only when the variation has them
    const layers = v ? (v.patterns[4] || v.patterns[5] ? v.patterns : v.patterns.slice(0, 4)) : [];

    for (const s of prog.samplers)
    {
        // accessory variation: pattern mask, palette row and the patterns' texture arrays (one layer per mask channel)
        if (v && s.name === 'PatternColorMasks')
            uniforms[s.name] = scene.textureArray(layers.map((p) => p?.colormask), [0, 0, 0, 0]);
        else if (v && s.name === 'PatternNormalMaps')
            uniforms[s.name] = scene.textureArray(layers.map((p) => p?.normal), [128, 128, 255, 128]);
        else if (v && s.name === 'PatternPropertyMaps')
            uniforms[s.name] = scene.textureArray(layers.map((p) => p?.properties), [255, 64, 0, 200]);
        else if (v && s.name === 'PatternMask')
            uniforms[s.name] = { value: scene.texture(v.mask, false) };
        else if (v && s.name === 'PatternColorPalette')
            uniforms[s.name] = { value: scene.palette(v.palette) };
        // the view's decal list (setDecals: data decals' 16×16 mips; setDecalList: every layer; empty otherwise)
        else if (s.name === 'DecalDiffuseArray' || s.name === 'DecalNormalArray' || s.name === 'DecalPropertiesArray')
            uniforms[s.name] = scene.uniforms[s.name];
        // depth-compare samplers: the view's depth texture; array / 3D samplers: three's empty texture of that kind
        else
            uniforms[s.name] = {
                value: s.type === 'sampler2DShadow' ? scene.uniforms.ShadowTexture.value : s.type === 'sampler2DArray' || s.type === 'sampler3D' ? null : samplerValue(s, part, scene)
            };
    }

    // every sampler of the compiled code needs an entry of its kind: unset ones all sit on texture unit 0, and a
    // texture of the wrong kind (float vs integer vs depth) makes every draw fail with INVALID_OPERATION
    for (const m of (prog.vertex + prog.fragment).matchAll(/uniform\s+(?:\w+\s+)?([iu]?sampler\w+)\s+(\w+)\s*;/g))
    {
        const [, type, name] = m;

        if (name === 'DecalDataBuffer' && type === 'usampler2D')
            uniforms[name] = scene.uniforms.DecalDataBuffer;
        else if (type === 'usampler2D' || type === 'isampler2D')
            uniforms[name] = { value: type === 'usampler2D' ? INTEGER.uint : INTEGER.int };
        else if (!(name in uniforms))
            uniforms[name] = { value: type === 'sampler2DShadow' ? scene.uniforms.ShadowTexture.value : null };
    }

    // GPU-skinned programs: the part's joint matrices
    const joints = jointUniform(prog, part);

    if (joints)
        uniforms.JointVertexMatrices = joints;

    // renamed members of a constant buffer declared twice (AGOT's copy of PdxCamera) share the first one's values
    for (const [alias, name] of Object.entries(prog.aliases ?? {}))
        if (uniforms[name] && !(alias in uniforms))
            uniforms[alias] = uniforms[name];

    // the marker line names the Effect in WebGL error reports (shaderErrors.ts)
    const marker = effectMarker(prog.file, prog.effect, prog.defines);
    const mat = new THREE.RawShaderMaterial({
        vertexShader: marker + prog.vertex,
        fragmentShader: marker + prog.fragment,
        uniforms,
        glslVersion: THREE.GLSL3
    });
    const { blend, raster, depth } = prog.states;

    if (blend && /^yes$/i.test(blend.BlendEnable ?? ''))
    {
        mat.transparent = true;
        mat.blending = THREE.CustomBlending;
        mat.blendSrc = (BLEND[(blend.SourceBlend ?? 'SRC_ALPHA').toUpperCase()] ?? THREE.SrcAlphaFactor) as THREE.BlendingSrcFactor;
        mat.blendDst = (BLEND[(blend.DestBlend ?? 'INV_SRC_ALPHA').toUpperCase()] ?? THREE.OneMinusSrcAlphaFactor) as THREE.BlendingDstFactor;

        // the alpha channel's own factors (hair: ONE / INV_SRC_ALPHA — the canvas stays opaque where hair covers the face)
        if (blend.SourceAlpha)
            mat.blendSrcAlpha = (BLEND[blend.SourceAlpha.toUpperCase()] ?? null) as THREE.BlendingSrcFactor | null;

        if (blend.DestAlpha)
            mat.blendDstAlpha = (BLEND[blend.DestAlpha.toUpperCase()] ?? null) as THREE.BlendingDstFactor | null;
    }

    if (blend && /^yes$/i.test(blend.AlphaToCoverage ?? ''))
        mat.alphaToCoverage = true;

    const cull = (raster?.CullMode ?? '').toLowerCase();

    if (cull === 'cull_none' || cull === 'none')
        mat.side = THREE.DoubleSide;
    else if (cull === 'cull_front' || cull === 'front')
        mat.side = THREE.BackSide;

    if (depth && /^no$/i.test(depth.DepthWriteEnable ?? ''))
        mat.depthWrite = false;

    return mat;
}

// ---------------------------------------------------------------------------
// GPU skinning (docs/shaders.md, "GPU skinning"): Effects whose vertex code reads the bone streams are compiled
// with PDX_MESH_SKINNED (AGOT's particle cards); model previews bring the mesh's skin (PortraitPart.skin)
// ---------------------------------------------------------------------------

/** Compiled with PDX_MESH_SKINNED: the vertex shader reads BoneIndex / BoneWeight and JointVertexMatrices. */
export function isSkinned(prog: ShaderProgram): boolean
{
    return prog.defines.includes('PDX_MESH_SKINNED');
}

/** Joints the program's JointVertexMatrices holds (3 float4 each); 0 when its code doesn't read them. */
function jointCapacity(prog: ShaderProgram): number
{
    const m = /\bJointVertexMatrices\s*\[\s*(\d+)\s*\]/.exec(prog.vertex);
    return m ? Math.floor(Number(m[1]) / 3) : 0;
}

/** Why a skinned program can't draw a part: no skin data (portraits are skinned on the CPU), too many joints. */
function skinProblem(prog: ShaderProgram, part: PortraitPart): string | undefined
{
    if (!isSkinned(prog))
        return undefined;

    if (!part.skin)
        return `${prog.effect} places vertices by their bones (GPU skinning): this part brings no skin data`;

    const joints = part.skin.joints.length / 12;
    const capacity = jointCapacity(prog);
    return capacity && joints > capacity ? `${prog.effect}: ${joints} joints, the program holds ${capacity}` : undefined;
}

/** The engine's skinned vertex streams: 4 bone indices (integer), 3 weights, positions in the rig's scaled space. */
function skinAttribute(field: string, positions: Float32Array, skin: PartSkin): THREE.BufferAttribute | undefined
{
    if (field === 'BoneIndex')
        return new THREE.BufferAttribute(Uint32Array.from(skin.bones), 4);

    if (field === 'BoneWeight')
        return new THREE.BufferAttribute(Float32Array.from(skin.weights), 3);

    if (field === 'Position')
        return new THREE.BufferAttribute(positions.map((x) => x * skin.scale), 3);

    return undefined;
}

const IDENTITY_JOINT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** JointVertexMatrices as the program declares it: the part's joints, identity (bind pose) for the rest. */
function jointUniform(prog: ShaderProgram, part: PortraitPart): THREE.IUniform | undefined
{
    const capacity = jointCapacity(prog);

    if (!capacity)
        return undefined;

    const joints = part.skin?.joints ?? new Float32Array(0);
    const data = new Float32Array(capacity * 12);

    for (let i = 0; i < capacity; i++)
        data.set(i * 12 + 12 <= joints.length ? joints.subarray(i * 12, i * 12 + 12) : IDENTITY_JOINT, i * 12);

    return { value: data };
}

/**
 * Where a part's vertices are drawn (game space): a skinned program poses them with the part's joints — the model
 * preview frames that (AGOT's particle rigs sit at the origin in bind pose) — others take them as they are.
 */
export function drawnPositions(part: PortraitPart, prog: ShaderProgram | null | undefined): Float32Array
{
    const skin = prog && isSkinned(prog) ? part.skin : undefined;

    if (!skin)
        return part.positions;

    const n = part.positions.length / 3;
    const out = new Float32Array(n * 3);
    const m = skin.joints;

    for (let v = 0; v < n; v++)
    {
        const x = part.positions[v * 3] * skin.scale;
        const y = part.positions[v * 3 + 1] * skin.scale;
        const z = part.positions[v * 3 + 2] * skin.scale;
        const w = [skin.weights[v * 3], skin.weights[v * 3 + 1], skin.weights[v * 3 + 2]];
        // the engine's fourth weight: what the three of the stream leave
        w.push(1 - w[0] - w[1] - w[2]);

        for (let k = 0; k < 4; k++)
        {
            const j = skin.bones[v * 4 + k] * 12;

            if (!w[k] || j + 12 > m.length)
                continue;

            out[v * 3] += w[k] * (m[j] * x + m[j + 3] * y + m[j + 6] * z + m[j + 9]);
            out[v * 3 + 1] += w[k] * (m[j + 1] * x + m[j + 4] * y + m[j + 7] * z + m[j + 10]);
            out[v * 3 + 2] += w[k] * (m[j + 2] * x + m[j + 5] * y + m[j + 8] * z + m[j + 11]);
        }
    }

    return out;
}

/**
 * Debug aid (DevTools or scripts/drive.mjs): every program in the shader store compiled and drawn once in an
 * offscreen WebGL renderer — WebGL compile/link errors land in logs/shaders.log like those of the viewers.
 */
async function checkAllShaders(): Promise<{ checked: number; webglErrors: number; compileFailures: number; }>
{
    const { programs, failures } = await api.shaderPrograms();
    const renderer = gameRenderer(32, 32);
    const hook = renderer.debug.onShaderError;
    let webglErrors = 0;
    renderer.debug.onShaderError = (gl, program, vs, fs) =>
    {
        webglErrors++;
        hook?.(gl, program, vs, fs);
    };
    const scene = createGameScene(renderer);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    scene.update(camera);
    // one triangle with every vertex stream a program may read
    const part: PortraitPart = {
        name: 'check',
        kind: 'cloth',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        uvs2: new Float32Array([0, 0, 1, 0, 0, 1]),
        tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        textures: {}
    };

    for (const prog of programs)
    {
        const mesh = new THREE.Mesh(gameGeometry(part, prog), gameMaterial(prog, part, scene));
        mesh.frustumCulled = false;
        const s = new THREE.Scene();
        s.add(mesh);
        renderer.render(s, camera);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
    }

    scene.dispose();
    renderer.dispose();
    const result = { checked: programs.length, webglErrors, compileFailures: failures.length };
    void api.logShader({
        kind: 'CHECK',
        title: `WebGL check: ${programs.length} programs, ${webglErrors} WebGL errors; ${failures.length} failed to compile (see SUMMARY / COMPILE)`
    });
    return result;
}
(window as unknown as { __shaderCheck: typeof checkAllShaders; }).__shaderCheck = checkAllShaders;
