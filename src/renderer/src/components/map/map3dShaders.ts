/**
 * The 3D map's shaders (docs/map.md, "3D map"): the terrain patches displaced by the height raster, the water plane,
 * and what both draw on the map — the mode's colours from the province raster and palettes (as the 2D map, gl2d.ts),
 * borders, rivers, hover and selection. The terrain style shades like the game's terrain shader (gfx/FX
 * pdxterrain.shader, cw/pdxterrain.fxh, jomini/map_lighting.fxh): the materials of the detail maps blended by
 * intensity and height, the colour map laid over them (soft light), their normal maps on the relief's normals, the
 * sun and the environment cubemap (the game's PBR), the distance haze, then the game's post-processing (exposure,
 * contrast, TonyMcMapface). World units: x = map pixel column, z = map pixel row, y = height; the game's own z runs
 * north from the map's bottom edge (`game(p)`).
 */

/** Uniforms, samplers and functions of both materials. */
const COMMON = `
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DArray;
precision highp samplerCube;
uniform usampler2D uIds;
uniform sampler2D uColor;
uniform usampler2D uGroup;
uniform sampler2D uBack;
uniform sampler2D uHeight;
uniform usampler2D uRivers;
uniform sampler2D uWater;
uniform sampler2D uField;
uniform samplerCube uEnv;
uniform sampler2D uLut;
uniform sampler2D uPattern;
// the game's shadow tint (shadow_tint.fxh): its colour texture; strength, n·l thresholds; repeats over the map
uniform sampler2D uShadowTint;
uniform vec3 uTintSet;
uniform vec2 uTintTiling;
// 0 terrain (the game's look), 1 paper map, 2 plain
uniform int uStyle;
// the province raster's size (= the map in world units), the height raster's, the rivers raster's (0: none)
uniform vec2 uSize;
uniform vec2 uHSize;
uniform vec2 uRSize;
uniform float uHeightScale;
uniform float uWaterLevel;
// the hovered and the selected group + 1 (0: none)
uniform uint uHover;
uniform uint uSel;
// towards the sun, its colour × intensity; the environment cubemap's intensity (0: not loaded)
uniform vec3 uLight;
uniform vec3 uSunColor;
uniform float uIbl;
// post-processing: exposure, contrast around pivot, TonyMcMapface's table (else a filmic curve)
uniform float uExposure;
uniform float uContrast;
uniform float uPivot;
uniform float uHasLut;
// the game's distance haze: linear colour and strength, start and end; the fade to the background far away
uniform vec4 uHaze;
uniform vec2 uHazeRange;
uniform vec3 uFog;
uniform vec2 uFogRange;
// the camera's zoom step (fractional; 0 nearest)
uniform float uZoom;
// the rivers raster drawn as lines (0 when other lines draw the rivers)
uniform float uRiversOn;

ivec2 palAt(uint id) { return ivec2(int(id & 4095u), int(id >> 12)); }
uint idAt(ivec2 q) { return texelFetch(uIds, clamp(q, ivec2(0), ivec2(uSize) - 1), 0).r; }
uint groupOf(uint id) { return texelFetch(uGroup, palAt(id), 0).r; }
/** the palette's alpha: bit 0 water, bit 1 coloured by the mode, bit 2 inland water (lakes, rivers) */
int kindOf(vec4 c) { return int(c.a * 255.0 + 0.5); }
/** the height (world units) with a mip level for a footprint of \`d\` map pixels */
float heightAt(vec2 p, float lod) { return textureLod(uHeight, p / uSize, lod).r * uHeightScale; }
/** the game's coordinates of a map point: z north from the bottom edge */
vec2 game(vec2 p) { return vec2(p.x, uSize.y - p.y); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

/**
 * The game's shadow tint at a map point (shadow_tint.fxh GetShadowTintData): shadow_color.dds repeated over the map —
 * its colour (linear) and the strength × its alpha. No shadow map or cloud shadows here: ShadowTerm 1, CloudMask 0.
 */
vec4 shadowTint(vec2 p) {
  vec4 t = texture(uShadowTint, vec2(p.x / uSize.x, 1.0 - p.y / uSize.y) * uTintTiling);
  return vec4(toLinear(t.rgb), uTintSet.x * t.a);
}
/** How lit a surface counts for the tint (GetShadowTintMask: n·l smoothed over the thresholds), 0 … 1. */
float tintLit(vec3 n, vec3 l) { return smoothstep(uTintSet.y, uTintSet.z, clamp(dot(n, l), 0.0, 1.0) + 1e-5); }

/**
 * Near (a map pixel over more than a screen pixel), as the 2D map (gl2d.ts smoothAt): each group's and province's
 * indicator smoothed by a quadratic B-spline over the 3 × 3 pixels around p; p is in the highest, the border where it
 * ties with the next — its distance (map pixels) is the difference over the difference's gradient. Stair steps
 * become curves; the id and group are the smoothed ones.
 */
void smoothAt(vec2 p, out uint id, out uint g, out uint gNext, out float dG, out float dP) {
  vec2 q = p - 0.5;
  vec2 c = floor(q + 0.5);
  vec2 t = q - c;
  vec3 wx = vec3(0.5 * (0.5 - t.x) * (0.5 - t.x), 0.75 - t.x * t.x, 0.5 * (0.5 + t.x) * (0.5 + t.x));
  vec3 wy = vec3(0.5 * (0.5 - t.y) * (0.5 - t.y), 0.75 - t.y * t.y, 0.5 * (0.5 + t.y) * (0.5 + t.y));
  vec3 dx = vec3(t.x - 0.5, -2.0 * t.x, 0.5 + t.x);
  vec3 dy = vec3(t.y - 0.5, -2.0 * t.y, 0.5 + t.y);
  uint rg[9]; float rw[9]; vec2 rd[9];
  uint pv[9]; uint pg[9]; float pw[9]; vec2 pd[9];
  int nr = 0;
  int np = 0;
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      uint pid = idAt(ivec2(c) + ivec2(i - 1, j - 1));
      uint gg = groupOf(pid);
      float w = wx[i] * wy[j];
      vec2 d = vec2(dx[i] * wy[j], wx[i] * dy[j]);
      int k = 0;
      while (k < nr && rg[k] != gg) k++;
      if (k == nr) { rg[k] = gg; rw[k] = 0.0; rd[k] = vec2(0.0); nr++; }
      rw[k] += w;
      rd[k] += d;
      k = 0;
      while (k < np && pv[k] != pid) k++;
      if (k == np) { pv[k] = pid; pg[k] = gg; pw[k] = 0.0; pd[k] = vec2(0.0); np++; }
      pw[k] += w;
      pd[k] += d;
    }
  }
  int a = 0;
  for (int k = 1; k < nr; k++) if (rw[k] > rw[a]) a = k;
  int b = -1;
  for (int k = 0; k < nr; k++) if (k != a && (b < 0 || rw[k] > rw[b])) b = k;
  g = rg[a];
  gNext = b < 0 ? g : rg[b];
  dG = b < 0 ? 1e3 : (rw[a] - rw[b]) / max(length(rd[a] - rd[b]), 1e-3);
  int pa = 0;
  for (int k = 0; k < np; k++) if (pg[k] == g && (pg[pa] != g || pw[k] > pw[pa])) pa = k;
  int pb = -1;
  for (int k = 0; k < np; k++) if (k != pa && (pb < 0 || pw[k] > pw[pb])) pb = k;
  id = pv[pa];
  dP = pb < 0 ? 1e3 : (pw[pa] - pw[pb]) / max(length(pd[pa] - pd[pb]), 1e-3);
}

/**
 * The province and group at p and the borders there: x = between groups, y = between provinces, z = the selected
 * group's (coverage 0 … 1). Near smooth lines, groups ~2 to 3 screen pixels wide as the map comes closer; farther
 * the ids one footprint away, as the 2D map.
 */
vec3 borders(vec2 p, float d, out uint id, out uint g) {
  uint gNext = 0u;
  float dG = 0.0;
  float dP = 0.0;
  vec3 r = vec3(0.0);
  if (d < 1.0) {
    smoothAt(p, id, g, gNext, dG, dP);
    float hw = mix(0.8, 1.5, clamp(-log2(d) / 4.0, 0.0, 1.0));
    float aG = clamp(hw + 0.5 - dG / d, 0.0, 1.0);
    r = vec3(aG, clamp(1.0 - dP / d, 0.0, 1.0), uSel != 0u && (g == uSel || gNext == uSel) ? aG : 0.0);
  } else {
    ivec2 q = ivec2(floor(p));
    id = idAt(q);
    g = groupOf(id);
    int s = int(d + 0.5);
    uint i1 = idAt(q + ivec2(s, 0));
    uint i2 = idAt(q + ivec2(0, s));
    uint i3 = idAt(q - ivec2(s, 0));
    uint i4 = idAt(q - ivec2(0, s));
    uint g1 = groupOf(i1);
    uint g2 = groupOf(i2);
    uint g3 = groupOf(i3);
    uint g4 = groupOf(i4);
    bool ge = g1 != g || g2 != g || g3 != g || g4 != g;
    bool pe = i1 != id || i2 != id || i3 != id || i4 != id;
    bool se = ge && uSel != 0u && (g == uSel || g1 == uSel || g2 == uSel || g3 == uSel || g4 == uSel);
    r = vec3(ge ? 1.0 : 0.0, pe ? 1.0 : 0.0, se ? 1.0 : 0.0);
  }
  return r;
}

/** A segment's distance from p. */
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/**
 * River coverage at p (0 … 1): lines between the centres of neighbouring river pixels, as wide as their width class
 * (1 … 13); they fade out as the view gets too far for them.
 */
float riverAt(vec2 p, float d) {
  if (uRSize.x == 0.0 || d > 6.0 || uRiversOn < 0.5) return 0.0;
  vec2 r = p * uRSize / uSize;
  float dr = d * uRSize.x / uSize.x;
  ivec2 q = ivec2(floor(r));
  uint v[9];
  bool any = false;
  for (int k = 0; k < 9; k++) {
    v[k] = texelFetch(uRivers, clamp(q + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), ivec2(uRSize) - 1), 0).r;
    any = any || v[k] != 0u;
  }
  if (!any) return 0.0;
  float aa = 0.5 * max(dr, 0.05);
  float best = 0.0;
  for (int a = 0; a < 9; a++) {
    if (v[a] == 0u) continue;
    vec2 ca = vec2(q) + vec2(float(a % 3 - 1), float(a / 3 - 1)) + 0.5;
    float wa = 0.2 + 0.06 * float(v[a]);
    best = max(best, 1.0 - smoothstep(wa - aa, wa + aa, length(r - ca)));
    for (int b = a + 1; b < 9; b++) {
      if (v[b] == 0u || abs(a % 3 - b % 3) > 1 || abs(a / 3 - b / 3) > 1) continue;
      vec2 cb = vec2(q) + vec2(float(b % 3 - 1), float(b / 3 - 1)) + 0.5;
      float w = 0.2 + 0.06 * float(max(v[a], v[b]));
      best = max(best, 1.0 - smoothstep(w - aa, w + aa, segment(r, ca, cb)));
    }
  }
  return best * (1.0 - smoothstep(2.5, 6.0, d));
}

/** The water's colour in the map styles (the 2D map's tones): plain, or the paper map's painted sea. */
vec3 waterTone(vec3 back) {
  return uStyle == 2 ? vec3(0.13, 0.19, 0.26) : mix(vec3(0.1, 0.17, 0.25), back, 0.55);
}

/** The rivers raster's lines, and in the plain map water above the water level (river provinces, high lakes). */
vec3 riverTone() {
  return uStyle == 2 ? vec3(0.17, 0.25, 0.33) : vec3(0.23, 0.38, 0.45);
}

/** Distance fade towards the background (far views). */
vec3 fogged(vec3 col, vec3 world) {
  return mix(col, uFog, smoothstep(uFogRange.x, uFogRange.y, distance(world, cameraPosition)));
}

// --- the game's lighting (cw/lighting.fxh with PDX_SimpleLighting, jomini/map_lighting.fxh) ---------------------

const float PI = 3.14159265;

/** A cubemap direction in the game's space (its z runs the other way). */
vec3 envDir(vec3 v) { return vec3(v.x, v.y, -v.z); }

/**
 * The game's map lighting of a surface: \`albedo\` (linear), normal, perceptual roughness, specular (0 … 1, remapped
 * × 0.25) and metalness; the sun (\`uLight\`, \`uSunColor\`) with GGX specular, the cubemap's diffuse (mip 7) and
 * specular (by roughness) light × \`ibl\`.
 */
vec3 mapLighting(vec3 albedo, vec3 n, float roughness, float spec, float metal, vec3 v, vec3 sunColor, float ibl) {
  vec3 diffColor = mix(albedo, vec3(0.0), metal);
  vec3 specColor = mix(vec3(0.25 * spec), albedo, metal);
  float r = roughness * roughness;
  vec3 h = normalize(v + uLight);
  float nv = clamp(dot(n, v), 0.0, 1.0) + 1e-5;
  float nl = clamp(dot(n, uLight), 0.0, 1.0) + 1e-5;
  float nh = clamp(dot(n, h), 0.0, 1.0);
  float lh = clamp(dot(uLight, h), 0.0, 1.0);
  vec3 col = diffColor * sunColor * nl / PI;
  vec3 f = specColor + (1.0 - specColor) * pow(1.0 - lh, 5.0);
  float a = mix(0.03, 1.0, r);
  float a2 = a * a;
  float fd = (nh * a2 - nh) * nh + 1.0;
  float k = r * 0.5;
  col += (a2 / (PI * fd * fd)) * f * (0.25 / (lh * lh * (1.0 - k * k) + k * k)) * sunColor * nl;
  if (ibl > 0.0) {
    col += textureLod(uEnv, envDir(n), 7.0).rgb * ibl * diffColor;
    vec3 refl = reflect(-v, n);
    float smooth_ = clamp(1.0 - r, 0.0, 1.0);
    vec3 dom = normalize(mix(n, refl, smooth_ * (sqrt(smooth_) + r)));
    float nr = clamp(dot(n, dom), 0.0, 1.0);
    vec3 sr = specColor + (1.0 - specColor) * pow(1.0 - nr, 5.0);
    float mip = roughness * (1.7 - 0.7 * roughness) * 7.0;
    col += textureLod(uEnv, envDir(dom), mip).rgb * ibl * sr / (r * r + 1.0);
  }
  return col;
}

/**
 * Water in the game's light (linear): its colour map's colour lit by the sun and the cubemap, the sky's reflection by
 * Fresnel (bias 0.1, power 4, jomini_water_default.fxh), the sun's glint; \`n\` the surface's normal.
 */
vec3 waterLit(vec3 wtex, vec3 n, vec3 v) {
  vec3 base = toLinear(wtex) * 0.9;
  float fres = 0.1 + 0.9 * pow(1.0 - abs(dot(v, n)), 4.0);
  vec3 sky = uIbl > 0.0 ? textureLod(uEnv, envDir(reflect(-v, n)), 2.0).rgb * uIbl * 0.35 : vec3(0.35, 0.45, 0.55);
  vec3 lin = base * (uSunColor * max(dot(n, uLight), 0.0) / PI + (uIbl > 0.0 ? textureLod(uEnv, vec3(0.0, 1.0, 0.0), 7.0).rgb * uIbl : vec3(0.6)));
  lin = mix(lin, sky, fres * 0.6);
  return lin + uSunColor * pow(max(dot(reflect(-uLight, n), v), 0.0), 600.0) * 0.04;
}

/**
 * The game's distance haze (jomini_fog.fxh): stronger looking across than down, up to \`uHaze.a\`, fading as the
 * camera rises (CalculateZoomFogFactor) and over hills (the height fade).
 */
vec3 hazed(vec3 col, vec3 world) {
  vec3 diff = cameraPosition - world;
  float dist2 = dot(diff, diff);
  float f = clamp(min((dist2 - uHazeRange.x * uHazeRange.x) / (uHazeRange.y * uHazeRange.y - uHazeRange.x * uHazeRange.x), uHaze.a) * (1.0 - abs(normalize(diff).y)), 0.0, 1.0);
  f *= clamp(pow(1.15 - clamp(uZoom / 12.0, 0.0, 1.0), 6.0), 0.0, 1.0);
  return mix(col, uHaze.rgb, f);
}

/** Exposure, contrast and tone mapping (jomini/posteffect_base.fxh: TonyMcMapface through its table), then gamma. */
vec3 post(vec3 c) {
  c = max((c * uExposure - uPivot) * uContrast + uPivot, 0.0);
  if (uHasLut > 0.5) {
    c = c / (c + 1.0);
    const float size = 48.0;
    float scale = (size - 1.0) / size;
    float offset = 0.5 / size;
    float x = (scale * c.r + offset) / size;
    float y = scale * c.g + offset;
    float z = floor((scale * c.b + offset) * size);
    vec3 c1 = textureLod(uLut, vec2(x + z / size, y), 0.0).rgb;
    vec3 c2 = textureLod(uLut, vec2(x + min(size - 1.0, z + 1.0) / size, y), 0.0).rgb;
    c = mix(c1, c2, scale * c.b * size - z);
  } else c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

/**
 * A mode's colour as the game paints it on the terrain (bordercolor.fxh GetBorderColorAndBlendGameLerp): 10 %
 * desaturated, the map modes' pattern (gfx/map/textures/political_mapmode_pattern.dds, 30 × 15 tiles over the map)
 * overlaid — here around the pattern's mean, so the colour keeps its brightness.
 */
vec3 painted(vec3 c, vec2 p) {
  vec2 uv = p / uSize;
  float pat = clamp(texture(uPattern, vec2(uv.x * 30.0, uv.y * 15.0)).r / 0.45 * 0.5, 0.0, 1.0);
  c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.1);
  return pat < 0.5 ? 2.0 * pat * c : 1.0 - 2.0 * (1.0 - pat) * (1.0 - c);
}

/**
 * How a group's colour lies on the terrain (the game's gradient borders, gfx/map/map_modes: realms "hollow" near —
 * a band along the border, the land inside showing —, "filled" from zoom step 9 on, wholly from 15): x = coverage at
 * \`dist\` map pixels from the group's border, y / z = the blend before and after lighting.
 */
vec3 overlayAt(float dist) {
  float filled = smoothstep(7.0, 10.0, uZoom);
  float far = smoothstep(10.0, 15.0, uZoom);
  float hollow = mix(0.12, 1.0, 1.0 - smoothstep(1.0, 7.0, dist));
  float fill = mix(0.4, 0.8, 1.0 - smoothstep(0.0, 24.0, dist));
  float a = mix(mix(hollow, fill, filled), 1.0, far);
  return vec3(a, mix(0.2, 0.5, filled), mix(mix(0.3, 0.8, filled), 0.95, far));
}
`;

