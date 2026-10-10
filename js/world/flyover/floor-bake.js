import * as THREE from 'three';
import { HASH_GLSL, PERIODIC_GLSL } from '../../gl/noise.glsl.js';
import { fullscreenTriangle } from '../../lib/geometry.js';
import { mulberry32 } from '../../lib/random.js';
import { SUN_DIR } from '../layout.js';

// The close-up layer of the forest floor, baked once on the GPU: a Scots-pine floor seen from 0.85 m.
// Dark moist duff with crumbs, mycelium threads and a haze of moss protonema; three layers of crossing
// pine needles (decayed fragments, weathered grey-brown needles with needle-cast fungus, fresh russet
// ones on top, some still in pairs); bark plates and papery flakes, squirrel-gnawed cone scales, twig bits,
// birch-leaf skeletons, lichen lobes and sand grains. Everything tiles seamlessly.
//
// How: the humus is one full-screen pass; every needle, twig, flake, leaf, lichen and grain is a small
// instanced quad (laid out here in JS, deterministically) whose shader writes its height as depth, so the
// depth test keeps whatever lies on top. The depth buffer then is the height field: three small passes
// derive normals + AO and needle-on-needle sun shadows from it. Lots of tiny programs, no big loops, so
// even Direct3D's shader compiler gets through quickly.
//
// Outputs (RGBA8, mipmapped, repeat):
//   albedo — rgb albedo (sRGB) + roughness
//   normal — normal xy (×0.5+0.5, z reconstructed), height 0 … 1 (= 0 … FLOOR_DEPTH), ambient occlusion
//   extra  — sun visibility for sample A, for sample B (rotated), "lies on top of moss" mask, wetness

export const FLOOR_MAP = {
  tileA: 0.68, // metres per tile, sample A
  tileB: 0.57, // sample B: smaller …
  rotB: 2.1, // … and rotated (radians), so the two never line up
};
export const FLOOR_DEPTH = 0.007; // metres of relief encoded in height 0 … 1

/** Texture size for a quality preset: pot(1024 × tex), 512 … 2048. */
export function floorTextureSize(q = {}) {
  const tier = q.tier ?? 'medium';
  const tex = q.tex ?? (tier === 'high' || tier === 'ultra' ? 2 : 1);
  const pot = Math.pow(2, Math.round(Math.log2(1024 * tex)));
  return Math.min(2048, Math.max(512, pot));
}

const TILE = FLOOR_MAP.tileA * 1000; // mm per tile
const DEPTH = FLOOR_DEPTH * 1000; // mm of relief for height 1
const f = (x) => x.toFixed(5);

// ── the layout: every element on the tile ───────────────────

