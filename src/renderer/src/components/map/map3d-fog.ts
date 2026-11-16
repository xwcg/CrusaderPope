/**
 * The 3D map's fog of war mask (docs/map.md, "Fog of war"): the game's CreateFogOfWarAlphaMap pass on the GPU, a
 * fullscreen pass over a render target of NFogOfWar TEXTURE_WIDTH × TEXTURE_HEIGHT (R: the blurred province alphas,
 * G: the noise texture) from the province raster and the table of alphas. Made again only when the table changes.
 */
import * as THREE from 'three';
import type { MapFogInfo } from '../../../../shared/api';
import { FOG_MASK } from './fogShaders';

const VERT = `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uIds;
uniform vec2 uSize;
uniform vec2 uMask;
uniform sampler2D uNoise;
uniform float uHasNoise;
${FOG_MASK}
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uMask;
  float a = fogMaskAt(uv * uSize, floor(gl_FragCoord.xy));
  float n = uHasNoise > 0.5 ? texture(uNoise, uv).r : 0.5;
  o = vec4(a, n, 0.0, 1.0);
}`;

export class FogMask
{
    private target: THREE.WebGLRenderTarget | null = null;
    private scene = new THREE.Scene();
    private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private material: THREE.RawShaderMaterial;
    private geometry = new THREE.BufferGeometry();
    private table: THREE.DataTexture | null = null;
    private uniforms: Record<string, THREE.IUniform>;

    /** @param ids the province raster's texture, `size` the map's size */
    constructor(private renderer: THREE.WebGLRenderer, ids: THREE.Texture, size: [number, number])
    {
        const dummy = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
        dummy.needsUpdate = true;
        this.uniforms = {
            uIds: { value: ids },
            uSize: { value: new THREE.Vector2(...size) },
            uMask: { value: new THREE.Vector2(1, 1) },
            uNoise: { value: dummy },
            uHasNoise: { value: 0 },
            uFogTab: { value: dummy },
            uFogKernel: { value: new THREE.Vector2(1, 1) }
        };
        this.material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false });
        this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        const quad = new THREE.Mesh(this.geometry, this.material);
        quad.frustumCulled = false;
        this.scene.add(quad);
    }

    /**
     * The mask for a table of alphas (a texel per province id, 4096 wide): a texture the materials sample (R alpha, G
     * noise; wrapping, linear). `noise`: the game's noise texture (null: a flat 0.5).
     */
    build(table: Uint8Array, def: MapFogInfo, noise: THREE.Texture | null): THREE.Texture
    {
        const max = this.renderer.capabilities.maxTextureSize;
        const w = Math.min(def.textureWidth, max);
        const h = Math.min(def.textureHeight, max);
        const size = this.uniforms.uSize.value as THREE.Vector2;

        if (!this.target || this.target.width !== w || this.target.height !== h)
        {
            this.target?.dispose();
            this.target = new THREE.WebGLRenderTarget(w, h, { format: THREE.RGFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, generateMipmaps: false });
        }

        this.table?.dispose();
        this.table = new THREE.DataTexture(table, 4096, table.length / 4096, THREE.RedFormat, THREE.UnsignedByteType);
        this.table.minFilter = this.table.magFilter = THREE.NearestFilter;
        this.table.needsUpdate = true;
        this.uniforms.uFogTab.value = this.table;
        this.uniforms.uMask.value = new THREE.Vector2(w, h);
        // (the blur's radius is in mask pixels: map pixels = × the map's size over the mask's)
        this.uniforms.uFogKernel.value = new THREE.Vector2((def.kernelScale * size.x) / w, (def.kernelScale * size.y) / h);

        if (noise)
        {
            this.uniforms.uNoise.value = noise;
            this.uniforms.uHasNoise.value = 1;
        }
        else
            this.uniforms.uHasNoise.value = 0;

        const r = this.renderer;
        const was = r.getRenderTarget();
        r.setRenderTarget(this.target);
        r.render(this.scene, this.camera);
        r.setRenderTarget(was);
        return this.target.texture;
    }

    dispose(): void
    {
        this.target?.dispose();
        this.table?.dispose();
        this.material.dispose();
        this.geometry.dispose();
    }
}