export const TERRAIN_VERT = `
precision highp float;
uniform sampler2D uHeight;
uniform vec2 uSize;
uniform vec2 uHSize;
uniform float uHeightScale;
/** quads along a patch's side */
uniform float uGrid;
// the patch: x0, z0, size, skirt depth (instanced)
in vec4 aPatch;
out vec2 vMap;
out float vHeight;
void main() {
  // position: x, z in 0 … 1 across the patch, y = 1 on the skirt (the border hanging down: no cracks between sizes)
  vec2 p = clamp(aPatch.xy + position.xz * aPatch.z, vec2(0.0), uSize);
  float lod = max(0.0, log2(aPatch.z / uGrid * uHSize.x / uSize.x));
  float h = textureLod(uHeight, p / uSize, lod).r * uHeightScale;
  vMap = p;
  vHeight = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, h - position.y * aPatch.w, p.y, 1.0);
}
`;

/** The terrain's materials (cw/pdxterrain.fxh CalculateDetails). */
const DETAIL = `
precision highp usampler2D;
uniform usampler2D uDetail;
uniform sampler2DArray uDiffuseArr;
uniform sampler2DArray uNormalArr;
uniform sampler2DArray uPropsArr;
uniform float uHasDetail;
// the detail maps' size; where the tiling starts (game coordinates), the default tiling (per map pixel), per layer
// its own (4 layers per vec4); the blend range; the normals' height scale (settings.terrain)
uniform vec2 uDetailSize;
uniform vec2 uTileOffset;
uniform float uTileDefault;
uniform vec4 uTiles[64];
uniform float uBlendRange;
uniform float uNormalScale;

float tileOf(uint layer) { return uTiles[layer >> 2u][int(layer & 3u)]; }

/** CalcHeightBlendFactors: the materials within the blend range of the highest height + intensity. */
vec4 heightBlend(vec4 heights, vec4 factors) {
  vec4 m = heights + factors;
  float start = max(max(m.x, m.y), max(m.z, m.w)) - uBlendRange;
  vec4 b = max(m - vec4(start), vec4(0.0));
  return b / (dot(b, vec4(1.0)) + 0.00001);
}

/**
 * The materials at a game point: the detail texel's 4 materials with their intensities, those of the next texels
 * added where they name the same material (bilinear), each material's diffuse (alpha: height) sampled at its own
 * tiling, blended by height; then normals (x in G, y in A) and properties of the blended ones.
 */
void details(vec2 g, out vec4 diffuse, out vec3 normal, out vec4 props) {
  vec2 c = g * uDetailSize / uSize;
  vec2 cf = floor(c);
  vec2 f = c - cf;
  ivec2 q = ivec2(cf);
  ivec2 top = ivec2(uDetailSize) - 1;
  uvec4 t0 = texelFetch(uDetail, clamp(q, ivec2(0), top), 0);
  uvec4 idx = t0 & 255u;
  vec4 mask = vec4(t0 >> 8u) / 255.0 * ((1.0 - f.x) * (1.0 - f.y));
  vec3 fw = vec3(f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  for (int k = 0; k < 3; k++) {
    uvec4 t = texelFetch(uDetail, clamp(q + ivec2(k == 1 ? 0 : 1, k == 0 ? 0 : 1), ivec2(0), top), 0);
    vec4 m = vec4(t >> 8u) / 255.0 * fw[k];
    uvec4 ti = t & 255u;
    for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) if (idx[j] == ti[i]) mask[j] += m[i];
  }
  vec2 uv = (g + uTileOffset) * uTileDefault;
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec4 s[4];
  vec4 k = vec4(tileOf(idx.x), tileOf(idx.y), tileOf(idx.z), tileOf(idx.w)) / uTileDefault;
  for (int i = 0; i < 4; i++) s[i] = mask[i] > 0.0 ? textureGrad(uDiffuseArr, vec3(uv * k[i], float(idx[i])), dx * k[i], dy * k[i]) * smoothstep(0.0, 0.1, mask[i]) : vec4(0.0);
  vec4 bf = heightBlend(vec4(s[0].a, s[1].a, s[2].a, s[3].a), mask);
  diffuse = s[0] * bf.x + s[1] * bf.y + s[2] * bf.z + s[3] * bf.w;
  vec4 ns = vec4(0.0);
  props = vec4(0.0);
  // (a slot without intensity can get a share when the blend range is wide — AGOT's is 1 —, as in the game)
  for (int i = 0; i < 4; i++) {
    if (bf[i] <= 0.0) continue;
    vec3 at = vec3(uv * k[i], float(idx[i]));
    ns += textureGrad(uNormalArr, at, dx * k[i], dy * k[i]) * bf[i];
    props += textureGrad(uPropsArr, at, dx * k[i], dy * k[i]) * bf[i];
  }
  if (dot(bf, vec4(1.0)) < 0.01) {
    ns = vec4(0.5);
    props = vec4(0.0, 0.0, 0.0, 1.0);
  }
  float nx = ns.g * 2.0 - 1.0;
  float ny = -(ns.a * 2.0 - 1.0);
  normal = vec3(nx, ny, sqrt(clamp(1.0 - nx * nx - ny * ny, 0.0, 1.0)));
}

/** ReorientNormal (cw/utility.fxh): a detail normal (z up) onto the relief's normal (y up) — game space. */
vec3 reorient(vec3 base, vec3 detail) {
  vec3 t = base + vec3(0.0, 0.0, 1.0);
  vec3 u = detail * vec3(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}

/** Pegtop's soft light, with opacity. */
vec3 softLight(vec3 base, vec3 blend, float opacity) {
  return mix(base, (1.0 - 2.0 * blend) * base * base + 2.0 * base * blend, opacity);
}
`;