// A smooth random field that tiles: a few waves with whole-number frequencies (≈ unit variance).
function tileField(rng, n, kMin, kMax) {
  const waves = [];
  while (waves.length < n) {
    const m = Math.round((rng() * 2 - 1) * kMax);
    const k = Math.round((rng() * 2 - 1) * kMax);
    const r = Math.hypot(m, k);
    if (r >= kMin && r <= kMax) waves.push([m, k, rng() * Math.PI * 2]);
  }
  const norm = 1 / Math.sqrt(n / 2);
  return (u, v) => {
    let s = 0;
    for (const [m, k, p] of waves) s += Math.cos(Math.PI * 2 * (m * u + k * v) + p);
    return s * norm;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// needle layers: decayed fragments, weathered needles, this year's fall on top
export const NEEDLE_LAYERS = [
  { cells: 34 * 34, per: 5, len: [5, 26], z: [0.5, 2.0], width: 1.25, pair: 0.0, fungus: 0 },
  { cells: 18 * 18, per: 10, len: [34, 62], z: [1.5, 3.6], width: 1.55, pair: 0.22, fungus: 0.26 },
  { cells: 18 * 18, per: 3, len: [38, 64], z: [3.3, 4.7], width: 1.65, pair: 0.45, fungus: 0.1 },
];
export const DEBRIS = { twigs: 65, flakes: 96, leaves: 18, lichens: 20, gritCells: 512 * 512 };

/**
 * Every element of the tile, per kind: { a0, a1, a2, a3: Float32Array (4 per instance), count }.
 *   a0 = centre u, v (tile units, copies across the edges shifted by ±1) and unit direction
 *   a3 = half extents of its quad along / across (mm), seed, kind
 *   a1, a2 = per-kind shape and look (see the shaders below)
 * Pure JS and deterministic, so the CPU preview draws exactly the same floor.
 */
export function floorElements(seed = 2718) {
  const rng = mulberry32(seed);
  const out = {};
  const list = (name) => (out[name] ??= { data: [], count: 0 });
  const emit = (name, cx, cy, dx, dy, a1, a2, bx, by, kind) => {
    const L = list(name);
    const r = Math.hypot(bx, by) / TILE;
    const sd = rng() * 512;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x = cx + ox;
        const y = cy + oy;
        if (x - r >= 1 || x + r <= 0 || y - r >= 1 || y + r <= 0) continue;
        L.data.push(x, y, dx, dy, ...a1, ...a2, bx, by, sd, kind);
        L.count++;
      }
    }
  };

  NEEDLE_LAYERS.forEach((P, layer) => {
    const dens = tileField(rng, 6, 3, 5);
    const n = P.cells * P.per;
    for (let i = 0; i < n; i++) {
      const u = rng();
      const v = rng();
      const keep = rng() < Math.min(1, Math.max(0.15, 0.72 + 0.22 * dens(u, v)));
      const len = lerp(P.len[0], P.len[1], rng());
      const ang = rng() * Math.PI * 2;
      const pair = rng() < P.pair;
      const width = P.width * (0.85 + 0.3 * rng());
      const curv = (rng() - 0.5) * 0.15 * len;
      const tilt = (rng() - 0.5) * 1.2;
      const z = lerp(P.z[0], P.z[1], rng());
      const age = rng();
      const tone = rng();
      const fungus = layer > 0 && age > 0.3 && rng() < P.fungus ? lerp(3, 12, rng()) : 0;
      const spread = (0.05 + 0.28 * rng()) * (rng() < 0.5 ? -1 : 1);
      if (!keep) continue;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const bx = len / 2 + 0.4;
      const by = width / 2 + Math.abs(curv) + 0.4;
      emit('needle', u, v, dx, dy, [len, width, z, tilt], [curv, age, tone, fungus], bx, by, layer + (pair ? 4 : 0));
      if (pair) {
        // the second needle of the fascicle grows from the same base, a little apart
        const bu = u - (dx * len) / 2 / TILE;
        const bv = v - (dy * len) / 2 / TILE;
        const ex = dx * Math.cos(spread) - dy * Math.sin(spread);
        const ey = dx * Math.sin(spread) + dy * Math.cos(spread);
        emit('needle', bu + (ex * len) / 2 / TILE, bv + (ey * len) / 2 / TILE, ex, ey, [len, width, z + 0.12, tilt], [curv, age, tone, fungus], bx, by, layer + 4);
      }
    }
  });

  for (let i = 0; i < DEBRIS.twigs; i++) {
    const len = lerp(12, 46, rng());
    const rad = lerp(0.6, 1.6, rng());
    const bend = (rng() - 0.5) * 0.12 * len;
    const a = rng() * Math.PI * 2;
    emit('twig', rng(), rng(), Math.cos(a), Math.sin(a), [len, rad, 2.2 + 1.6 * rng(), rng() - 0.5], [bend, rng() < 0.6 ? 1 : 0, rng(), 0], len / 2 + 0.4, rad + Math.abs(bend) + 0.4, 10);
  }
  for (let i = 0; i < DEBRIS.flakes; i++) {
    const k = rng();
    const kind = k < 0.55 ? 0 : k < 0.9 ? 1 : 2; // thick grey plate, papery orange flake, cone scale
    const a = rng() * Math.PI * 2;
    const r = [rng(), rng(), rng()];
    if (kind < 2) {
      const R = lerp(2.5, 8, r[1] * r[1]);
      const st = lerp(1, 1.6, r[2]);
      const th = kind === 1 ? lerp(0.15, 0.3, rng()) : lerp(0.7, 1.5, rng());
      emit('flake', rng(), rng(), Math.cos(a), Math.sin(a), [R, st, 1.4 + 2.6 * rng(), th], [...r, kind], R * st * 1.45, R * 1.45, 20 + kind);
    } else {
      const R = lerp(5, 7, r[1]);
      emit('flake', rng(), rng(), Math.cos(a), Math.sin(a), [R, 1, 1.6 + 2.0 * rng(), 0], [...r, kind], R * 1.1 + 0.4, R * 0.75 + 0.4, 22);
    }
  }
  for (let i = 0; i < DEBRIS.leaves; i++) {
    const L = lerp(28, 52, rng());
    const a = rng() * Math.PI * 2;
    emit('leaf', rng(), rng(), Math.cos(a), Math.sin(a), [L, 1.0 + 2.3 * rng(), rng() * 0.85, 0.9 * rng()], [rng(), rng(), rng(), 0], L * 0.65 + 0.4, L * 0.36 + 0.4, 30);
  }
  for (let i = 0; i < DEBRIS.lichens; i++) {
    const R = lerp(2.5, 6, rng());
    const a = rng() * Math.PI * 2;
    emit('lichen', rng(), rng(), Math.cos(a), Math.sin(a), [R, Math.floor(lerp(5, 9, rng())), 2.4 + 1.8 * rng(), rng()], [rng() * 7, 0, 0, 0], R * 1.35, R * 1.35, 40);
  }
  // sand grains, dark grit and pale lichen specks, more of them in a few patches
  const patch = tileField(rng, 6, 7, 11);
  const gc = Math.sqrt(DEBRIS.gritCells);
  const cand = Math.round(DEBRIS.gritCells * 0.175);
  for (let i = 0; i < cand; i++) {
    const u = rng();
    const v = rng();
    const p = (0.015 + 0.16 * smooth(0.1, 0.5, 0.35 * patch(u, v))) / 0.175;
    const rad = lerp(0.12, 0.3, rng()) * (TILE / gc);
    const z = 0.55 + 0.4 * rng();
    const k = rng();
    if (rng() >= p) continue;
    emit('grit', u, v, 1, 0, [rad, z, k < 0.5 ? 0 : k < 0.7 ? 1 : k < 0.85 ? 2 : 3, 0], [0, 0, 0, 0], rad + 0.3, rad + 0.3, 50);
  }

  for (const L of Object.values(out)) {
    const d = new Float32Array(L.data);
    const n = L.count;
    L.a0 = new Float32Array(n * 4);
    L.a1 = new Float32Array(n * 4);
    L.a2 = new Float32Array(n * 4);
    L.a3 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        L.a0[i * 4 + c] = d[i * 16 + c];
        L.a1[i * 4 + c] = d[i * 16 + 4 + c];
        L.a2[i * 4 + c] = d[i * 16 + 8 + c];
        L.a3[i * 4 + c] = d[i * 16 + 12 + c];
      }
    }
    delete L.data;
  }
  return out;
}

