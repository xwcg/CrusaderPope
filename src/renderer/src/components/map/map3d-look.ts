/**
 * The game's map light for the 3D map (docs/map.md, "3D map"; MapTerrainInfo.look): the terrain's and the objects'
 * sun from azimuth and elevation, the environment cubemap with its own prefiltered mips (every mip of every face
 * through ck3://img), TonyMcMapface's table (ck3://map/<key>-tonemap.bin) and the post-processing values.
 */
import * as THREE from 'three';
import type { MapTerrainInfo } from '../../../../shared/api';
import { imgUrl } from '../../img';
import { track } from '../../pending';

type Look = MapTerrainInfo['look'];

/**
 * Towards a sun in map space: azimuth 0 north, 0.25 west, 0.5 south; elevation 0 horizon … 0.5 45° … 1 zenith
 * (jomini/map_lighting.fxh). The map's north is −z.
 */
export function sunDirection(azimuth: number, elevation: number): THREE.Vector3
{
    const a = azimuth * Math.PI * 2;
    const e = (elevation * Math.PI) / 2;
    return new THREE.Vector3(-Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/** A game file's bytes from the map cache folder (ck3://map/). */
export function mapFile(name: string): Promise<ArrayBuffer>
{
    return track(
        fetch(`ck3://map/${name}`).then((res) =>
        {
            if (!res.ok)
                throw new Error(`The map file ${name} could not be loaded (${res.status})`);

            return res.arrayBuffer();
        })
    );
}

/** The uniforms of the light and post-processing (the cubemap's intensity stays 0 until it is loaded). */
export function lookUniforms(look: Look): Record<string, THREE.IUniform>
{
    const s = look.sun;
    const fog = look.fog.color.map((c) => Math.pow(c, 2.2));
    return {
        uLight: { value: sunDirection(s.azimuth, s.elevation) },
        uSunColor: { value: new THREE.Vector3(...s.color).multiplyScalar(s.intensity) },
        uIbl: { value: 0 },
        uEnv: { value: null },
        uLut: { value: null },
        uHasLut: { value: 0 },
        uExposure: { value: look.exposure },
        uContrast: { value: look.contrast },
        uPivot: { value: look.pivot },
        uHaze: { value: new THREE.Vector4(fog[0], fog[1], fog[2], look.fog.max) },
        uHazeRange: { value: new THREE.Vector2(look.fog.begin, look.fog.end) },
        uShadowTint: { value: null },
        uTintSet: { value: new THREE.Vector3(look.shadowTint.strength, look.shadowTint.min, look.shadowTint.max) },
        uTintTiling: { value: new THREE.Vector2(...look.shadowTint.tiling) }
    };
}

/** The objects' own sun (MAP_OBJECTS_SUNNY_*; trees keep the terrain's). */
export function objectSun(look: Look): { dir: THREE.Vector3; color: THREE.Vector3; ibl: number; }
{
    const s = look.objectSun;
    return { dir: sunDirection(s.azimuth, s.elevation), color: new THREE.Vector3(...s.color).multiplyScalar(s.intensity), ibl: look.cubemapIntensity * s.ibl };
}

/** A picture from ck3://img (a cubemap face at a size: the DDS's mip nearest to it). */
function image(path: string, w: number, face?: number): Promise<HTMLImageElement>
{
    return track(
        new Promise((resolve, reject) =>
        {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = imgUrl(path, w) + (face === undefined ? '' : `&face=${face}`);
        })
    );
}

/** A tiling texture of the game (raw values, mipmapped), e.g. the map modes' painted pattern. */
export async function loadTiling(path: string, w: number): Promise<THREE.Texture>
{
    const t = new THREE.Texture(await image(path, w));
    t.flipY = false;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
}

/**
 * The environment cubemap with its own mip chain (the engine picks mips by roughness: sampling the prefiltered levels
 * matters), in sRGB (the game's sampler has `srgb = yes`). Faces as stored; the shaders sample game-space directions.
 */
export async function loadCube(path: string, size = 512): Promise<THREE.CubeTexture>
{
    const levels = Math.floor(Math.log2(size)) + 1;
    const mips = await Promise.all(Array.from({ length: levels }, (_, m) => Promise.all([0, 1, 2, 3, 4, 5].map((f) => image(path, Math.max(1, size >> m), f)))));
    const cube = new THREE.CubeTexture(mips[0]);
    cube.mipmaps = mips.slice(1).map((images) => ({ image: images })) as unknown as THREE.CubeTexture['mipmaps'];
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.generateMipmaps = false;
    cube.minFilter = THREE.LinearMipmapLinearFilter;
    cube.magFilter = THREE.LinearFilter;
    cube.needsUpdate = true;
    return cube;
}

/** TonyMcMapface's table: RGBA half floats, 48 slices of 48 × 48 side by side. */
export async function loadLut(lut: NonNullable<Look['lut']>): Promise<THREE.DataTexture>
{
    const data = new Uint16Array(await mapFile(`${lut.key}-tonemap.bin`));
    const t = new THREE.DataTexture(data, lut.width, lut.height, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
}