export const TERRAIN_FRAG = `${COMMON}${DETAIL}
in vec2 vMap;
in float vHeight;
out vec4 fragColor;

/**
 * The terrain style: materials (or the colour map alone until they are loaded) with the colour map laid over them, the
 * relief's normals with the materials' normal maps, the game's lighting, haze and post-processing; the mode's colour
 * as the game lays a map mode on the terrain, into the albedo before lighting and over the result after it (here
 * after post-processing, shaded by the sun: filled groups keep their legend's colour).
 */
vec3 terrainLook(vec2 p, float d, bool grouped, vec3 mode, float field) {
  vec2 g = game(p);
  vec3 colormap = toLinear(texture(uBack, p / uSize).rgb);
  vec4 diffuse = vec4(colormap, 0.0);
  vec3 dn = vec3(0.0, 0.0, 1.0);
  vec4 props = vec4(0.0, 0.0, 0.0, 1.0);
  vec3 albedo = colormap;
  if (uHasDetail > 0.5) {
    details(g, diffuse, dn, props);
    albedo = softLight(diffuse.rgb, colormap, 1.0 - props.r);
  }
  // the relief (CalculateNormal: heights a normal step apart, or the pixel's footprint when far) — game space
  float lodH = max(0.0, log2(d * uHSize.x / uSize.x));
  float s = max(d, uSize.x / uHSize.x);
  float hl = heightAt(p - vec2(s, 0.0), lodH);
  float hr = heightAt(p + vec2(s, 0.0), lodH);
  float hn = heightAt(p - vec2(0.0, s), lodH);
  float hs = heightAt(p + vec2(0.0, s), lodH);
  vec3 tn = normalize(vec3((hl - hr) * uNormalScale, 2.0 * s, (hs - hn) * uNormalScale));
  vec3 gn = uHasDetail > 0.5 ? reorient(tn, dn) : tn;
  vec3 n = vec3(gn.x, gn.y, -gn.z);
  vec3 world = vec3(p.x, vHeight, p.y);
  vec3 v = normalize(cameraPosition - world);
  vec3 o = grouped ? overlayAt(field) : vec3(0.0);
  vec3 pm = painted(mode, p);
  albedo = mix(albedo, toLinear(pm), o.y * o.x);
  // slopes turned from the sun towards the shadow's colour (ApplyTerrainShadowTintWithClouds)
  vec4 st = shadowTint(p);
  vec3 lit = mix(mapLighting(albedo, n, props.a, props.g, props.b, v, uSunColor, uIbl), st.rgb, st.a * (1.0 - tintLit(n, uLight)));
  vec3 col = post(hazed(lit, world));
  return grouped ? mix(col, pm * mix(0.7, 1.06, clamp(dot(n, uLight), 0.0, 1.0)), o.z * o.x) : col;
}

void main() {
  vec2 p = vMap;
  vec2 fw = fwidth(p);
  // map pixels per screen pixel
  float d = max(max(fw.x, fw.y), 1e-3);
  vec3 back = texture(uBack, p / uSize).rgb;
  vec3 wt = waterTone(back);
  float lodH = max(0.0, log2(d * uHSize.x / uSize.x));
  uint id;
  uint g;
  vec3 e = borders(p, d, id, g);
  vec4 c = texelFetch(uColor, palAt(id), 0);
  int kind = kindOf(c);
  bool water = (kind & 1) != 0;
  bool grouped = (kind & 2) != 0;
  vec3 col;
  // (the terrain style: ground wherever it is — the water plane covers what lies below the water level —, lakes and
  // river provinces above the water level still water: the game draws them as meshes of their own)
  if (uStyle == 0 && ((kind & 4) == 0 || vHeight < uWaterLevel)) col = terrainLook(p, d, grouped && !water, c.rgb, texture(uField, p / uSize).r * 63.75);
  else if (uStyle == 0) {
    vec3 world = vec3(p.x, vHeight, p.y);
    col = post(hazed(waterLit(vec3(0.11, 0.17, 0.19), vec3(0.0, 1.0, 0.0), normalize(cameraPosition - world)), world));
    if (grouped) col = mix(col, c.rgb, 0.45);
  } else {
    float lum = dot(back, vec3(0.3, 0.55, 0.15));
    if (grouped) col = uStyle == 2 ? c.rgb : uStyle == 1 ? mix(back, c.rgb, 0.6) : mix(c.rgb * (0.55 + lum * 0.9), back, 0.2);
    // (water seen here is above the water level: the water plane covers the rest)
    else if (water) col = uStyle == 1 ? wt : riverTone();
    else col = uStyle == 2 ? vec3(0.3, 0.29, 0.27) : back * 0.85;
    // relief: the sun on the slopes (a height pixel apart, or the pixel's footprint when far)
    float s = max(d, uSize.x / uHSize.x);
    float hl = heightAt(p - vec2(s, 0.0), lodH);
    float hr = heightAt(p + vec2(s, 0.0), lodH);
    float hu = heightAt(p - vec2(0.0, s), lodH);
    float hd = heightAt(p + vec2(0.0, s), lodH);
    vec3 n = normalize(vec3((hl - hr) * 1.6, 2.0 * s, (hu - hd) * 1.6));
    float k = uStyle == 1 ? 0.7 : 1.1;
    col *= clamp(1.0 + k * (dot(n, uLight) - uLight.y), 0.35, 1.3);
  }

  if (!water && uStyle != 1) col = mix(col, riverTone(), riverAt(p, d) * 0.9);

  if (g != 0u && g == uHover) col = mix(col, vec3(1.0), 0.18);
  if (g != 0u && g == uSel) col = mix(col, vec3(1.0, 0.93, 0.7), 0.3);
  // provinces faintly, only near
  if (!water) col *= mix(1.0, mix(0.72, 1.0, clamp((d - 0.4) / 0.8, 0.0, 1.0)), e.y * (1.0 - e.x));
  // (group lines lighter far away, where they are a pixel wide)
  col = mix(col, col * (water ? 0.8 : mix(0.45, 0.62, clamp(d - 1.0, 0.0, 1.0))), e.x);
  col = mix(col, vec3(1.0, 0.9, 0.55), e.z);
  fragColor = vec4(fogged(col, vec3(p.x, vHeight, p.y)), 1.0);
}
`;