// ── shaders ─────────────────────────────────────────────────

const FULL_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// each element: a quad around it in its own frame (mm), placed on the tile
const SPLAT_VERT = /* glsl */ `
attribute vec4 a0;
attribute vec4 a1;
attribute vec4 a2;
attribute vec4 a3;
varying vec2 vL;
varying vec4 vA1;
varying vec4 vA2;
varying vec2 vS;
void main() {
  vec2 L = position.xy * a3.xy;
  vec2 uv = a0.xy + (a0.zw * L.x + vec2(-a0.w, a0.z) * L.y) / ${f(TILE)};
  vL = L;
  vA1 = a1;
  vA2 = a2;
  vS = a3.zw;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

// shared by every splat: write the height as depth (the highest wins), then colour or masks
const SPLAT_COMMON = /* glsl */ `
uniform int uMode; // 0: albedo + roughness, 1: lies-on-moss mask + wetness
uniform float uTexel; // mm per texel of the target being drawn
// a thin feature w mm wide, drawn on texels of uTexel mm: widened to at least a texel, faded by how much of
// it there really is (a pre-filtered stroke, so nothing thin aliases into rows of dots) → (width, coverage)
vec2 prefilter(float w) {
  float we = max(w, uTexel * 1.25);
  return vec2(we, w / we);
}
float vnoise1(float x, float seed) {
  float i = floor(x), t = fract(x);
  return mix(hash12(vec2(i, seed)), hash12(vec2(i + 1.0, seed)), t * t * (3.0 - 2.0 * t));
}
float vnoise2(vec2 p) {
  vec2 i = floor(p), t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), t.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), t.x), t.y);
}
void emit(float top, vec3 col, float rough, float wet, float cover) {
  gl_FragDepth = 1.0 - clamp(top / ${f(DEPTH)}, 0.0, 1.0) * 0.999;
  gl_FragColor = uMode == 0 ? vec4(pow(clamp(col, 0.0, 1.0), vec3(2.2)), rough) : vec4(cover, wet, 0.0, 1.0);
}`;

const SPLAT_PARS = /* glsl */ `
varying vec2 vL; // mm in the element's frame: along, across
varying vec4 vA1;
varying vec4 vA2;
varying vec2 vS; // seed, kind`;

// a1 = (length, width, resting height, tilt), a2 = (curve, age, tone, fungus spacing); kind = layer + 4 if paired
const NEEDLE = /* glsl */ `
void main() {
  float len = vA1.x;
  float s = vL.x / len + 0.5; // 0 at the base … 1 at the tip
  if (s < 0.0 || s > 1.0) discard;
  float d = vL.y - vA2.x * 4.0 * s * (1.0 - s);
  // on coarse texels a needle is a wider, fainter, flatter stroke of its own tone
  vec2 pf = prefilter(vA1.y * (1.0 - 0.8 * smoothstep(0.72, 1.0, s)));
  float hw = pf.x * 0.5;
  float ad = abs(d);
  if (ad >= hw) discard;
  float rr = ad / hw;
  float sMM = s * len;
  float top = vA1.z + vA1.w * (s - 0.5) + sqrt(1.0 - rr * rr) * hw * 0.72 * pf.y;
  float layer = floor(mod(vS.y + 0.5, 4.0));
  bool pair = vS.y > 3.5;
  float a = vA2.y, t = vA2.z, seed = vS.x;
  vec3 col;
  float rough, wet, cover;
  if (layer < 0.5) {
    col = mix(vec3(0.19, 0.125, 0.08), vec3(0.33, 0.215, 0.13), a);
    rough = 0.86; wet = 0.85; cover = 0.0;
  } else if (layer < 1.5) {
    // weathered: from warm brown through grey-brown to bleached grey, a few dark old ones
    col = mix(vec3(0.50, 0.34, 0.21), vec3(0.47, 0.41, 0.35), smoothstep(0.15, 0.6, a));
    col = mix(col, vec3(0.60, 0.57, 0.52), smoothstep(0.7, 0.95, a) * 0.8);
    col = mix(col, vec3(0.28, 0.20, 0.14), step(0.88, t));
    col *= 0.82 + 0.3 * t;
    rough = 0.78; wet = 0.5; cover = step(0.62, hash12(vec2(seed, 6.6)));
  } else {
    // on top: this year's fall, russet, among older grey-brown ones
    bool fresh = a < 0.3;
    col = fresh ? mix(vec3(0.66, 0.40, 0.20), vec3(0.74, 0.50, 0.27), t) : mix(vec3(0.55, 0.38, 0.24), vec3(0.56, 0.50, 0.43), smoothstep(0.4, 0.9, a)) * (0.85 + 0.25 * t);
    rough = fresh ? 0.55 : 0.7; wet = fresh ? 0.15 : 0.3; cover = 1.0;
  }
  // mottled along its length, a darker tip, the grey sheath that holds a pair together
  col *= 0.86 + 0.28 * vnoise1(sMM * 0.35, seed);
  col *= mix(1.0, 0.72, smoothstep(0.86, 1.0, s));
  if (pair && sMM < 3.5) col = mix(col, vec3(0.25, 0.21, 0.18), 0.85);
  // rounded back: darker toward the edges, faint pale stomatal lines
  col *= mix(1.0, (0.8 + 0.2 * sqrt(1.0 - rr * rr)) * (0.96 + 0.04 * cos(rr * 9.0)), pf.y);
  // needle-cast fungus on older needles: thin black zone lines and tiny black fruit bodies (pre-filtered too)
  if (vA2.w > 0.0) {
    float sp = vA2.w;
    float zl = abs(fract(sMM / sp + hash12(vec2(seed, 3.3))) - 0.5) * sp;
    vec2 lp = prefilter(0.22);
    float line = (1.0 - smoothstep(lp.x * 0.27, lp.x * 0.73, zl)) * lp.y * step(0.35, vnoise1(sMM / sp, seed * 3.1));
    float ax = sMM / 1.9;
    float hasA = step(hash12(vec2(floor(ax), seed)), 0.28);
    vec2 ap = prefilter(0.84);
    float apd = length(vec2((fract(ax) - 0.5) * 1.9 / (ap.x * 0.5), rr / 0.55));
    float apo = hasA * (1.0 - smoothstep(0.7, 1.0, apd)) * ap.y;
    col = mix(col, vec3(0.045, 0.04, 0.035), max(line * 0.9, apo) * pf.y);
    top += apo * 0.07;
  }
  // a widened needle shows only as much of itself as there is: blend toward the duff it lies on
  col = mix(vec3(0.15, 0.105, 0.07), col, pf.y);
  emit(top, col, rough, wet, cover);
}`;

