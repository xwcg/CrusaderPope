/**
 * Lines over the 3D terrain (docs/map.md, "Rivers and sea crossings"), added to the scene with Map3D.addOverlay: the
 * rivers as ribbons on the ground (the finest level of overlay-data.ts; the height of the terrain, or of the water where
 * it is higher), as wide as their class — far away at least 1.5 pixels, thin ones fading out there as in 2D —,
 * water-coloured with the sky and the sun's glint on them; the sea crossings as ribbons of rounded dashes over the
 * water. The ribbons are pushed a little towards the eye (far terrain patches are coarser than the heights).
 */
import * as THREE from 'three';
import type { MapInfo } from '../../../../shared/api';
import type { Map3D, Terrain } from './map3d';
import { overlaysOf, riverWidth, type Overlays } from './overlay-data';

/** The ribbons' vertex shader: a centre line point moved sideways by the half width (at least `uMin` pixels). */
const VERT = `
uniform float uPx;
uniform float uMin;
// the perpendicular (x, z) and the side (−1, 1)
in vec3 aSide;
// half the width (map pixels), the length along the line (map pixels)
in float aHalf;
in float aAlong;
out float vSide;
out float vAlong;
out float vHalf;
out float vPx;
out float vFade;
out vec3 vWorld;
void main() {
  float dist = distance(position, cameraPosition);
  // world units per pixel there
  float px = dist * uPx;
  float hw = max(aHalf, uMin * px);
  vec3 p = position + vec3(aSide.x, 0.0, aSide.y) * aSide.z * hw;
  p += normalize(cameraPosition - p) * (0.2 + dist * 0.004);
  vSide = aSide.z;
  vAlong = aAlong;
  vHalf = hw;
  vPx = hw / px;
  vFade = clamp((2.0 * aHalf / px - 0.2) / 0.5, 0.0, 1.0);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

/** What both fragment shaders share: the terrain's style, sun and fog (its uniforms), the edge's antialiasing. */
const FRAG_COMMON = `
precision highp float;
// 0 terrain colour map, 1 paper map, 2 plain
uniform int uStyle;
uniform vec3 uLight;
uniform vec3 uFog;
uniform vec2 uFogRange;
in float vSide;
in float vAlong;
in float vHalf;
in float vPx;
in float vFade;
in vec3 vWorld;
out vec4 fragColor;