/**
 * The sky (map3d.ts): a dome around the eye — the horizon's colour (the fog's: far land fades into it) to a darker one
 * above. Drawn first, without depth.
 */
export const SKY_VERT = `
uniform float uRadius;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + position * uRadius, 1.0);
}
`;

export const SKY_FRAG = `
precision highp float;
uniform vec3 uFog;
uniform vec3 uZenith;
in vec3 vDir;
out vec4 fragColor;
void main() {
  float up = max(normalize(vDir).y, 0.0);
  fragColor = vec4(mix(uFog, uZenith, pow(up, 0.6)), 1.0);
}
`;

export const WATER_VERT = `
precision highp float;
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * The water surface at the water level: in the terrain style wherever the ground is below it, lit like the game's
 * water (jomini_water_default.fxh CalcWater: its colour map, three layers of wave normals, the sky's cubemap by
 * Fresnel, the sun's glint), see-through where shallow — the sea floor's materials show along the coasts; else over
 * water provinces in the 2D map's tones. Around the map too.
 */
export const WATER_FRAG = `${COMMON}
uniform sampler2D uWaves;
in vec3 vWorld;
out vec4 fragColor;

/** A layer of wave normals (SampleNormalMapTexture: rotated, scaled, flattened ×2) — game space, y up. */
vec3 wave(vec2 uv, float scale, float rot) {
  vec2 r = vec2(cos(rot), sin(rot));
  vec3 n = texture(uWaves, vec2(uv.x * r.x - uv.y * r.y, uv.x * r.y + uv.y * r.x) * scale).rgb * 2.0 - 1.0;
  n = n.xzy;
  n.xz = vec2(n.x * r.x + n.z * r.y, -n.x * r.y + n.z * r.x);
  return normalize(vec3(n.x, n.y * 2.0, -n.z));
}