// a1 = (length, radius, resting height, tilt), a2 = (bend, lichen crust, tone, -)
const TWIG = /* glsl */ `
void main() {
  float len = vA1.x;
  float s = vL.x / len + 0.5;
  if (s < 0.0 || s > 1.0) discard;
  float rw = vA1.y * (1.0 - 0.25 * s);
  float d = vL.y - vA2.x * 4.0 * s * (1.0 - s);
  if (abs(d) >= rw) discard;
  float rr = d / rw;
  float cyl = sqrt(1.0 - rr * rr);
  float sMM = s * len;
  float seed = vS.x;
  vec3 col = mix(vec3(0.33, 0.28, 0.24), vec3(0.45, 0.38, 0.31), vA2.z);
  col *= 0.85 + 0.3 * vnoise1(sMM * 0.8, seed);
  col *= 1.0 - 0.4 * smoothstep(0.85, 1.0, vnoise1(sMM * 0.45, seed + 3.0)); // bud-scale rings
  float lc = smoothstep(0.55, 0.75, vnoise1(sMM * 0.3, seed + 9.0) * (0.6 + 0.4 * cyl));
  col = mix(col, vec3(0.62, 0.66, 0.56), lc * vA2.y); // lichen crust
  col = mix(col, vec3(0.66, 0.56, 0.42), (1.0 - smoothstep(0.4, 1.2, min(sMM, len - sMM))) * 0.85); // broken ends
  emit(vA1.z + vA1.w * (s - 0.5) + cyl * rw, col * (0.78 + 0.22 * cyl), 0.82, 0.4, 1.0);
}`;

