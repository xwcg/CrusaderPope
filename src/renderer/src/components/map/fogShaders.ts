/**
 * The fog of war's shader code (docs/map.md, "Fog of war"), shared by the 2D map (gl2d.ts, raw WebGL2) and the 3D map
 * (map3d.ts, three.js). The game builds a mask from a table with one alpha per province (jomini_fog_of_war.shader
 * CreateFogOfWarAlphaMap: a disc of samples of the province raster around each pixel, averaged) and applies it in its
 * terrain, water and object shaders (jomini_fog_of_war.fxh): a contrast adjustment plus a blue shift, then a blend to
 * black by 1 − alpha, a dark ring where the mask changes fast.
 */

/** Points of the blur's disc: a sunflower spiral over the unit disc (the engine's own samples are not in the files). */
function disc(n: number): string
{
    const pts: string[] = [];

    for (let i = 0; i < n; i++)
    {
        const r = Math.sqrt((i + 0.5) / n);
        const a = i * 2.39996323;
        pts.push(`vec2(${(r * Math.cos(a)).toFixed(5)}, ${(r * Math.sin(a)).toFixed(5)})`);
    }

    return `const vec2 FOG_DISC[${n}] = vec2[${n}](${pts.join(', ')});`;
}

/** The disc's sample count (the define's SAMPLE_COUNT is not followed: the shader is compiled once). */
export const FOG_SAMPLES = 16;

/**
 * The mask's pixel: the average of the table's alpha over the provinces under a rotated disc of `uFogKernel` map pixels
 * around `at` (map pixels). Needs `uIds` (the province raster, usampler2D) and `uSize` (the map's size) declared.
 */
export const FOG_MASK = `
${disc(FOG_SAMPLES)}
// the alpha of each province (a texel per id, 4096 wide)
uniform sampler2D uFogTab;
// the blur's radius in map pixels
uniform vec2 uFogKernel;
float fogHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float fogMaskAt(vec2 at, vec2 texel) {
  float ang = fogHash(texel) * 6.2831853;
  vec2 rot = vec2(cos(ang), sin(ang));
  float sum = 0.0;
  for (int i = 0; i < ${FOG_SAMPLES}; i++) {
    vec2 d = FOG_DISC[i];
    vec2 o = vec2(d.x * rot.x - d.y * rot.y, d.x * rot.y + d.y * rot.x) * uFogKernel;
    uint id = texelFetch(uIds, clamp(ivec2(floor(at + o)), ivec2(0), ivec2(uSize) - 1), 0).r;
    sum += texelFetch(uFogTab, ivec2(int(id & 4095u), int(id >> 12)), 0).r;
  }
  return sum / float(${FOG_SAMPLES});
}
`;

/** The fullscreen pass's vertex shader of the mask (positions −1 … 1). */
export const FOG_MASK_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/**
 * FogOfWarBlend: `k` = 1 − the game's alpha (0 clear … 1 black), `ring` the transition ring (0 … 1). The colour first
 * contrast-adjusted (−1 … 1) with a blue shift and the brightness, then blended to black, the ring a dark blue-black.
 */
export const FOG_BLEND = `
vec3 fowBlend(vec3 col, float k, float ring, float contrast, float brightness) {
  float avg = dot(col, vec3(1.0 / 3.0));
  vec3 adj = (col - avg) * (contrast + 1.0) + avg + brightness + vec3(0.0, 0.002, 0.01) * k;
  vec3 c = mix(clamp(mix(col, adj, k), 0.0, 1.0), vec3(0.0), k);
  return mix(c, vec3(0.0108, 0.012, 0.017), min(1.0, ring * k * 1.3));
}
`;

/**
 * The 3D map's application (jomini_fog_of_war.fxh JominiApplyFogOfWar): `uFow` the mask (R alpha, G noise), `uFowSet`
 * = on, ALPHA_MIN, the zoom step it fades from, PATTERN_STRENGTH; `uFowAdj` = CONTRAST, BRIGHTNESS, PATTERN_TILING,
 * the fade's length in zoom steps. Needs `uSize` and `uZoom` declared.
 */
export const FOG_APPLY = `${FOG_BLEND}
uniform sampler2D uFow;
uniform vec4 uFowSet;
uniform vec4 uFowAdj;
vec3 fowApply(vec3 col, vec3 world) {
  if (uFowSet.x < 0.5) return col;
  float fade = 1.0 - smoothstep(uFowSet.z, uFowSet.z + uFowAdj.w, uZoom);
  if (fade <= 0.0) return col;
  vec2 q = world.xz / uSize;
  vec2 uv = clamp(q, 0.0, 1.0);
  float a = texture(uFow, uv).r;
  // the transition ring: where the mask changes within 4 map pixels
  vec2 px = 4.0 / uSize;
  float gx = abs(texture(uFow, uv + vec2(px.x, 0.0)).r - texture(uFow, uv - vec2(px.x, 0.0)).r);
  float gy = abs(texture(uFow, uv + vec2(0.0, px.y)).r - texture(uFow, uv - vec2(0.0, px.y)).r);
  float ring = smoothstep(0.1, 0.4, sqrt(gx * gx + gy * gy));
  // the pattern: the mask's noise at two scales lets the clear alpha into what is hidden
  if (uFowSet.w > 0.0) {
    vec2 puv = q * uFowAdj.z;
    float n1 = 1.0 - texture(uFow, puv).g;
    float n2 = 1.0 - texture(uFow, puv * -0.13).g;
    float noise = clamp(n2 * 0.5 + 0.25 + (n1 - 0.5) * 0.5, 0.0, 1.0) * (1.0 - a);
    a = smoothstep(0.0, 1.0, a + noise * uFowSet.w);
  }
  a = uFowSet.y + a * (1.0 - uFowSet.y);
  float k = (1.0 - a) * fade;
  return fowBlend(col, k, ring * fade, uFowAdj.x, uFowAdj.y);
}
`;