vec3 fogged(vec3 col) {
  return mix(col, uFog, smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, cameraPosition)));
}
`;

const RIVER_FRAG = `${FRAG_COMMON}
void main() {
  float e = abs(vSide);
  float a = clamp((1.0 - e) * vPx + 0.5, 0.0, 1.0) * vFade;
  if (a <= 0.0) discard;
  vec3 water = uStyle == 2 ? vec3(0.17, 0.27, 0.36) : uStyle == 1 ? vec3(0.27, 0.32, 0.33) : vec3(0.2, 0.36, 0.46);
  vec3 col = water * mix(1.15, 0.78, e * e);
  // the sky's light looking across, the sun's glint
  vec3 v = normalize(cameraPosition - vWorld);
  col = mix(col, vec3(0.42, 0.52, 0.6), pow(1.0 - max(v.y, 0.0), 4.0) * 0.35);
  col += vec3(1.0, 0.95, 0.85) * pow(max(dot(reflect(-uLight, vec3(0.0, 1.0, 0.0)), v), 0.0), 60.0) * 0.3;
  fragColor = vec4(fogged(col), a * 0.95);
}
`;

/**
 * Rounded dashes along the ribbon (in the ribbon's half widths: a dash 0.72 half wide, 2.3 long with its round ends,
 * gaps of 1.73 — the 2D proportions), on a dark rim to the ribbon's edge.
 */
const CROSSING_FRAG = `${FRAG_COMMON}
void main() {
  float t = mod(vAlong / vHalf, 4.03) - 1.15;
  float d = length(vec2(max(abs(t) - 0.43, 0.0), vSide)) - 0.72;
  float a = clamp(-d * vPx + 0.5, 0.0, 1.0);
  float rim = clamp((0.28 - d) * vPx, 0.0, 1.0);
  if (rim <= 0.0) discard;
  vec3 col = mix(vec3(0.11, 0.09, 0.05), vec3(0.61, 0.54, 0.29), a);
  fragColor = vec4(fogged(col), max(a, rim * 0.6));
}
`;

/** A ribbon along lines: per point the centre (x, height, z), its perpendicular, half width and length along. */
class Ribbon
{
    /** points added, indices written */
    private n = 0;
    private k = 0;
    private pos: Float32Array;
    private side: Float32Array;
    private half: Float32Array;
    private along: Float32Array;
    private index: Uint32Array;

    /** Room for `points` points (two vertices each). */
    constructor(points: number)
    {
        this.pos = new Float32Array(points * 6);
        this.side = new Float32Array(points * 6);
        this.half = new Float32Array(points * 2);
        this.along = new Float32Array(points * 2);
        this.index = new Uint32Array(points * 6);
    }

    /** Adds a line (x, z per point; `hw` per point) lying on `ground`. */
    add(xz: ArrayLike<number>, from: number, count: number, hw: (i: number) => number, ground: (x: number, z: number) => number): void
    {
        let run = 0;

        for (let i = 0; i < count; i++)
        {
            const j = from + i;
            const a = Math.max(from, j - 1);
            const b = Math.min(from + count - 1, j + 1);
            const tx = xz[b * 2] - xz[a * 2];
            const tz = xz[b * 2 + 1] - xz[a * 2 + 1];
            const l = Math.hypot(tx, tz) || 1;
            const x = xz[j * 2];
            const z = xz[j * 2 + 1];

            if (i)
                run += Math.hypot(x - xz[j * 2 - 2], z - xz[j * 2 - 1]);

            const y = ground(x, z);
            // (vertex v on the left, v + 1 on the right)
            const v = this.n * 2;

            for (let s = 0; s < 2; s++)
            {
                const o = (v + s) * 3;
                this.pos[o] = x;
                this.pos[o + 1] = y;
                this.pos[o + 2] = z;
                this.side[o] = -tz / l;
                this.side[o + 1] = tx / l;
                this.side[o + 2] = s ? 1 : -1;
                this.half[v + s] = hw(j);
                this.along[v + s] = run;
            }

            if (i)
            {
                this.index.set([v - 2, v - 1, v, v - 1, v + 1, v], this.k);
                this.k += 6;
            }

            this.n++;
        }
    }

    mesh(material: THREE.ShaderMaterial): THREE.Mesh
    {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(this.pos.subarray(0, this.n * 6), 3));
        g.setAttribute('aSide', new THREE.BufferAttribute(this.side.subarray(0, this.n * 6), 3));
        g.setAttribute('aHalf', new THREE.BufferAttribute(this.half.subarray(0, this.n * 2), 1));
        g.setAttribute('aAlong', new THREE.BufferAttribute(this.along.subarray(0, this.n * 2), 1));
        g.setIndex(new THREE.BufferAttribute(this.index.subarray(0, this.k), 1));
        const m = new THREE.Mesh(g, material);
        m.frustumCulled = false;
        return m;
    }
}

/** The terrain material's uniforms (style, sun, fog) among the scene's objects: the ribbons share them. */
function terrainUniforms(scene: THREE.Object3D | null): Record<string, THREE.IUniform> | undefined
{
    for (const o of scene?.children ?? [])
    {
        const m = (o as THREE.Mesh).material;

        if (m instanceof THREE.ShaderMaterial && m.uniforms.uStyle && m.uniforms.uFogRange)
            return m.uniforms;
    }

    return undefined;
}

/** The ribbons of the rivers (finest level) and crossings. */
function build(map: Map3D, o: Overlays, shared: Record<string, THREE.IUniform>): THREE.Mesh[]
{
    const ground = (x: number, z: number): number => map.surface(x, z);
    /** (`min`: the least half width in pixels) */
    const material = (frag: string, min: number): THREE.ShaderMaterial =>
        new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: { ...shared, uMin: { value: min } },
            vertexShader: VERT,
            fragmentShader: frag,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });
    const out: THREE.Mesh[] = [];
    const L = o.levels[0];
    const r = o.info.rivers;

    if (L && r)
    {
        const rb = new Ribbon(L.classes.length);
        const hw = (i: number): number => riverWidth(r, L.classes[i]) / 2;

        for (let k = 0; k < L.rivers.length; k += 2)
            rb.add(L.points, L.rivers[k], L.rivers[k + 1], hw, ground);

        const mesh = rb.mesh(material(RIVER_FRAG, 0.75));
        mesh.renderOrder = 3;
        out.push(mesh);
    }

    if (o.info.crossings.length)
    {
        const n = 24;
        const rb = new Ribbon(o.info.crossings.length * (n + 1));

        for (const c of o.info.crossings)
        {
            const [x0, z0, x1, z1] = c.line;
            // (the arc as 2D draws it: a bulge of an eighth of the length)
            const cx = (x0 + x1) / 2 + (z1 - z0) / 4;
            const cz = (z0 + z1) / 2 - (x1 - x0) / 4;
            const xz = new Float32Array((n + 1) * 2);

            for (let i = 0; i <= n; i++)
            {
                const t = i / n;
                xz[i * 2] = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
                xz[i * 2 + 1] = (1 - t) * (1 - t) * z0 + 2 * (1 - t) * t * cz + t * t * z1;
            }

            // (the dashes: 0.72 of it, 2.3 map pixels wide)
            rb.add(xz, 0, n + 1, () => 1.6, ground);
        }

        const mesh = rb.mesh(material(CROSSING_FRAG, 1.6));
        mesh.renderOrder = 4;
        out.push(mesh);
    }

    return out;
}

/** Adds the overlays to a new 3D map (called once per scene; they come when their data is loaded). */
export function attachOverlays(map: Map3D, info: MapInfo, _terrain: Terrain): void
{
    const group = new THREE.Group();
    // world units per pixel at a distance of 1
    const uPx = { value: 0.001 };
    const size = new THREE.Vector2();
    let alive = true;
    map.addOverlay({
        object: group,
        dispose: () =>
        {
            alive = false;

            for (const m of group.children as THREE.Mesh[])
            {
                m.geometry.dispose();
                (m.material as THREE.Material).dispose();
            }
        }
    });
    void overlaysOf(info).then((o) =>
    {
        const t = terrainUniforms(group.parent);

        if (!alive || !o || !t)
            return;

        const shared = { uPx, uStyle: t.uStyle, uLight: t.uLight, uFog: t.uFog, uFogRange: t.uFogRange };

        for (const m of build(map, o, shared))
        {
            m.onBeforeRender = (renderer, _scene, camera) =>
            {
                renderer.getDrawingBufferSize(size);
                uPx.value = (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) / Math.max(1, size.y);
            };
            group.add(m);
        }

        map.invalidate();
    });
}
