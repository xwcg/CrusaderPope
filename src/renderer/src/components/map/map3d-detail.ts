/**
 * The terrain's materials on the GPU (docs/map.md, "3D map"; map/terrain-detail.ts): the detail maps as one RGBA16UI
 * texture (per pixel 4 × layer | intensity << 8, bottom row first) and the materials' diffuse (sRGB), normal and
 * properties as BC3 array textures with their mips — straight from ck3://map/<key>-detail.bin and -materials.bin.
 */
import * as THREE from 'three';
import type { MapTerrainInfo } from '../../../../shared/api';
import { mapFile } from './map3d-look';

type Detail = NonNullable<MapTerrainInfo['detail']>;

export interface DetailTextures
{
    detail: THREE.DataTexture;
    /** diffuse, normal, properties */
    arrays: THREE.CompressedArrayTexture[];
}

/** Whether the GPU takes the materials: BC3 textures, also in sRGB. */
export function detailSupported(renderer: THREE.WebGLRenderer): boolean
{
    return renderer.extensions.has('WEBGL_compressed_texture_s3tc') && renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb');
}

/** The detail maps and material arrays as textures (uploaded on first use). */
export async function loadDetail(d: Detail, anisotropy: number): Promise<DetailTextures>
{
    const [detail, materials] = await Promise.all([mapFile(`${d.key}-detail.bin`), mapFile(`${d.key}-materials.bin`)]);
    const tex = new THREE.DataTexture(new Uint16Array(detail), d.width, d.height, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
    tex.internalFormat = 'RGBA16UI';
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    // (the copies are on the GPU now: 340 MB vanilla, 450 MB AGOT)
    tex.onUpdate = () =>
    {
        tex.image = { data: new Uint16Array(4), width: 1, height: 1 };
    };
    const layers = d.layers.length;
    let at = 0;
    const arrays = [0, 1, 2].map((k) =>
    {
        const mipmaps: { data: Uint8Array; width: number; height: number; }[] = [];

        for (let l = 0; l < d.levels; l++)
        {
            const s = Math.max(1, d.size >> l);
            const bytes = Math.max(1, Math.ceil(s / 4)) ** 2 * 16 * layers;
            mipmaps.push({ data: new Uint8Array(materials, at, bytes), width: s, height: s });
            at += bytes;
        }

        const t = new THREE.CompressedArrayTexture(mipmaps as unknown as THREE.CompressedTextureMipmap[], d.size, d.size, layers, THREE.RGBA_S3TC_DXT5_Format);
        t.colorSpace = k === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = anisotropy;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        t.onUpdate = () =>
        {
            t.mipmaps = [];
        };
        return t;
    });
    return { detail: tex, arrays };
}

/** Per layer its tiling per map pixel, 4 to a vec4 (unused slots: the default), for the shader's uTiles. */
export function tileVectors(d: Detail, mapWidth: number, fallback: number): THREE.Vector4[]
{
    const t = Array.from({ length: 256 }, (_, i) => (d.layers[i]?.tile ?? fallback) / mapWidth);
    return Array.from({ length: 64 }, (_, i) => new THREE.Vector4(t[i * 4], t[i * 4 + 1], t[i * 4 + 2], t[i * 4 + 3]));
}
