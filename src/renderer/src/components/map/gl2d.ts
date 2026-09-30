/**
 * The 2D map's WebGL2 drawing (docs/map.md, "Presentation"): the province raster as an R16UI texture, two palettes
 * per mode indexed by province id (colour + kind, group), the background picture (terrain colour map / paper map), a
 * coarse distance field per mode (inner glow along borders, shallow water along coasts), borders between groups and
 * provinces — smooth lines when zoomed in —, hover and selection.
 */
import type { MapInfo } from '../../../../shared/api';
import { WATER, rgbOf, type Groups, type Style } from './model';

/** palette texture width (province id → texel) */
const PAL_W = 4096;
/** the group palette's values of seas and lakes, of rivers (ungrouped land: 0, a group: its index + 1) */
const WATER_GROUP = 0xffffffff;
const RIVER_GROUP = 0xfffffffe;
/** map pixels per cell of the distance field; its texels hold 8 steps per cell */
const FIELD_CELL = 4;
const FIELD_STEPS = 8;

export interface View
{
    /** map pixel at the canvas's top left, map pixels per CSS pixel */
    x: number;
    y: number;
    scale: number;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// kinds in the colour palette's alpha: 0 water, 128 land without a group, 255 land with a group colour
const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uIds;
uniform sampler2D uColor;
uniform usampler2D uGroup;
uniform sampler2D uBack;
uniform sampler2D uField;
uniform int uStyle;
uniform vec2 uSize;
uniform vec2 uOrigin;
uniform float uScale;
uniform vec2 uCanvas;
uniform uint uHover;
uniform uint uSel;
uniform float uFieldScale;
uniform float uGlow;
// the groups are a numeric layer's bands
uniform bool uBands;
out vec4 o;

const uint WATER = 0xffffffffu;
const uint RIVER = 0xfffffffeu;

ivec2 palAt(uint id) { return ivec2(int(id & 4095u), int(id >> 12)); }
uint idAt(ivec2 q) { return texelFetch(uIds, clamp(q, ivec2(0), ivec2(uSize) - 1), 0).r; }
uint groupOf(uint id) { return texelFetch(uGroup, palAt(id), 0).r; }

// Zoomed in: each group's (and province's) indicator smoothed by a quadratic B-spline over the 3 × 3 texels around p;
// p is in the one with the highest value, the edge is where it ties with the next — its distance (map pixels) is the
// difference over the difference's gradient. Stair steps become smooth curves.
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

// Zoomed out (a screen pixel over one map pixel or more): the id under p and its neighbours one screen pixel away.
void coarseAt(vec2 p, float d, out uint id, out uint g, out uint gNext, out float dG, out float dP) {
  ivec2 q = ivec2(floor(p));
  id = idAt(q);
  g = groupOf(id);
  gNext = g;
  dG = 1e3;
  dP = 1e3;
  vec2 dirs[4] = vec2[4](vec2(d, 0.0), vec2(0.0, d), vec2(-d, 0.0), vec2(0.0, -d));
  for (int k = 0; k < 4; k++) {
    uint n = idAt(ivec2(floor(p + dirs[k])));
    uint ng = groupOf(n);
    if (ng != g) { gNext = ng; dG = 0.0; }
    if (n != id) dP = 0.0;
  }
}

void main() {
  vec2 p = uOrigin + vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) * uScale;
  if (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) { o = vec4(0.075, 0.08, 0.095, 1.0); return; }
  uint id; uint g; uint gNext; float dG; float dP;
  if (uScale < 1.0) smoothAt(p, id, g, gNext, dG, dP);
  else coarseAt(p, uScale, id, g, gNext, dG, dP);
  vec4 c = texelFetch(uColor, palAt(id), 0);
  vec3 back = texture(uBack, p / uSize).rgb;
  float lum = dot(back, vec3(0.3, 0.55, 0.15));
  // map pixels to the nearest change of group (for water: to the coast)
  float field = texture(uField, p / uSize).r * uFieldScale;
  bool water = c.a < 0.25;
  vec3 col;
  if (water) {
    // deep water darker, the shallows along the coast (and rivers) lighter; the paper map's sea as it is painted
    float shallow = g == RIVER ? 0.85 : exp(-field / 36.0);
    if (uStyle == 1) col = g == RIVER ? back * vec3(0.78, 0.9, 1.0) : back * mix(0.94, 1.1, shallow);
    else {
      vec3 sea = mix(vec3(0.075, 0.12, 0.17), vec3(0.2, 0.29, 0.32), shallow);
      col = uStyle == 2 ? sea : mix(sea, back * vec3(0.55, 0.7, 0.8), 0.18);
    }
  } else if (c.a < 0.75) {
    col = uStyle == 2 ? vec3(0.3, 0.29, 0.27) : uStyle == 1 ? back * 0.88 : mix(back, vec3(lum), 0.4) * 0.8;
  } else {
    // the mode's colour with the terrain's light and shade in it (on paper: laid on like ink wash, the grain shows)
    col = uStyle == 2 ? c.rgb : uStyle == 1 ? back * mix(vec3(1.0), min(c.rgb * 1.3, 1.0), 0.78) * 1.08 : mix(c.rgb * (0.55 + lum * 0.9), back, 0.2);
    // an inner glow along the group's border: its colour deeper there
    float glow = uBands ? 0.0 : 1.0 - smoothstep(0.0, uGlow, field);
    col = mix(col, pow(col, vec3(1.45)) * 0.9, glow * 0.6);
  }
  if (g != 0u && g == uHover) col = mix(col, vec3(1.0), 0.18);
  if (g != 0u && g == uSel) col = mix(col, vec3(1.0, 0.93, 0.7), 0.28);
  // borders in screen pixels: groups wider as the map is zoomed in, provinces faint and only when zoomed in; river
  // banks thin (a realm goes on across its rivers)
  float sG = dG / uScale;
  float sP = dP / uScale;
  float zoom = clamp(-log2(uScale) / 4.0, 0.0, 1.0);
  bool river = g == RIVER || gNext == RIVER;
  float hw = river ? 0.4 : uScale < 1.0 ? mix(0.75, 1.6, zoom) : 0.5;
  float aG = clamp(hw + 0.5 - sG, 0.0, 1.0) * (river ? 0.55 : 1.0);
  float aP = water ? 0.0 : clamp(1.0 - sP, 0.0, 1.0) * (1.0 - smoothstep(0.8, 2.5, uScale)) * mix(0.3, 0.45, zoom);
  bool coast = water != (gNext >= RIVER);
  // (between a numeric layer's bands a faint line, as between provinces)
  bool band = uBands && !coast && !river;
  if (band) aP = max(aP, clamp(1.0 - sG, 0.0, 1.0) * 0.3);
  vec3 ink = uStyle == 1 ? vec3(0.2, 0.14, 0.09) : col * (water ? 0.72 : 0.38);
  if (aP > 0.0) col = mix(col, ink, aP);
  bool selEdge = uSel != 0u && !river && (g == uSel || gNext == uSel);
  if (aG > 0.0 && (!band || selEdge)) {
    vec3 line = selEdge ? vec3(1.0, 0.88, 0.5) : coast && water ? mix(col, vec3(0.05, 0.06, 0.07), 0.5) : ink;
    col = mix(col, line, aG * (selEdge ? 1.0 : 0.92));
  }
  o = vec4(col, 1.0);
}`;

function texture(gl: WebGL2RenderingContext, filter: number): WebGLTexture
{
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

/** another group than `r` next to it — a river is none */
const differs = (o: number, r: number): boolean => o !== r && o !== RIVER_GROUP;

/** cells a border reaches in the field: its steps saturate at 255 (a cell is 3 steps of the chamfer, FIELD_STEPS / 3 per step) */
const FIELD_REACH = Math.ceil((255 * 3) / FIELD_STEPS / 3) + 1;
/** the field is redone in tiles of this many cells around changed provinces */
const FIELD_TILE = 32;

/**
 * Per cell of FIELD_CELL map pixels: the distance to the nearest cell of another group (water is one; rivers are
 * no border: a realm goes on across them; chamfer 3-4 in two passes), FIELD_STEPS per cell, up to 255 — computed over
 * the cells [cx0, cx1) × [cy0, cy1) (the cells around only as neighbours) and written for [ox0, ox1) × [oy0, oy1) into
 * `out` (w × h cells: the whole field).
 */
function fieldPart(ids: Uint16Array, width: number, height: number, group: Uint32Array, out: Uint8Array, c: number[], o: number[]): void
{
    const k = FIELD_CELL;
    const w = Math.ceil(width / k);
    const h = Math.ceil(height / k);
    const [cx0, cy0, cx1, cy1] = c;
    const cw = cx1 - cx0;
    const ch = cy1 - cy0;
    // the cells' regions, one cell more around (neighbours)
    const rx0 = Math.max(0, cx0 - 1);
    const ry0 = Math.max(0, cy0 - 1);
    const rw = Math.min(w, cx1 + 1) - rx0;
    const reg = new Uint32Array(rw * (Math.min(h, cy1 + 1) - ry0));

    for (let y = ry0; y < ry0 + reg.length / rw; y++)
    {
        const row = Math.min(height - 1, y * k + (k >> 1)) * width;

        for (let x = rx0; x < rx0 + rw; x++)
            reg[(y - ry0) * rw + x - rx0] = group[ids[row + Math.min(width - 1, x * k + (k >> 1))]];
    }

    // (thirds of a cell: a border cell is a third away from the border)
    const d = new Uint16Array(cw * ch).fill(60000);

    for (let y = cy0; y < cy1; y++)
    {
        for (let x = cx0; x < cx1; x++)
        {
            const i = (y - ry0) * rw + x - rx0;
            const r = reg[i];

            if (r === RIVER_GROUP)
                continue;

            if ((x > 0 && differs(reg[i - 1], r)) || (x < w - 1 && differs(reg[i + 1], r)) || (y > 0 && differs(reg[i - rw], r)) || (y < h - 1 && differs(reg[i + rw], r)))
                d[(y - cy0) * cw + x - cx0] = 1;
        }
    }

    for (let y = 0; y < ch; y++)
    {
        for (let x = 0; x < cw; x++)
        {
            const i = y * cw + x;
            let v = d[i];

            if (x > 0)
                v = Math.min(v, d[i - 1] + 3);

            if (y > 0)
            {
                v = Math.min(v, d[i - cw] + 3);

                if (x > 0)
                    v = Math.min(v, d[i - cw - 1] + 4);

                if (x < cw - 1)
                    v = Math.min(v, d[i - cw + 1] + 4);
            }

            d[i] = v;
        }
    }

    for (let y = ch - 1; y >= 0; y--)
    {
        for (let x = cw - 1; x >= 0; x--)
        {
            const i = y * cw + x;
            let v = d[i];

            if (x < cw - 1)
                v = Math.min(v, d[i + 1] + 3);

            if (y < ch - 1)
            {
                v = Math.min(v, d[i + cw] + 3);

                if (x < cw - 1)
                    v = Math.min(v, d[i + cw + 1] + 4);

                if (x > 0)
                    v = Math.min(v, d[i + cw - 1] + 4);
            }

            d[i] = v;
        }
    }

    const [ox0, oy0, ox1, oy1] = o;

    for (let y = oy0; y < oy1; y++)
        for (let x = ox0; x < ox1; x++)
            out[y * w + x] = Math.min(255, Math.round((d[(y - cy0) * cw + x - cx0] * FIELD_STEPS) / 3));
}

/**
 * The distance field for a group palette: all of it, or — given the last palette and field of the same raster — only
 * the tiles near provinces whose group changed (a new date moves a few borders), with the cells a border reaches
 * around them computed too.
 */
function distanceField(info: MapInfo, ids: Uint16Array, group: Uint32Array, last?: { group: Uint32Array; data: Uint8Array; }): { data: Uint8Array; w: number; h: number; }
{
    const w = Math.ceil(info.width / FIELD_CELL);
    const h = Math.ceil(info.height / FIELD_CELL);
    const changed: number[] = [];

    if (last)
    {
        for (let p = 0; p < info.count && changed.length <= info.count / 8; p++)
            if (last.group[p] !== group[p])
                changed.push(p);
    }

    if (!last || changed.length > info.count / 8)
    {
        const data = new Uint8Array(w * h);
        fieldPart(ids, info.width, info.height, group, data, [0, 0, w, h], [0, 0, w, h]);
        return { data, w, h };
    }

    const data = last.data.slice();
    const T = FIELD_TILE;
    const tw = Math.ceil(w / T);
    const th = Math.ceil(h / T);
    const dirty = new Uint8Array(tw * th);
    const B = info.province.box;

    for (const p of changed)
    {
        const x0 = Math.max(0, Math.floor(B[p * 4] / FIELD_CELL) - FIELD_REACH);
        const y0 = Math.max(0, Math.floor(B[p * 4 + 1] / FIELD_CELL) - FIELD_REACH);
        const x1 = Math.min(w - 1, Math.floor(B[p * 4 + 2] / FIELD_CELL) + FIELD_REACH);
        const y1 = Math.min(h - 1, Math.floor(B[p * 4 + 3] / FIELD_CELL) + FIELD_REACH);

        for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++)
            for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++)
                dirty[ty * tw + tx] = 1;
    }

    // (tiles cost their cells and the reach around: more than half the map's cells — all of it at once)
    let n = 0;

    for (const t of dirty)
        n += t;

    if (n * (T + 2 * FIELD_REACH) ** 2 > (w * h) / 2)
    {
        fieldPart(ids, info.width, info.height, group, data, [0, 0, w, h], [0, 0, w, h]);
        return { data, w, h };
    }

    for (let ty = 0; ty < th; ty++)
    {
        for (let tx = 0; tx < tw; tx++)
        {
            if (!dirty[ty * tw + tx])
                continue;

            const o = [tx * T, ty * T, Math.min(w, tx * T + T), Math.min(h, ty * T + T)];
            const c = [Math.max(0, o[0] - FIELD_REACH), Math.max(0, o[1] - FIELD_REACH), Math.min(w, o[2] + FIELD_REACH), Math.min(h, o[3] + FIELD_REACH)];
            fieldPart(ids, info.width, info.height, group, data, c, o);
        }
    }

    return { data, w, h };
}

/** the raster the 2D map was last built from (labels and the overview read it) */
let lastRaster: { key: string; ids: Uint16Array; } | undefined;

/** The province ids of a map, when the 2D map has them. */
export function rasterOf(info: MapInfo): Uint16Array | undefined
{
    return lastRaster?.key === info.key ? lastRaster.ids : undefined;
}

export class Map2D
{
    private gl: WebGL2RenderingContext;
    private prog: WebGLProgram;
    private buf: WebGLBuffer;
    private tex: { ids: WebGLTexture; color: WebGLTexture; group: WebGLTexture; back: WebGLTexture; field: WebGLTexture; };
    private u: Record<string, WebGLUniformLocation | null> = {};
    private info: MapInfo;
    private ids: Uint16Array;
    /** map pixels of the inner glow along borders (wider for bigger groups) */
    private glow = 12;
    /** the groups are a numeric layer's bands */
    private bands = false;
    /** the last group palette and its distance field (a new date redoes only the tiles near changed provinces) */
    private field: { group: Uint32Array; data: Uint8Array; } | undefined;

    /** Throws with a message for the user (no WebGL2, the map larger than the GPU's textures, a shader error). */
    constructor(canvas: HTMLCanvasElement, info: MapInfo, ids: Uint16Array)
    {
        const gl = canvas.getContext('webgl2', { antialias: false });

        if (!gl)
            throw new Error('WebGL2 is not available');

        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

        if (info.width > max || info.height > max)
            throw new Error(`The map (${info.width} × ${info.height}) is larger than this GPU's textures (${max})`);

        this.gl = gl;
        this.info = info;
        this.ids = ids;
        lastRaster = { key: info.key, ids };
        const sh = (type: number, src: string): WebGLShader =>
        {
            const s = gl.createShader(type)!;
            gl.shaderSource(s, src);
            gl.compileShader(s);

            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error('Map shader: ' + (gl.getShaderInfoLog(s) ?? ''));

            return s;
        };
        const prog = gl.createProgram()!;
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            throw new Error('Map shader: ' + (gl.getProgramInfoLog(prog) ?? ''));

        this.prog = prog;
        this.buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const idTex = texture(gl, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, info.width, info.height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ids);
        const back = texture(gl, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([90, 85, 75, 255]));
        const field = texture(gl, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
        this.tex = { ids: idTex, color: texture(gl, gl.NEAREST), group: texture(gl, gl.NEAREST), back, field };

        for (const n of ['uIds', 'uColor', 'uGroup', 'uBack', 'uField', 'uStyle', 'uSize', 'uOrigin', 'uScale', 'uCanvas', 'uHover', 'uSel', 'uFieldScale', 'uGlow', 'uBands'])
            this.u[n] = gl.getUniformLocation(prog, n);

        gl.useProgram(prog);
        [this.tex.ids, this.tex.color, this.tex.group, this.tex.back, this.tex.field].forEach((t, i) =>
        {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, t);
        });
        gl.uniform1i(this.u.uIds, 0);
        gl.uniform1i(this.u.uColor, 1);
        gl.uniform1i(this.u.uGroup, 2);
        gl.uniform1i(this.u.uBack, 3);
        gl.uniform1i(this.u.uField, 4);
    }

    /** The mode's palettes and distance field. */
    setGroups(groups: Groups): void
    {
        const { gl, info } = this;
        const rows = Math.ceil(info.count / PAL_W);
        const color = new Uint8Array(PAL_W * rows * 4);
        const group = new Uint32Array(PAL_W * rows);
        const P = info.province;

        for (let p = 0; p < info.count; p++)
        {
            const gi = groups.of[p];

            if (gi >= 0)
            {
                const [r, g, b] = rgbOf(groups.color(gi) ?? '#808080');
                color.set([r, g, b, 255], p * 4);
                group[p] = gi + 1;
            }
            else
            {
                const kind = info.kinds[P.kind[p]];
                const water = WATER.has(kind);
                color[p * 4 + 3] = water ? 0 : 128;
                group[p] = kind === 'river' ? RIVER_GROUP : water ? WATER_GROUP : 0;
            }
        }

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.tex.color);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PAL_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, color);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.tex.group);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, PAL_W, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, group);
        const f = distanceField(info, this.ids, group, this.field);
        this.field = { group, data: f.data };
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.tex.field);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.w, f.h, 0, gl.RED, gl.UNSIGNED_BYTE, f.data);
        // (the glow: an eighth of a typical group's width, 4–24 map pixels)
        let land = 0;

        for (const g of groups.bySize)
            land += groups.area[g];

        this.glow = Math.max(4, Math.min(24, Math.sqrt(land / Math.max(1, groups.bySize.length)) / 8));
        this.bands = !!groups.layer?.scale;
    }

    /** The picture under the colours (terrain colour map, paper map). */
    setBackground(img: HTMLImageElement): void
    {
        const { gl } = this;
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.tex.back);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        // (zoomed out, many texels fall on one pixel)
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }

    /** @param hover the hovered group + 1 (0: none), `sel` the selected one */
    draw(canvas: HTMLCanvasElement, view: View, style: Style, hover: number, sel: number): void
    {
        const { gl, u, info } = this;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);

        if (canvas.width !== w || canvas.height !== h)
        {
            canvas.width = w;
            canvas.height = h;
        }

        gl.viewport(0, 0, w, h);
        gl.useProgram(this.prog);
        gl.uniform2f(u.uSize, info.width, info.height);
        gl.uniform2f(u.uOrigin, view.x, view.y);
        gl.uniform1f(u.uScale, view.scale / dpr);
        gl.uniform2f(u.uCanvas, w, h);
        gl.uniform1i(u.uStyle, style === 'terrain' ? 0 : style === 'paper' ? 1 : 2);
        gl.uniform1ui(u.uHover, hover);
        gl.uniform1ui(u.uSel, sel);
        gl.uniform1f(u.uFieldScale, (255 / FIELD_STEPS) * FIELD_CELL);
        gl.uniform1f(u.uGlow, this.glow);
        gl.uniform1i(u.uBands, this.bands ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    dispose(): void
    {
        const { gl } = this;

        for (const t of Object.values(this.tex))
            gl.deleteTexture(t);

        gl.deleteBuffer(this.buf);
        gl.deleteProgram(this.prog);
    }
}