// a1 = (size, stretch, resting height, thickness), a2 = (three shape seeds, kind: 0 plate, 1 papery flake, 2 cone scale)
const FLAKE = /* glsl */ `
void main() {
  float R = vA1.x;
  float seed = vS.x;
  if (vA2.w < 1.5) {
    vec2 e = vL / vec2(R * vA1.y, R);
    float rad2 = dot(e, e);
    if (rad2 > 1.9) discard;
    float a = atan(e.y, e.x);
    float edge = 1.0 + 0.2 * sin(3.0 * a + vA2.x * 20.0) + 0.12 * sin(5.0 * a + vA2.z * 31.0) + 0.07 * sin(8.0 * a + vA2.y * 13.0);
    float dd = sqrt(rad2) / edge;
    if (dd >= 1.0) discard;
    bool paper = vA2.w > 0.5;
    float curl = paper ? 0.9 * max(e.x, 0.0) * max(e.x, 0.0) : 0.0; // papery flakes curl up at one side
    float top = vA1.z + vA1.w * (paper ? 1.0 : 1.0 - smoothstep(0.75, 1.0, dd)) + curl;
    float tone = hash12(vec2(seed, 7.7));
    vec3 col;
    if (paper) {
      col = mix(vec3(0.66, 0.38, 0.21), vec3(0.78, 0.52, 0.32), tone);
      col *= 0.84 + 0.26 * vnoise2(vec2(e.x * 2.5, e.y * 8.0) + seed); // thin streaky layers
      col = mix(col, vec3(0.45, 0.24, 0.13), smoothstep(0.82, 1.0, dd) * 0.6);
    } else {
      col = mix(vec3(0.34, 0.27, 0.23), vec3(0.46, 0.38, 0.32), tone);
      float strata = abs(fract((e.x * 0.7 + e.y * 0.3) * 4.0 + vA2.z * 3.0) - 0.5);
      col *= 0.85 + 0.25 * smoothstep(0.1, 0.4, strata);
      col = mix(col, vec3(0.55, 0.30, 0.17), smoothstep(0.78, 1.0, dd) * 0.8); // reddish broken rim
    }
    emit(top, col, paper ? 0.6 : 0.88, 0.35, 1.0);
  } else {
    // a cone scale a squirrel dropped: woody wedge, a grey diamond with a dark boss at its tip
    vec2 c = vL / vec2(R * 1.1, R * 0.75);
    if (abs(c.x) > 1.0) discard;
    float wx = mix(0.3, 1.0, smoothstep(-1.0, 0.45, c.x)) * (1.0 - 0.5 * smoothstep(0.75, 1.0, c.x));
    if (abs(c.y) >= wx) discard;
    float across = 1.0 - abs(c.y) / wx;
    float apo = smoothstep(0.45, 0.6, c.x + abs(c.y) * 0.3);
    vec3 col = mix(vec3(0.45, 0.27, 0.14), vec3(0.52, 0.45, 0.37), apo);
    col = mix(col, vec3(0.16, 0.12, 0.09), 1.0 - smoothstep(0.08, 0.16, length(vec2(c.x - 0.78, c.y * 1.4))));
    emit(vA1.z + 0.8 + 0.7 * apo * across, col * (0.85 + 0.15 * across), 0.72, 0.3, 1.0);
  }
}`;

// a1 = (length, resting height, decay, margin curl), a2 = (vein phase, vein tone, blade tone, -)
const LEAF = /* glsl */ `
vec2 worley(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + 0.05 + 0.9 * hash22(ip + g) - fp;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return sqrt(vec2(f1, f2));
}
void main() {
  float L = vA1.x;
  float x = vL.x / L + 0.5; // 0 at the petiole … 1 at the tip
  if (x < -0.15 || x > 1.0) discard;
  float ay = abs(vL.y) / L;
  // rhombic-ovate birch blade with a drawn-out tip and a double-serrate margin
  float hw = 0.34 * pow(sin(3.14159 * pow(clamp(x, 0.0, 1.0), 0.62)), 0.85) * (1.0 - 0.1 * x);
  hw *= 1.0 - 0.07 * abs(fract(x * 26.0) - 0.5) * 2.0 - 0.03 * abs(fract(x * 52.0 + 0.3) - 0.5) * 2.0;
  bool blade = x >= 0.0 && ay < hw;
  bool petiole = x < 0.0 && ay * L < 0.4;
  if (!blade && !petiole) discard;
  float edgeT = blade ? ay / max(hw, 1e-3) : 0.0;
  float yMM = ay * L;
  vec2 mp = prefilter(0.85), vp = prefilter(0.45), tp = prefilter(0.28); // midrib, side veins, the fine net
  float midrib = (1.0 - smoothstep(0.3, 0.55, yMM / (1.0 - 0.6 * clamp(x, 0.0, 1.0)) / (mp.x / 0.85))) * mp.y;
  float vsd = abs(fract((x - ay * 1.25) * 8.5 + vA2.x) - 0.5) / (8.5 * 1.6) * L; // mm to a side vein
  float sec = (1.0 - smoothstep(0.15, 0.3, vsd / (vp.x / 0.45))) * vp.y * step(0.04, x) * step(edgeT, 0.96);
  vec2 net = worley(vL * 0.5 + vS.x * 7.0); // the fine net between them (≈ 2 mm)
  float tert = (1.0 - smoothstep(0.05, 0.14, (net.y - net.x) / (tp.x / 0.28))) * tp.y;
  float margin = smoothstep(0.86, 0.96, edgeT); // the rim outlasts the blade
  float veins = petiole ? 1.0 : max(max(midrib, sec * 0.9), max(tert * 0.65, margin * 0.8));
  float lam = smoothstep(vA1.z * 0.9, vA1.z * 0.9 + 0.12, vnoise2(vL * 0.3 + vS.x * 3.0) * 0.7 + 0.3 * (1.0 - edgeT));
  if (veins < 0.3 && lam < 0.5) discard; // a hole: what lies below shows through
  vec3 veinC = mix(vec3(0.62, 0.50, 0.33), vec3(0.45, 0.34, 0.22), vA2.y);
  vec3 lamC = mix(vec3(0.36, 0.22, 0.11), vec3(0.24, 0.15, 0.09), vA2.z);
  emit(vA1.y + vA1.w * edgeT * edgeT + 0.12 + 0.15 * veins, mix(lamC, veinC, smoothstep(0.3, 0.7, veins)), 0.75, 0.6, 1.0);
}`;