void main() {
  vec2 p = vWorld.xz;
  vec2 fw = fwidth(p);
  float d = max(max(fw.x, fw.y), 1e-3);
  vec2 uv = clamp(p, vec2(0.5), uSize - 0.5) / uSize;
  float outside = length(max(max(-p, p - uSize), 0.0));
  // (around the map: the open sea's colour; the paper map's edge, blurred)
  vec3 back = outside > 0.0 ? textureLod(uBack, uv, 7.0).rgb : texture(uBack, uv).rgb;
  vec3 wtex = outside > 0.0 ? vec3(0.094, 0.141, 0.161) : texture(uWater, uv).rgb;
  vec3 wt = waterTone(back);
  vec3 v = normalize(cameraPosition - vWorld);
  float depth = 1e3;
  float alpha = 1.0;
  vec3 col;
  uint g = 0u;
  vec4 c = vec4(0.0);
  vec3 e = vec3(0.0);
  if (outside <= 0.0) {
    uint id;
    vec3 eb = borders(p, d, id, g);
    c = texelFetch(uColor, palAt(id), 0);
    bool sea = (kindOf(c) & 1) != 0;
    // (the terrain style has water wherever the ground is below the water level, as the game; the maps over water provinces)
    if (!sea && uStyle != 0) discard;
    depth = uWaterLevel - heightAt(p, max(0.0, log2(d * uHSize.x / uSize.x)));
    if (depth < 0.0) discard;
    if (sea) e = eb;
    else {
      c = vec4(0.0);
      g = 0u;
    }
  }
  if (uStyle == 0) {
    // the game's water: its colour map (the sea's colour; land painted there too), waves (UV = game x, −z × 0.05;
    // layers × 7, 0.7, 0.3 turned −0.35, −1.6, 1.7 rad), the sky by Fresnel (bias 0.1, power 4), the sun's glint;
    // shallow water lets the sea floor through
    vec2 wuv = game(p) * vec2(1.0, -1.0) * 0.05;
    vec3 gn = normalize(wave(wuv, 7.0, -0.35) + wave(wuv, 0.7, -1.6) + wave(wuv, 0.3, 1.7));
    vec3 lin = waterLit(wtex, vec3(gn.x, gn.y, -gn.z), v);
    if ((kindOf(c) & 2) != 0) lin = mix(lin, toLinear(c.rgb) * 0.8, 0.55);
    col = post(hazed(lin, vWorld));
    alpha = outside > 0.0 ? 1.0 : mix(0.35, 1.0, smoothstep(0.0, uWaterLevel * 0.6, depth));
  } else {
    col = wt;
    if (outside <= 0.0) {
      // shallow water lighter, a rim along the coast
      float rel = depth / max(uWaterLevel, 0.5);
      col *= mix(1.25, 0.85, smoothstep(0.0, 1.0, rel));
      col = mix(col, vec3(0.62, 0.72, 0.7), (1.0 - smoothstep(0.0, 0.08, rel)) * 0.35);
      if ((kindOf(c) & 2) != 0) col = uStyle == 2 ? c.rgb : mix(col, c.rgb, 0.55);
    }
    // the sky's light when looking across; the sun's glint
    col = mix(col, vec3(0.4, 0.5, 0.58), pow(1.0 - max(v.y, 0.0), 5.0) * 0.4);
    col += vec3(1.0, 0.95, 0.85) * pow(max(dot(reflect(-uLight, vec3(0.0, 1.0, 0.0)), v), 0.0), 120.0) * 0.12;
  }
  if (outside > 0.0) col = mix(col, uFog, smoothstep(0.0, uSize.y * 0.25, outside));
  else {
    if (g != 0u && g == uHover) col = mix(col, vec3(1.0), 0.18);
    if (g != 0u && g == uSel) col = mix(col, vec3(1.0, 0.93, 0.7), 0.3);
    col = mix(col, col * 0.8, e.x);
    col = mix(col, vec3(1.0, 0.9, 0.55), e.z);
  }
  fragColor = vec4(fogged(col, vWorld), alpha);
}
`;

/**
 * Map objects (map3d-objects.ts): a mesh part instanced per object — game x, y over the ground, game z (aPos), yaw
 * and scale (aTurn) — on the terrain's height at its origin (at least the water level when `uClamp`); game space
 * mirrored in z like the map. Objects under a screen pixel tall are dropped (`vSize`: the height in pixels). The
 * ground's normal at the origin (`vGround`, as the terrain's relief) goes to the shadow tint.
 */
export const OBJECT_VERT = `
precision highp float;
uniform sampler2D uHeight;
uniform vec2 uSize;
uniform vec2 uHSize;
uniform float uNormalScale;
uniform float uHeightScale;
uniform float uWaterLevel;
uniform float uClamp;
// snap_to_terrain shaders: each vertex on the ground at its own point, raised by its own height (pdxmesh.fxh SnapVerticesToTerrain)
uniform float uSnap;
// screen pixels per world unit at distance 1; the model's height
uniform float uPxScale;
uniform float uModelHeight;
in vec4 aTangent;
in vec3 aPos;
in vec2 aTurn;
out vec2 vUv;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vTangent;
out float vSeed;
out float vSize;
out vec3 vGround;
vec3 turn(vec3 v, float c, float s) { return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
float groundAt(vec2 p) { return textureLod(uHeight, p / uSize, 0.0).r * uHeightScale; }
void main() {
  vec2 at = vec2(aPos.x, uSize.y - aPos.z);
  float ground = textureLod(uHeight, at / uSize, 0.0).r * uHeightScale;
  if (uClamp > 0.5) ground = max(ground, uWaterLevel);
  vec3 origin = vec3(at.x, ground + aPos.y, at.y);
  vSize = uModelHeight * aTurn.y * uPxScale / max(distance(cameraPosition, origin), 1.0);
  if (vSize < 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float c = cos(aTurn.x);
  float s = sin(aTurn.x);
  vec3 r = turn(position * aTurn.y, c, s);
  vWorld = origin + vec3(r.x, r.y, -r.z);
  if (uSnap > 0.5) vWorld.y = groundAt(vWorld.xz) + r.y;
  vec3 n = turn(normal, c, s);
  vec3 t = turn(aTangent.xyz, c, s);
  vNormal = vec3(n.x, n.y, -n.z);
  vTangent = vec4(t.x, t.y, -t.z, aTangent.w);
  vUv = uv;
  vSeed = fract(sin(dot(aPos.xz, vec2(12.9898, 78.233))) * 43758.5453);
  // (heights a height raster pixel apart, as the terrain's CalculateNormal; the same for all of an object's vertices)
  float st = max(1.0, uSize.x / uHSize.x);
  float hl = groundAt(at - vec2(st, 0.0));
  float hr = groundAt(at + vec2(st, 0.0));
  float hn = groundAt(at - vec2(0.0, st));
  float hs = groundAt(at + vec2(0.0, st));
  vGround = normalize(vec3((hl - hr) * uNormalScale, 2.0 * st, (hn - hs) * uNormalScale));
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

/**
 * A map object's pixel (gfx/FX tree.shader PS_leaf; pdxmesh.shader for others): diffuse (trees: alpha to coverage
 * around 0.4, as the game's tree BlendState), normal map (x in G, y in A; trees: B masks the tint), properties; trees
 * take a tint from their strip by a random per instance and the colour map laid over them; the mode's colour of the
 * ground under it before and after lighting (tree.shader: GetBorderColorAndBlendGame); lit like the terrain with the
 * shadow tint, then haze and post-processing. Fades out by dithering (`uFade`: 1 shown … 0 gone; small ones too).
 */
export const OBJECT_FRAG = `${COMMON}
uniform sampler2D uDiffuse;
uniform sampler2D uNormal;
uniform sampler2D uProps;
uniform sampler2D uTint;
uniform float uTree;
// alpha_to_coverage shaders: the diffuse alpha cuts the shape out (as trees)
uniform float uCoverage;
uniform float uHasTint;
uniform float uFade;
// the terrain's sun (\`uLight\` is the objects' own for all but trees)
uniform vec3 uTerrainLight;
in vec2 vUv;
in vec3 vWorld;
in vec3 vNormal;
in vec4 vTangent;
in float vSeed;
in float vSize;
in vec3 vGround;
out vec4 fragColor;
vec3 overlay(vec3 base, vec3 blend) { return mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), step(0.5, base)); }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy) & 3;
  float dither = float((px.x * 2 + px.y * 7 + (px.x & px.y) * 5) & 15) / 16.0;
  if (dither >= uFade * smoothstep(1.0, 3.0, vSize)) discard;
  vec4 diffuse = texture(uDiffuse, vUv);
  float alpha = 1.0;
  if (uTree > 0.5 || uCoverage > 0.5) {
    if (diffuse.a < 0.05) discard;
    alpha = clamp((diffuse.a - 0.4) / max(fwidth(diffuse.a), 1e-4) + 0.5, 0.0, 1.0);
  }
  vec4 nm = texture(uNormal, vUv);
  vec4 props = texture(uProps, vUv);
  float nx = nm.g * 2.0 - 1.0;
  float ny = -(nm.a * 2.0 - 1.0);
  vec3 ts = vec3(nx, ny, sqrt(clamp(1.0 - nx * nx - ny * ny, 0.0, 1.0)));
  vec3 n = normalize(vNormal);
  // (some meshes carry no usable tangents: any direction across the normal)
  vec3 t = vTangent.xyz - n * dot(n, vTangent.xyz);
  t = dot(t, t) > 1e-8 ? normalize(t) : normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  // (the game's bitangent is cross(N, T) × w; mirrored in z, a cross product turns: the other way round here)
  vec3 b = cross(t, n) * (vTangent.w < 0.0 ? -1.0 : 1.0);
  n = normalize(t * ts.x + b * ts.y + n * ts.z);
  vec3 v = normalize(cameraPosition - vWorld);
  // (the mirrored z turns the winding: the side a normal faces is drawn as the back face). Leaves keep their normal
  // from both sides, as the game's (up and out of the crown: seen from below or from the shaded side, they are dark)
  if (uTree < 0.5 && gl_FrontFacing) n = -n;
  vec3 albedo = diffuse.rgb;
  vec2 p = vWorld.xz;
  if (uTree > 0.5) {
    if (uHasTint > 0.5) albedo = mix(albedo, overlay(texture(uTint, vec2(vSeed, 0.5)).rgb, albedo), nm.b);
    albedo = overlay(toLinear(texture(uBack, p / uSize).rgb), albedo);
  }
  uint id = idAt(ivec2(floor(p)));
  vec4 c = texelFetch(uColor, palAt(id), 0);
  bool grouped = (kindOf(c) & 3) == 2;
  vec3 o = grouped ? overlayAt(texture(uField, p / uSize).r * 63.75) : vec3(0.0);
  vec3 pm = painted(c.rgb, p);
  albedo = mix(albedo, toLinear(pm), o.y * o.x);
  // the shadow tint (tree.shader, pdxmesh.shader's MAP_LIGHTING_HACK): the sun dimmed where the ground is turned from
  // it (others: the ground and the object, both to the terrain's sun), then the shaded sides tinted
  vec4 st = shadowTint(p);
  float ground = tintLit(vGround, uTerrainLight);
  float shade = uTree > 0.5 ? 1.0 - ground : clamp(2.0 - ground - clamp(dot(n, uTerrainLight), 0.0, 1.0) - 1e-5, 0.0, 1.0);
  float shadow = 1.0 - st.a * shade;
  vec3 lit = mapLighting(albedo, n, props.a, props.g, props.b, v, uSunColor * shadow, uIbl);
  lit = mix(lit, st.rgb, st.a * clamp(3.0 - tintLit(vGround, uLight) - shadow - clamp(dot(n, uLight), 0.0, 1.0) - 1e-5, 0.0, 1.0));
  vec3 col = post(hazed(lit, vWorld));
  if (grouped) col = mix(col, pm * mix(0.7, 1.06, clamp(dot(n, uLight), 0.0, 1.0)), o.z * o.x);
  uint g = groupOf(id);
  if (g != 0u && g == uHover) col = mix(col, vec3(1.0), 0.18);
  if (g != 0u && g == uSel) col = mix(col, vec3(1.0, 0.93, 0.7), 0.3);
  fragColor = vec4(fogged(col, vWorld), alpha);
}
`;