// a1 = (size, lobes, resting height, tone), a2 = (lobe phase, -, -, -): Hypogymnia blown down from the branches
const LICHEN = /* glsl */ `
void main() {
  float R = vA1.x;
  float rad = length(vL);
  if (rad > R * 1.3) discard;
  float a = atan(vL.y, vL.x);
  float lobe = sqrt(abs(sin(a * vA1.y * 0.5 + vA2.x))); // broad round lobes, narrow notches
  float rim = R * (0.6 + 0.4 * lobe) * (0.85 + 0.3 * vnoise2(vec2(cos(a), sin(a)) * 2.0 + vS.x));
  if (rad >= rim) discard;
  float t = rad / rim;
  vec3 col = mix(vec3(0.50, 0.56, 0.47), vec3(0.62, 0.66, 0.56), vA1.w) * (0.85 + 0.2 * lobe);
  col = mix(col, vec3(0.42, 0.38, 0.30), smoothstep(0.6, 0.95, t) * 0.35);
  col = mix(col, vec3(0.12, 0.11, 0.10), smoothstep(0.86, 0.98, t)); // black underside at the rim
  emit(vA1.z + 0.35 + 0.35 * sqrt(max(1.0 - t * t, 0.0)) + 0.15 * lobe, col, 0.85, 0.7, 1.0);
}`;

// a1 = (radius, resting height, kind: quartz, feldspar, dark grit, lichen speck, -)
const GRIT = /* glsl */ `
void main() {
  vec2 gp = prefilter(vA1.x * 2.0);
  float d = length(vL) / (gp.x * 0.5);
  if (d >= 1.0) discard;
  float dome = sqrt(1.0 - d * d);
  float k = vA1.z;
  vec3 col = k < 0.5 ? vec3(0.78, 0.76, 0.70) : (k < 1.5 ? vec3(0.72, 0.58, 0.50) : (k < 2.5 ? vec3(0.18, 0.18, 0.19) : vec3(0.66, 0.70, 0.60)));
  col = mix(vec3(0.12, 0.09, 0.06), col * (0.8 + 0.2 * dome), gp.y * gp.y);
  emit(vA1.y + vA1.x * 0.8 * dome * gp.y, col, mix(0.9, k < 0.5 ? 0.35 : 0.8, gp.y), 0.2, 0.0);
}`;

// the dark duff under everything: crumbs and clods, reddish fragments, moss haze, white mycelium
const HUMUS = /* glsl */ `
uniform vec2 uRes;
float fbm2o(vec2 p, vec2 rep) { return (pnoise(p, rep) + 0.5 * pnoise(p * 2.0, rep * 2.0)) / 1.5; }
float fbm3o(vec2 p, vec2 rep) { return (pnoise(p, rep) + 0.5 * pnoise(p * 2.0, rep * 2.0) + 0.25 * pnoise(p * 4.0, rep * 4.0)) / 1.75; }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c1 = pworley(uv * 420.0, vec2(420.0), 0.9); // ≈ 1.6 mm crumbs
  vec3 c2 = pworley(uv * 150.0 + 0.5, vec2(150.0), 0.95); // ≈ 4.5 mm clods
  float crumb = 1.0 - smoothstep(0.05, 0.75, c1.x);
  float clod = 1.0 - smoothstep(0.1, 0.95, c2.x);
  float n = fbm3o(uv * 20.0 + 5.1, vec2(20.0));
  float n2 = fbm2o(uv * 90.0 + 1.7, vec2(90.0));
  float h = 0.2 + 0.45 * clod + 0.3 * crumb * (0.5 + 0.5 * c1.z) + 0.12 * n2;
  vec3 col = mix(vec3(0.07, 0.05, 0.036), vec3(0.16, 0.11, 0.07), smoothstep(-0.45, 0.45, n));
  col = mix(col, vec3(0.30, 0.17, 0.09), crumb * step(0.72, c1.z) * 0.7);
  col *= 0.7 + 0.5 * crumb * (0.6 + 0.4 * c2.z);
  float gr = smoothstep(0.18, 0.42, fbm2o(uv * 7.0 + 9.3, vec2(7.0)));
  col = mix(col, vec3(0.16, 0.20, 0.06), gr * 0.45 * (0.5 + 0.5 * clod));
  float myc = smoothstep(0.22, 0.5, fbm3o(uv * 5.0 + 2.3, vec2(5.0)));
  if (myc > 0.0) {
    float t1 = abs(pnoise(uv * 170.0 + n * 2.0, vec2(170.0)));
    float t2 = abs(pnoise(uv * 240.0 + 11.0 + n2 * 1.5, vec2(240.0)));
    vec2 w1 = prefilter(0.3), w2 = prefilter(0.2);
    float line = (1.0 - smoothstep(0.0, 0.07 * w1.x / 0.3, t1)) * 0.75 * w1.y + (1.0 - smoothstep(0.0, 0.05 * w2.x / 0.2, t2)) * 0.5 * w2.y;
    float m = clamp(line * myc, 0.0, 0.85);
    col = mix(col, vec3(0.80, 0.78, 0.72), m);
    h += m * 0.1;
  }
  emit(h, col, 0.93, 0.95, 0.0);
}`;

// ── the passes that read the height field (the splat depth buffer, at hi-res) ──
const DERIVE_PARS = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uHi; // hi-res size
uniform float uSS; // hi-res texels per output texel (1 or 2)
float hAt(vec2 c) {
  return (1.0 - texelFetch(tDepth, ivec2(mod(floor(c), uHi)), 0).r) / 0.999 * ${f(DEPTH)};
}
// the height over one output texel
float hOut(vec2 c) {
  float h = 0.0;
  if (uSS < 1.5) h = hAt(c);
  else h = 0.25 * (hAt(c + vec2(-0.5, -0.5)) + hAt(c + vec2(0.5, -0.5)) + hAt(c + vec2(-0.5, 0.5)) + hAt(c + vec2(0.5, 0.5)));
  return h;
}`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uRes;
void main() { gl_FragColor = texture2D(tSrc, gl_FragCoord.xy / uRes); }`;

const NORMAL_AO = /* glsl */ `
void main() {
  vec2 P = gl_FragCoord.xy * uSS; // this output texel's centre, in hi-res texels
  float tx = ${f(TILE)} / uHi.x; // mm per hi-res texel
  float o = uSS;
  float h00 = hOut(P + vec2(-o, -o)), h10 = hOut(P + vec2(0.0, -o)), h20 = hOut(P + vec2(o, -o));
  float h01 = hOut(P + vec2(-o, 0.0)), h11 = hOut(P), h21 = hOut(P + vec2(o, 0.0));
  float h02 = hOut(P + vec2(-o, o)), h12 = hOut(P + vec2(0.0, o)), h22 = hOut(P + vec2(o, o));
  vec2 sl = -vec2((h20 + 2.0 * h21 + h22) - (h00 + 2.0 * h01 + h02), (h02 + 2.0 * h12 + h22) - (h00 + 2.0 * h10 + h20)) / (8.0 * tx * o);
  float sm = length(sl);
  if (sm > 2.5) sl *= 2.5 / sm;
  vec3 n = normalize(vec3(sl, 1.0));
  // horizon-based occlusion: 8 directions × 3 radii (0.6, 1.4, 3.5 mm)
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = (float(i) + 0.5) * 0.7853982;
    vec2 dir = vec2(cos(a), sin(a));
    float mx = 0.0;
    for (int k = 0; k < 3; k++) {
      float rmm = 0.6 * pow(2.4, float(k));
      mx = max(mx, (hOut(P + dir * (rmm / tx)) - h11) / rmm);
    }
    occ += mx * inversesqrt(1.0 + mx * mx);
  }
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, h11 / ${f(DEPTH)}, clamp(1.0 - occ / 8.0 * 1.1, 0.0, 1.0));
}`;

const SUN = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uSunA; // toward the sun in texture space, sample A
uniform vec2 uSunB; // … and in sample B's rotated frame
uniform float uSunTan; // tan(sun elevation)
void main() {
  // needle-on-needle sun shadows: march toward the sun through the height field, both sample frames
  vec2 P = gl_FragCoord.xy * uSS;
  float tx = ${f(TILE)} / uHi.x;
  float h0 = hOut(P);
  float stepMM = max(tx, 0.4);
  float vA = 1.0, vB = 1.0;
  for (int k = 1; k <= 22; k++) {
    float s = float(k) * stepMM;
    if (s > 8.5) break;
    float ray = h0 + s * uSunTan;
    float soft = 0.14 + 0.03 * s + 0.35 * tx * uSS;
    vA = min(vA, clamp((ray - hOut(P + uSunA * (s / tx))) / soft + 0.5, 0.0, 1.0));
    vB = min(vB, clamp((ray - hOut(P + uSunB * (s / tx))) / soft + 0.5, 0.0, 1.0));
  }
  // the masks were drawn at hi-res like the colour: one bilinear tap at the output texel's centre averages
  // its 2 × 2 hi-res texels, so needle outlines stay as soft as the albedo's
  vec4 m = texture2D(tMask, gl_FragCoord.xy * uSS / uHi);
  gl_FragColor = vec4(vA, vB, m.r, m.g);
}`;

/** All bake programs' fragment sources (for inspection / tests). */
export function floorBakeShaders() {
  const splat = (body, periodic = false) => HASH_GLSL + (periodic ? PERIODIC_GLSL : '') + SPLAT_COMMON + SPLAT_PARS + body;
  return {
    humus: HASH_GLSL + PERIODIC_GLSL + SPLAT_COMMON + HUMUS,
    needle: splat(NEEDLE),
    twig: splat(TWIG),
    flake: splat(FLAKE),
    leaf: splat(LEAF),
    lichen: splat(LICHEN),
    grit: splat(GRIT),
    down: DOWN,
    normal: DERIVE_PARS + NORMAL_AO,
    sun: DERIVE_PARS + SUN,
    splatVertex: SPLAT_VERT,
    fullVertex: FULL_VERT,
  };
}

/**
 * Bake the close-up textures on the GPU. Resolves to { albedo, normal, extra, size, ok, dispose() } —
 * ok is false if the bake came out empty. Sizes ≤ 1024 are drawn at twice the size and filtered down.
 */
export async function bakeFloorTextures(renderer, { size = 1024, anisotropy = 8 } = {}) {
  const ss = size <= 1024 ? 2 : 1;
  const hi = size * ss;
  const src = floorBakeShaders();
  const els = floorElements();
  const uMode = { value: 0 };
  const uTexel = { value: TILE / hi };
  const uRes = { value: new THREE.Vector2(hi, hi) };
  const disposables = [];
  const material = (fragmentShader, uniforms, vertexShader = FULL_VERT, extra = {}) => {
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, ...extra });
    disposables.push(m);
    return m;
  };
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // the splat scene: humus under everything, then one instanced draw per kind of element
  const splats = new THREE.Scene();
  const humus = new THREE.Mesh(fullscreenTriangle(), material(src.humus, { uMode, uRes, uTexel }));
  humus.frustumCulled = false;
  splats.add(humus);
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  disposables.push(quad);
  for (const kind of ['needle', 'twig', 'flake', 'leaf', 'lichen', 'grit']) {
    const e = els[kind];
    if (!e || !e.count) continue;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', quad.getAttribute('position'));
    g.setIndex(quad.getIndex());
    for (const a of ['a0', 'a1', 'a2', 'a3']) g.setAttribute(a, new THREE.InstancedBufferAttribute(e[a], 4));
    g.instanceCount = e.count;
    disposables.push(g);
    const m = new THREE.Mesh(g, material(src[kind], { uMode, uTexel }, SPLAT_VERT, { side: THREE.DoubleSide }));
    m.frustumCulled = false;
    splats.add(m);
  }

  const sun = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z);
  const sunTan = SUN_DIR.y / sun.length();
  sun.normalize();
  const c = Math.cos(FLOOR_MAP.rotB);
  const s = Math.sin(FLOOR_MAP.rotB);
  const aniso = Math.max(1, Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()));
  const target = (w, { srgb = false, mips = false, linear = false, depth = false } = {}) => {
    const rt = new THREE.WebGLRenderTarget(w, w, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : linear ? THREE.LinearFilter : THREE.NearestFilter,
      magFilter: mips || linear ? THREE.LinearFilter : THREE.NearestFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: mips ? aniso : 1,
      depthBuffer: depth,
    });
    if (depth === 'texture') rt.depthTexture = new THREE.DepthTexture(w, w, THREE.UnsignedIntType);
    return rt;
  };
  const colourHi = target(hi, { srgb: true, linear: true, depth: 'texture' });
  const masks = target(hi, { linear: true, depth: true }); // at hi-res too: soft outlines, filtered down in the sun pass
  const albedo = target(size, { srgb: true, mips: true });
  const normal = target(size, { mips: true });
  const extra = target(size, { mips: true });

  const derive = (frag, uniforms) => {
    const sc = new THREE.Scene();
    const m = new THREE.Mesh(fullscreenTriangle(), material(frag, uniforms));
    m.frustumCulled = false;
    sc.add(m);
    return sc;
  };
  const hiU = { value: new THREE.Vector2(hi, hi) };
  const ssU = { value: ss };
  const depthU = { value: colourHi.depthTexture };
  const down = derive(src.down, { tSrc: { value: colourHi.texture }, uRes: { value: new THREE.Vector2(size, size) } });
  const nrm = derive(src.normal, { tDepth: depthU, uHi: hiU, uSS: ssU });
  const shade = derive(src.sun, {
    tDepth: depthU,
    uHi: hiU,
    uSS: ssU,
    tMask: { value: masks.texture },
    uSunA: { value: sun.clone() },
    uSunB: { value: new THREE.Vector2(c * sun.x - s * sun.y, s * sun.x + c * sun.y) },
    uSunTan: { value: sunTan },
  });

  // compile everything off the main thread where the browser can (KHR_parallel_shader_compile)
  try {
    await Promise.all([splats, down, nrm, shade].map((sc) => renderer.compileAsync?.(sc, camera)));
  } catch {
    /* only an optimisation */
  }

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  const draw = (scene, rt, clear = false) => {
    renderer.setRenderTarget(rt);
    if (clear) renderer.clear(true, true, false);
    renderer.render(scene, camera);
  };
  let ok = true;
  try {
    uMode.value = 0;
    uRes.value.set(hi, hi);
    uTexel.value = TILE / hi;
    draw(splats, colourHi, true);
    uMode.value = 1;
    uRes.value.set(hi, hi);
    uTexel.value = TILE / hi;
    draw(splats, masks, true);
    draw(down, albedo);
    draw(nrm, normal);
    draw(shade, extra);
    // a failed bake (shader error, lost context) leaves the targets empty: roughness is never below 0.3
    const px = new Uint8Array(4);
    renderer.readRenderTargetPixels(albedo, size >> 1, size >> 1, 1, 1, px);
    ok = px[3] > 40;
    // … and a program that failed to compile would leave its elements out: three's diagnostics tell
    const broken = disposables.filter((m) => m.isShaderMaterial && renderer.properties?.get?.(m)?.currentProgram?.diagnostics?.runnable === false);
    if (broken.length) {
      console.warn(`[flyover] floor bake: ${broken.length} shader(s) failed to compile`);
      ok = false;
    }
  } catch (err) {
    console.warn('[flyover] floor bake failed', err);
    ok = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  colourHi.depthTexture.dispose();
  colourHi.dispose();
  masks.dispose();
  for (const d of disposables) d.dispose();
  return {
    albedo: albedo.texture,
    normal: normal.texture,
    extra: extra.texture,
    size,
    ok,
    dispose() {
      albedo.dispose();
      normal.dispose();
      extra.dispose();
    },
  };
}
