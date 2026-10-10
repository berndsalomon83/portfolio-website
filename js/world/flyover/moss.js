import * as THREE from 'three';
import { PATCH, SPOTS, ANT_TRAIL, fromPatch, toPatch, heroHeightAt, heroNormalAt, microRelief, phenology } from './config.js';
import { RNG, noise2, fbm2, smoothstep, clamp } from '../../lib/random.js';
import { MeshData, addTube } from '../../lib/geometry.js';
import { injectFoliage, injectSeason } from '../../gl/patches.js';
import { HASH_GLSL } from '../../gl/noise.glsl.js';

// Moss carpets and lichens for the flyover close-up (camera 0.85 m above the floor, ~0.5 mm per pixel).
//
//  · Feather-moss carpet: a stack of shells over the moss areas. Every shell draws its own field of lying
//    shoots, bombed from a CPU-rasterised atlas of real frond shapes (Pleurozium, Hylocomium, Dicranum),
//    so looking down you see shoots over shoots, darker and browner with depth, with true parallax.
//  · On top, instanced 3D fronds and Dicranum tufts give silhouettes, ragged creeping edges and dew tips.
//  · Haircap moss (Polytrichum) with summer setae, reindeer lichen cushions (Cladonia rangiferina,
//    C. stellaris), pixie cups and Iceland moss (Cetraria) as merged geometry.
// Everything CPU-side is pure (no DOM, no GL) so it can be tested in Node; GPU work sits in the material
// functions further down.

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

// ── tuning ──────────────────────────────────────────────────
export const MOSS = {
  cell: 0.032, // shell frond field: one candidate shoot per 3.2 cm cell (a shoot spans up to 5 cm)
  pile: 0.04, // shell stack height (m): the thickest carpet
  base: 0.004, // lowest shell above the floor (m), clear of the floor's own relief
  coverBias: 0.1, // + more moss, − more bare floor (0.1 → ~45 % of the patch)
  trailBare: 0.015, // half width (m) of the bare ant corridor; the carpet closes in over the next 1.2 cm
  deep: 1.0, // depth darkening between the shoots (0 … 1)
  bump: 1.0, // strength of the shoot normals
  sheen: 0.15, // glossy leaf highlight (Lambert tiers; PBR tiers use roughness instead)
  lichThick: 0.009, // depth (m) of the reindeer-lichen shell stack: the layer of branch-tip heads
  trans: [0.36, 0.44, 0.1], // backlight translucency of moss
};

// Per quality tier. Ultra ≤ 1.3 × high. `lite` (phones): the bottom shell is a cheap, light, textured moss
// surface instead of a dark matted layer with its own shoots, and `deep` softens the depth darkening.
const TIERS = {
  ultra: { shells: 14, grid: 0.025, fronds: 1400, tufts: 520, haircap: 600, lichDetail: 1.0, cushions: [10, 7], atlas: 1024, tips: 6800, cups: 6, cetraria: 5, castFronds: true, castLichen: true, lichShells: 7, antlers: 16 },
  high: { shells: 12, grid: 0.025, fronds: 1100, tufts: 420, haircap: 500, lichDetail: 0.85, cushions: [9, 6], atlas: 1024, tips: 5400, cups: 6, cetraria: 5, castFronds: true, castLichen: true, lichShells: 6, antlers: 14 },
  medium: { shells: 6, grid: 0.03, fronds: 700, tufts: 260, haircap: 420, lichDetail: 0.72, cushions: [8, 5], atlas: 1024, tips: 3800, cups: 5, cetraria: 4, castFronds: false, castLichen: true, lichShells: 4, antlers: 10 },
  low: { shells: 5, grid: 0.04, fronds: 260, tufts: 90, haircap: 200, lichDetail: 0.45, cushions: [6, 4], atlas: 512, tips: 1900, cups: 4, cetraria: 3, castFronds: false, castLichen: false, lite: true, deep: 0.55, lichShells: 3, antlers: 6 },
};
export function mossTier(quality = {}) {
  return TIERS[quality.tier] ?? TIERS.medium;
}

// ── fields: where the carpet grows, how thick, which species, which way the shoots lie ──

const ROOT_SIGMA2 = 2 * 0.035 * 0.035;
function rootRidge(u, v) {
  // the old pine root from config.js microRelief (0 … 1 on its crest)
  const line = v - (0.42 * u - 0.15) - 0.06 * Math.sin(u * 2.3);
  return Math.exp(-(line * line) / ROOT_SIGMA2) * smoothstep(-1.6, -0.9, u) * smoothstep(1.2, 0.5, u);
}

// The wood-ant trail exactly as life.js walks it: a SplineCurve through ANT_TRAIL with a small meander,
// sampled every 5 mm (patch frame).
export function antTrailLine() {
  const curve = new THREE.SplineCurve(ANT_TRAIL.map(([u, v]) => new THREE.Vector2(u, v)));
  curve.arcLengthDivisions = 4000;
  const L = curve.getLength();
  const n = Math.ceil(L / 0.005) + 1;
  const p = new THREE.Vector2();
  const t = new THREE.Vector2();
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = i * 0.005;
    const f = Math.min(1, s / L);
    curve.getPointAt(f, p);
    curve.getTangentAt(f, t);
    const m = (0.006 * Math.sin(s * 7.3 + 0.4) + 0.0035 * Math.sin(s * 17.9 + 2.1)) * smoothstep(0, 0.25, s);
    pts.push([p.x - t.y * m, p.y + t.x * m]);
  }
  return pts;
}

// Distance to the trail (m) on a 1 cm grid over the patch, built on first use; capped at TRAIL_FAR.
const TRAIL_H = 0.01;
const TRAIL_FAR = 0.12;
let trailGrid = null;
function buildTrailGrid() {
  const m = 0.05;
  const nu = Math.ceil((2 * (PATCH.halfL + m)) / TRAIL_H) + 1;
  const nv = Math.ceil((2 * (PATCH.halfW + m)) / TRAIL_H) + 1;
  const d = new Float32Array(nu * nv).fill(TRAIL_FAR);
  const u0 = -PATCH.halfL - m;
  const v0 = -PATCH.halfW - m;
  const pts = antTrailLine();
  const r = Math.ceil(TRAIL_FAR / TRAIL_H);
  for (let k = 0; k < pts.length - 1; k++) {
    const [au, av] = pts[k];
    const [bu, bv] = pts[k + 1];
    const du = bu - au;
    const dv = bv - av;
    const l2 = du * du + dv * dv || 1e-12;
    const ci = Math.round((au - u0) / TRAIL_H);
    const cj = Math.round((av - v0) / TRAIL_H);
    for (let j = Math.max(0, cj - r - 1); j <= Math.min(nv - 1, cj + r + 1); j++) {
      const v = v0 + j * TRAIL_H;
      for (let i = Math.max(0, ci - r - 1); i <= Math.min(nu - 1, ci + r + 1); i++) {
        const u = u0 + i * TRAIL_H;
        const t = clamp(((u - au) * du + (v - av) * dv) / l2);
        const dd = Math.hypot(au + du * t - u, av + dv * t - v);
        const q = j * nu + i;
        if (dd < d[q]) d[q] = dd;
      }
    }
  }
  return { d, nu, nv, u0, v0 };
}

/** Distance (m) from patch point (u, v) to the ants' centre line, capped at 0.12 m. */
export function antTrailDist(u, v) {
  trailGrid ??= buildTrailGrid();
  const G = trailGrid;
  const fu = (u - G.u0) / TRAIL_H;
  const fv = (v - G.v0) / TRAIL_H;
  if (fu < 0 || fv < 0 || fu >= G.nu - 1 || fv >= G.nv - 1) return TRAIL_FAR;
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  const a = fu - i;
  const b = fv - j;
  const k = j * G.nu + i;
  return (G.d[k] * (1 - a) + G.d[k + 1] * a) * (1 - b) + (G.d[k + G.nu] * (1 - a) + G.d[k + G.nu + 1] * a) * b;
}

const spotDist = (s, u, v) => Math.hypot(u - s.u, v - s.v) / s.r;

// clearOther(u, v) from config.js with the spot list gathered once (it runs ~10⁵ times while building)
let OTHERS = null;
function clearOther(u, v) {
  OTHERS ??= Object.values(SPOTS).filter((s) => s.owner !== 'moss' && !(s.shares && s.shares.includes('moss')));
  let best = Infinity;
  for (const s of OTHERS) best = Math.min(best, Math.hypot(u - s.u, v - s.v) - s.r);
  return best;
}

/** Small bare clearings in the carpet (patch frame), clear of every other module's spot. */
export const CLEARINGS = [
  { u: -0.33, v: 0.34, r: 0.075 },
  { u: 0.72, v: -0.24, r: 0.06 },
  { u: -1.12, v: -0.07, r: 0.065 },
];

/** Species mix and shoot direction (world angle, radians) in patch coordinates. Smooth, no fine detail. */
export function mossSpecies(u, v, out = {}) {
  const hylo = smoothstep(0.18, 0.5, noise2(u * 1.1 + 40.2, v * 1.1 - 7.7));
  const dicr = smoothstep(0.32, 0.62, noise2(u * 2.3 - 17.1, v * 2.3 + 5.3)) * (1 - hylo);
  out.hylo = hylo;
  out.dicr = dicr;
  out.pleu = Math.max(0, 1 - hylo - dicr);
  out.flow = clamp(1.9 + 1.4 * noise2(u * 0.65 + 3.3, v * 0.65 - 1.1) + 0.45 * noise2(u * 2.2 - 8.0, v * 2.2 + 2.0), -0.55, 4.35);
  return out;
}

/** Moss cover 0 … 1 at patch point (u, v). */
export function mossCover(u, v) {
  const big = fbm2(u * 1.15 + 17.3, v * 1.15 - 5.1, 4);
  const mid = noise2(u * 4.1 - 3.3, v * 4.1 + 9.7);
  const fine = noise2(u * 12.5 + 1.7, v * 12.5 - 6.2);
  let c = smoothstep(-0.2, 0.0, big + 0.3 * mid + 0.08 * fine + MOSS.coverBias);
  // three small clearings of bare humus under the glide, where pixie cups and Iceland moss grow
  for (const q of CLEARINGS) c *= smoothstep(0.8, 1.3, Math.hypot(u - q.u, v - q.v) / q.r + 0.22 * mid + 0.08 * fine);
  // other modules' spots: moss runs right up to them with a frayed edge
  const ragged = 0.05 * Math.max(0, noise2(u * 7.3 + 11.1, v * 7.3 - 3.7)) + 0.008 * (0.5 + 0.5 * fine);
  c *= smoothstep(0.0, 0.035, clearOther(u, v) - ragged);
  // my own spots: lichen grows on sparse, dry ground; haircap stands in a low, dark carpet
  const l1 = spotDist(SPOTS.reindeerLichen1, u, v);
  const l2 = spotDist(SPOTS.reindeerLichen2, u, v);
  const hc = spotDist(SPOTS.haircapMoss, u, v);
  c *= 0.5 + 0.5 * smoothstep(0.45, 1.05, Math.min(l1, l2) + 0.1 * fine);
  c *= 0.55 + 0.45 * smoothstep(0.35, 1.0, hc);
  // the wood-ant trail: a bare corridor ~3.5 cm wide that the ants keep clear (life.js walks its centre line)
  // a ragged edge that only ever widens the corridor
  const fray = 0.018 * Math.max(0, noise2(u * 14.3 - 2.7, v * 14.3 + 6.6) + 0.25) + 0.006 * Math.max(0, noise2(u * 37 + 1.1, v * 37 - 9.2)) + 0.0015 * (fine + 1);
  c *= smoothstep(MOSS.trailBare, MOSS.trailBare + 0.012, antTrailDist(u, v) - fray);
  // the patch border: the carpet frays out, the regular ground takes over
  const edge = Math.min(PATCH.halfL - Math.abs(u), PATCH.halfW - Math.abs(v));
  return c * smoothstep(0.0, 0.1, edge + 0.06 * mid + 0.03 * fine);
}

/**
 * The carpet at patch point (u, v):
 *   cover  0 … 1 (soft ragged edges; 0 in other modules' spots, on the ant trail and at the patch border)
 *   pile   0 … 1 of MOSS.pile (thickness of the live carpet), dry / hollow 0 … 1 (colour)
 *   hylo / dicr / pleu species weights, flow: the shoots' lying direction (world angle)
 */
export function mossField(u, v, out = {}) {
  const { x, z } = fromPatch(u, v);
  const c = mossCover(u, v);
  out.cover = c;
  const hc = spotDist(SPOTS.haircapMoss, u, v);

  // thickness: hummocks, deeper stair-step moss, thin at the edges, low around haircap, flat on the trail
  const sp = mossSpecies(u, v, out);
  const hum = fbm2(u * 2.3 - 9.1, v * 2.3 + 4.4, 3);
  let pile = (0.5 + 0.38 * hum + 0.22 * sp.hylo + 0.08 * sp.dicr) * smoothstep(0.3, 0.92, c);
  pile *= (0.4 + 0.6 * smoothstep(0.4, 1.0, hc)) * smoothstep(MOSS.trailBare, MOSS.trailBare + 0.025, antTrailDist(u, v));
  out.pile = clamp(pile, 0, 1);

  // colour: drier and browner on hummocks and the root, darker in hollows
  const relief = microRelief(x, z);
  out.dry = clamp(smoothstep(0.004, 0.032, relief) * 0.55 + smoothstep(0.2, 0.65, hum) * 0.35 + rootRidge(u, v) * 0.3);
  out.hollow = clamp(smoothstep(-0.004, -0.022, relief) * 0.8 + smoothstep(-0.2, -0.55, hum) * 0.3);
  return out;
}

/** Moss cover 0 … 1 at world (x, z). For the floor, litter, life and dew modules. */
export function mossCoverAt(x, z) {
  const { u, v } = toPatch(x, z);
  return mossCover(u, v);
}

// ── the cover mask: cover per centimetre for the shells (crisper than the 3 cm shell grid) ──
// R8 over the patch, the same s/t mapping as the moss map.
export const MASK_W = Math.round((2 * PATCH.halfL) / 0.01);
export const MASK_H = Math.round((2 * PATCH.halfW) / 0.01);
export function mossMaskData() {
  const data = new Uint8Array(MASK_W * MASK_H);
  for (let j = 0; j < MASK_H; j++) {
    for (let i = 0; i < MASK_W; i++) {
      const u = ((i + 0.5) / MASK_W - 0.5) * 2 * PATCH.halfL;
      const v = ((j + 0.5) / MASK_H - 0.5) * 2 * PATCH.halfW;
      data[j * MASK_W + i] = Math.round(mossCover(u, v) * 255);
    }
  }
  return data;
}

/** Height (world y) of the visible moss top at world (x, z): heroHeightAt where there is no carpet. */
export function mossTopAt(x, z) {
  const { u, v } = toPatch(x, z);
  const f = mossField(u, v);
  const k = smoothstep(0.1, 0.5, f.cover);
  return heroHeightAt(x, z) + k * (MOSS.base + f.pile * MOSS.pile * 0.9);
}

// ── the moss map: species and shoot direction per 3 cm for the shader ──
// RGBA8 over the patch (s along u, t along v): R hylo, G dicranum, B flow ((a + 0.6) / 5), A snow-depth noise.
export const MAP_W = 128;
export const MAP_H = 64;
export function mossMapData() {
  const data = new Uint8Array(MAP_W * MAP_H * 4);
  const sp = {};
  for (let j = 0; j < MAP_H; j++) {
    for (let i = 0; i < MAP_W; i++) {
      const u = ((i + 0.5) / MAP_W - 0.5) * 2 * PATCH.halfL;
      const v = ((j + 0.5) / MAP_H - 0.5) * 2 * PATCH.halfW;
      mossSpecies(u, v, sp);
      const k = (j * MAP_W + i) * 4;
      data[k] = Math.round(sp.hylo * 255);
      data[k + 1] = Math.round(sp.dicr * 255);
      data[k + 2] = Math.round(clamp((sp.flow + 0.6) / 5) * 255);
      data[k + 3] = Math.round(clamp(0.5 + 0.6 * fbm2(u * 5.3 + 3.1, v * 5.3 - 2.2, 3)) * 255);
    }
  }
  return data;
}

// ── the frond atlas: CPU-rasterised shoots ──────────────────
// 4 × 2 cells of 32 × 64 mm. RGBA8, linear data, not colour:
//   R tissue (0 … 0.15 red stem, 0.2 old leaf … 1 fresh tip), G/B normal x/y (cell space, +y = toward the
//   shoot apex), A coverage. Cells: 0/1 Pleurozium, 2/3 Hylocomium, 4/5 Dicranum (combed shoots seen from
//   above), 6 a single falcate Dicranum leaf (for 3D tufts), 7 the old matted carpet (tileable).
// `tips[cell]` lists branch tips in cell uv for the dew drops; tips[cell][0] is the shoot apex.

const CELL_MM = [32, 64];

class Raster {
  constructor(size) {
    this.W = size;
    this.cw = size / 4;
    this.ch = size / 2;
    this.k = this.cw / CELL_MM[0]; // pixels per mm
    const n = size * size;
    this.cov = new Float32Array(n);
    this.tis = new Float32Array(n).fill(0.5);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.z = new Float32Array(n).fill(-1e9);
    this.caps = 0;
  }

  // A capsule (mm, cell space) with a round cross-section: coverage, height, tissue and normal.
  cap(cell, ax, ay, bx, by, ra, rb, ta, tb, za, zb, wrap = false) {
    if (!wrap) return this._cap(cell, ax, ay, bx, by, ra, rb, ta, tb, za, zb, false);
    for (const ox of [-CELL_MM[0], 0, CELL_MM[0]]) {
      for (const oy of [-CELL_MM[1], 0, CELL_MM[1]]) this._cap(cell, ax + ox, ay + oy, bx + ox, by + oy, ra, rb, ta, tb, za, zb, true);
    }
  }

  _cap(cell, ax, ay, bx, by, ra, rb, ta, tb, za, zb, full) {
    const k = this.k;
    const Ax = ax * k;
    const Ay = ay * k;
    const Bx = bx * k;
    const By = by * k;
    const Ra = Math.max(ra * k, 0.35);
    const Rb = Math.max(rb * k, 0.35);
    const r = Math.max(Ra, Rb) + 1;
    const m = full ? 0 : 3; // keep a clean margin so mip levels do not bleed into the neighbour cells
    const x0 = Math.max(Math.floor(Math.min(Ax, Bx) - r), m);
    const x1 = Math.min(Math.ceil(Math.max(Ax, Bx) + r), this.cw - 1 - m);
    const y0 = Math.max(Math.floor(Math.min(Ay, By) - r), m);
    const y1 = Math.min(Math.ceil(Math.max(Ay, By) + r), this.ch - 1 - m);
    if (x0 > x1 || y0 > y1) return;
    this.caps++;
    const ox = (cell % 4) * this.cw;
    const oy = Math.floor(cell / 4) * this.ch;
    const dx = Bx - Ax;
    const dy = By - Ay;
    const L2 = Math.max(dx * dx + dy * dy, 1e-9);
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const t = clamp(((px - Ax) * dx + (py - Ay) * dy) / L2);
        const ex = px - (Ax + dx * t);
        const ey = py - (Ay + dy * t);
        const d = Math.sqrt(ex * ex + ey * ey);
        const rr = Ra + (Rb - Ra) * t;
        const c = Math.min(1, rr - d + 0.5);
        if (c <= 0) continue;
        const s = Math.min(d / rr, 1);
        const hz = Math.sqrt(1 - s * s);
        const h = za + (zb - za) * t + (hz * rr) / k;
        const i = (oy + y) * this.W + ox + x;
        if ((h > this.z[i] || this.cov[i] < 0.5) && (c >= 0.5 || this.cov[i] < 0.5)) {
          this.tis[i] = ta + (tb - ta) * t;
          const inv = d > 1e-4 ? s / d : 0;
          this.nx[i] = ex * inv;
          this.ny[i] = ey * inv;
          this.z[i] = h;
        }
        if (c > this.cov[i]) this.cov[i] = c;
      }
    }
  }

  rgba() {
    const n = this.W * this.W;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = this.cov[i];
      const filled = c > 0;
      out[i * 4] = Math.round(clamp(filled ? this.tis[i] : 0.5) * 255);
      out[i * 4 + 1] = Math.round(clamp(filled ? this.nx[i] * 0.5 + 0.5 : 0.5) * 255);
      out[i * 4 + 2] = Math.round(clamp(filled ? this.ny[i] * 0.5 + 0.5 : 0.5) * 255);
      out[i * 4 + 3] = Math.round(clamp(c) * 255);
    }
    return out;
  }
}

// A gently curving axis, sampled at n + 1 points: returns { pts: [[x, y]], dir: [[dx, dy]] }.
function axis(x0, y0, x1, y1, n, wobble, rng) {
  const ph = rng.float(0, TAU);
  const f = rng.float(0.6, 1.4);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = Math.sin(t * Math.PI * f + ph) * wobble * Math.sin(t * Math.PI);
    pts.push([x0 + (x1 - x0) * t + w, y0 + (y1 - y0) * t]);
  }
  const dir = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  });
  return { pts, dir };
}
const at = (ax, t) => {
  const n = ax.pts.length - 1;
  const f = clamp(t) * n;
  const i = Math.min(Math.floor(f), n - 1);
  const g = f - i;
  const a = ax.pts[i];
  const b = ax.pts[i + 1];
  const da = ax.dir[i];
  const db = ax.dir[i + 1];
  return { x: a[0] + (b[0] - a[0]) * g, y: a[1] + (b[1] - a[1]) * g, dx: da[0] + (db[0] - da[0]) * g, dy: da[1] + (db[1] - da[1]) * g };
};

// Julaceous branch: an axis densely clad in overlapping, concave leaves (Pleurozium, Hylocomium pinnules).
function leafyBranch(R, cell, rng, x, y, ang, len, { r0 = 0.34, r1 = 0.25, leaf = 0.75, step = 0.52, t0 = 0.42, t1 = 0.88, z0 = 0.5, z1 = 0.2, curl = 0.35, axisT = 0.36, wrap = false } = {}) {
  const n = 6;
  const pts = [[x, y]];
  let a = ang;
  let px = x;
  let py = y;
  for (let i = 1; i <= n; i++) {
    a += (curl / n) * (i < n / 2 ? 1 : 0.6);
    px += Math.cos(a) * (len / n);
    py += Math.sin(a) * (len / n);
    pts.push([px, py]);
  }
  const rnd = rng.float(-0.06, 0.06);
  for (let i = 0; i < n; i++) {
    const s0 = i / n;
    const s1 = (i + 1) / n;
    R.cap(cell, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r0 + (r1 - r0) * s0, r0 + (r1 - r0) * s1, axisT, axisT + 0.06, z0 + (z1 - z0) * s0 - 0.08, z0 + (z1 - z0) * s1 - 0.08, wrap);
  }
  const ax = { pts, dir: pts.map((p, i) => {
    const q = pts[Math.min(n, i + 1)];
    const o = pts[Math.max(0, i - 1)];
    const l = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1;
    return [(q[0] - o[0]) / l, (q[1] - o[1]) / l];
  }) };
  const nl = Math.max(2, Math.floor(len / step));
  for (let j = 0; j <= nl; j++) {
    const t = j / nl;
    const p = at(ax, t * 0.97);
    const side = j % 2 ? 1 : -1;
    const ox = -p.dy * side;
    const oy = p.dx * side;
    const ll = leaf * (1 - 0.35 * t * t);
    const rr = (r0 + (r1 - r0) * t) * (0.95 - 0.15 * t);
    const sx = p.x + ox * rr * 0.4;
    const sy = p.y + oy * rr * 0.4;
    const ex = sx + p.dx * ll + ox * rr * 0.25;
    const ey = sy + p.dy * ll + oy * rr * 0.25;
    const tt = t0 + (t1 - t0) * t + rnd + rng.float(-0.03, 0.03);
    const zz = z0 + (z1 - z0) * t;
    R.cap(cell, sx, sy, ex, ey, rr * 0.95, rr * 0.7, tt, tt + 0.05, zz, zz + 0.12, wrap);
  }
  return pts[n];
}

const uvOf = (x, y) => [x / CELL_MM[0], y / CELL_MM[1]];

// Pleurozium schreberi: a soft, narrow plume. Red stem; short, fat, worm-like (julaceous) branches that
// curve forward and almost touch; a blunt, pale growing tip.
function drawPleurozium(R, cell, rng, tips) {
  const y0 = 3.5;
  const y1 = rng.float(58, 61.5);
  const ax = axis(16 + rng.float(-1.5, 1.5), y0, 16 + rng.float(-2, 2), y1, 48, rng.float(1.0, 2.6), rng);
  tips.push(uvOf(ax.pts[48][0], ax.pts[48][1]));
  const L = y1 - y0;
  let s = 0.05;
  for (let b = 0; s < 0.88; b++) {
    const p = at(ax, s);
    const side = b % 2 ? 1 : -1;
    const prof = Math.pow(Math.sin((Math.PI * (s - 0.02)) / 0.92), 0.7);
    const len = Math.max(1.8, (8.5 * prof + rng.float(-1.6, 1.2)) * (rng.chance(0.12) ? 0.55 : 1));
    const base = Math.atan2(p.dy, p.dx);
    const ang = base - side * THREE.MathUtils.degToRad(rng.float(36, 58));
    if (!rng.chance(0.06)) {
      const end = leafyBranch(R, cell, rng, p.x - p.dy * side * 0.3, p.y + p.dx * side * 0.3, ang, len, {
        r0: 0.72,
        r1: 0.62,
        leaf: 1.05,
        step: 0.55,
        curl: side * rng.float(0.2, 0.9),
        t0: 0.46,
        t1: 0.92,
        z0: 0.62,
        z1: 0.3,
      });
      if (rng.chance(0.7)) tips.push(uvOf(end[0], end[1]));
    }
    s += rng.float(1.0, 1.3) / L;
  }
  // stem leaves flank the red stem, which shows as a fine red line between them
  const nl = Math.round(L / 0.95);
  for (let i = 0; i < nl; i++) {
    const t = i / nl;
    const p = at(ax, t);
    const side = i % 2 ? 1 : -1;
    const ox = -p.dy * side;
    const oy = p.dx * side;
    const sz = t > 0.86 ? 1 - (t - 0.86) * 4 : 1;
    const tt = 0.55 + 0.12 * t + (t > 0.86 ? (0.3 * (t - 0.86)) / 0.14 : 0) + rng.float(-0.04, 0.04);
    R.cap(cell, p.x + ox * 0.3, p.y + oy * 0.3, p.x + p.dx * 1.3 * sz + ox * 0.65 * sz, p.y + p.dy * 1.3 * sz + oy * 0.65 * sz, 0.5 * sz + 0.12, 0.36 * sz + 0.1, tt, tt + 0.06, 0.3, 0.42);
  }
  for (let i = 0; i < 48; i++) {
    const a = ax.pts[i];
    const b = ax.pts[i + 1];
    if (i / 48 > 0.9) break;
    R.cap(cell, a[0], a[1], b[0], b[1], 0.3, 0.27, 0.05, 0.07, 0.95, 0.95);
  }
  // the growing tip: a fat, pale, blunt worm
  const tipStart = at(ax, 0.86);
  leafyBranch(R, cell, rng, tipStart.x, tipStart.y, Math.atan2(tipStart.dy, tipStart.dx), L * 0.13, { r0: 0.8, r1: 0.65, leaf: 1.1, step: 0.5, curl: rng.float(-0.3, 0.3), t0: 0.8, t1: 1.0, z0: 1.0, z1: 0.9, axisT: 0.6 });
}

// Hylocomium splendens: bipinnate, lacy, golden; widest near the base, red stem, wiry pinnae.
function drawHylocomium(R, cell, rng, tips) {
  const y0 = 3;
  const y1 = rng.float(58.5, 61.5);
  const ax = axis(16 + rng.float(-1, 1), y0, 16 + rng.float(-1.5, 1.5), y1, 40, rng.float(0.8, 2.0), rng);
  tips.push(uvOf(ax.pts[40][0], ax.pts[40][1]));
  for (let i = 0; i < 40; i++) {
    const a = ax.pts[i];
    const b = ax.pts[i + 1];
    R.cap(cell, a[0], a[1], b[0], b[1], 0.32, 0.26, 0.06, 0.1, 0.72, 0.7);
  }
  const L = y1 - y0;
  const np = Math.round(L / 2.5);
  for (let k = 0; k < np; k++) {
    const s = 0.04 + (k / np) * 0.9;
    const p = at(ax, s);
    const side = k % 2 ? 1 : -1;
    const lp = Math.max(1.6, 16 * Math.pow(Math.sin(Math.min(s * 1.7, 1) * Math.PI * 0.5), 0.6) * Math.pow(1 - s, 0.8) + rng.float(-0.8, 0.8));
    const base = Math.atan2(p.dy, p.dx);
    const ang = base - side * THREE.MathUtils.degToRad(rng.float(55, 65));
    // pinna axis
    const n = 6;
    const pts = [[p.x, p.y]];
    let a = ang;
    for (let i = 1; i <= n; i++) {
      a += (side * 0.28) / n;
      pts.push([pts[i - 1][0] + Math.cos(a) * (lp / n), pts[i - 1][1] + Math.sin(a) * (lp / n)]);
    }
    for (let i = 0; i < n; i++) R.cap(cell, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 0.3, 0.24, 0.16, 0.3, 0.6 - i * 0.04, 0.56 - i * 0.04);
    const pax = { pts, dir: pts.map((q, i) => {
      const e = pts[Math.min(n, i + 1)];
      const o = pts[Math.max(0, i - 1)];
      const l = Math.hypot(e[0] - o[0], e[1] - o[1]) || 1;
      return [(e[0] - o[0]) / l, (e[1] - o[1]) / l];
    }) };
    // pinnules
    const nq = Math.max(1, Math.round(lp / 1.3));
    for (let q = 0; q < nq; q++) {
      const t = 0.08 + (q / nq) * 0.85;
      const pp = at(pax, t);
      const sd = q % 2 ? 1 : -1;
      const lq = Math.max(0.7, lp * 0.34 * Math.pow(1 - t, 0.7) + 0.6);
      const pa = Math.atan2(pp.dy, pp.dx) - sd * THREE.MathUtils.degToRad(rng.float(42, 58));
      leafyBranch(R, cell, rng, pp.x, pp.y, pa, lq, { r0: 0.36, r1: 0.26, leaf: 0.7, step: 0.42, t0: 0.52, t1: 0.92, z0: 0.5 - t * 0.2, z1: 0.38 - t * 0.2, curl: sd * rng.float(0.1, 0.5), axisT: 0.32 });
    }
    // the pinna's own leafy tip
    const e = leafyBranch(R, cell, rng, pts[n - 1][0], pts[n - 1][1], a, lp / n + 0.8, { r0: 0.28, r1: 0.18, leaf: 0.6, step: 0.42, t0: 0.6, t1: 0.92, z0: 0.36, z1: 0.3, curl: 0 });
    if (rng.chance(0.5)) tips.push(uvOf(e[0], e[1]));
  }
  // scattered stem leaves
  for (let i = 0; i < 46; i++) {
    const t = rng.float(0.02, 0.97);
    const p = at(ax, t);
    const side = rng.sign();
    R.cap(cell, p.x, p.y, p.x + p.dx * 0.7 - p.dy * side * 0.4, p.y + p.dy * 0.7 + p.dx * side * 0.4, 0.22, 0.14, 0.5, 0.6, 0.74, 0.78);
  }
}

// Dicranum seen from above: shoot tops whose sickle-shaped leaves are all combed toward +y.
function drawDicranum(R, cell, rng, tips) {
  const shoots = [];
  // a rounded, irregular clump: shoots inside a wobbly ellipse, smaller toward its rim
  const ph = rng.float(0, TAU);
  const rim = (x, y) => {
    const a = Math.atan2((y - 30) / 25, (x - 16) / 11.5);
    const r = 1 + 0.16 * Math.sin(3 * a + ph) + 0.1 * Math.sin(5 * a - ph * 1.7);
    return Math.hypot((x - 16) / 11.5, (y - 30) / 25) / r;
  };
  for (let tries = 0; tries < 2000 && shoots.length < 30; tries++) {
    const x = rng.float(4.5, 27.5);
    const y = rng.float(4.5, 55);
    if (rim(x, y) > 1) continue;
    if (shoots.every((s) => Math.hypot(s[0] - x, s[1] - y) > 5.2)) shoots.push([x, y]);
  }
  for (const [sx, sy] of shoots) {
    const shrink = 1 - 0.45 * smoothstep(0.55, 1.0, rim(sx, sy));
    const nL = Math.round(rng.int(18, 25) * shrink);
    const zTop = rng.float(1.4, 2.4);
    let tipDone = false;
    for (let l = 0; l < nL; l++) {
      const phi = rng.float(0, TAU);
      const len = rng.float(4.6, 8.6) * (0.75 + 0.25 * Math.abs(Math.cos(phi))) * shrink;
      let dx = Math.cos(phi);
      let dy = Math.sin(phi);
      let x = sx + dx * 0.3;
      let y = sy + dy * 0.3;
      const n = 6;
      const tilt = rng.float(-0.25, 0.25);
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const pull = Math.pow(t1, 1.1) * 0.9;
        let ndx = dx * (1 - pull) + tilt * pull;
        let ndy = dy * (1 - pull) + pull;
        const nl = Math.hypot(ndx, ndy) || 1;
        ndx /= nl;
        ndy /= nl;
        const nx = x + ndx * (len / n);
        const ny = y + ndy * (len / n);
        const w0 = 0.5 * (1 - t0) + 0.06;
        const w1 = 0.5 * (1 - t1) + 0.06;
        R.cap(cell, x, y, nx, ny, w0, w1, 0.36 + 0.58 * t0, 0.36 + 0.58 * t1, zTop - 1.3 * t0 - l * 0.004, zTop - 1.3 * t1 - l * 0.004);
        x = nx;
        y = ny;
        dx = ndx;
        dy = ndy;
      }
      if (!tipDone && rng.chance(0.25)) {
        tips.push(uvOf(x, y));
        tipDone = true;
      }
    }
  }
}

// One lanceolate, keeled Dicranum leaf filling the cell (base at v = 0), painted analytically.
function drawLeaf(R, cell) {
  const ox = (cell % 4) * R.cw;
  const oy = Math.floor(cell / 4) * R.ch;
  for (let y = 3; y < R.ch - 3; y++) {
    const v = (y + 0.5) / R.ch;
    const hw = 0.42 * smoothstep(0.0, 0.07, v) * Math.pow(1 - v, 0.95);
    for (let x = 3; x < R.cw - 3; x++) {
      const u = (x + 0.5) / R.cw - 0.5;
      const c = clamp((hw - Math.abs(u)) * R.cw + 0.5);
      if (c <= 0) continue;
      const i = (oy + y) * R.W + ox + x;
      const costa = Math.abs(u) < 0.05 * (1 - v) + 0.008;
      R.cov[i] = c;
      R.tis[i] = 0.42 + 0.52 * v - (costa ? 0.07 : 0);
      R.nx[i] = clamp(u / Math.max(hw, 1e-3), -1, 1) * 0.42;
      R.ny[i] = -0.12;
      R.z[i] = 1;
    }
  }
}

// The matted carpet seen between the shoots, tileable: old red-brown stems underneath, and a dense felt of
// short leafy shoot pieces (worm-like branch ends, fresher at their tips) on top. On medium and up it only
// shows darkened in the deep gaps; on phones it is the visible carpet surface under the shoot layers.
function drawTangle(R, cell, rng) {
  for (let s = 0; s < 40; s++) {
    let x = rng.float(0, CELL_MM[0]);
    let y = rng.float(0, CELL_MM[1]);
    let a = rng.float(0, TAU);
    const z = rng.float(-0.6, 0.2);
    for (let i = 0; i < 14; i++) {
      a += rng.float(-0.3, 0.3);
      const nx = x + Math.cos(a) * 1.0;
      const ny = y + Math.sin(a) * 1.0;
      R.cap(cell, x, y, nx, ny, 0.22, 0.22, rng.chance(0.5) ? 0.07 : 0.22, 0.26, z, z, true);
      x = nx;
      y = ny;
    }
  }
  for (let k = 0; k < 150; k++) {
    const t0 = rng.float(0.32, 0.5);
    leafyBranch(R, cell, rng, rng.float(0, CELL_MM[0]), rng.float(0, CELL_MM[1]), rng.float(0, TAU), rng.float(4, 10), {
      r0: rng.float(0.45, 0.62),
      r1: rng.float(0.36, 0.5),
      leaf: 0.85,
      step: 0.5,
      curl: rng.float(-0.8, 0.8),
      t0,
      t1: t0 + rng.float(0.3, 0.45),
      z0: rng.float(0.2, 1.6),
      z1: rng.float(0.0, 1.2),
      wrap: true,
    });
  }
}

/** Rasterise the frond atlas: { size, data (RGBA8), tips: [cell] → [[u, v]], capsules }. */
export function mossAtlas(size = 1024, seed = 2718) {
  const R = new Raster(size);
  const rng = new RNG(seed);
  const tips = Array.from({ length: 8 }, () => []);
  drawPleurozium(R, 0, rng, tips[0]);
  drawPleurozium(R, 1, rng, tips[1]);
  drawHylocomium(R, 2, rng, tips[2]);
  drawHylocomium(R, 3, rng, tips[3]);
  drawDicranum(R, 4, rng, tips[4]);
  drawDicranum(R, 5, rng, tips[5]);
  drawLeaf(R, 6);
  tips[6].push([0.5, 0.97]);
  drawTangle(R, 7, rng);
  return { size, data: R.rgba(), tips, capsules: R.caps };
}

// ── shells: the carpet surface ──────────────────────────────

/**
 * Grid over the patch on heroHeightAt, only where there is moss. Attributes: position, normal,
 * aMossA (cover, pile, dry, hollow). Front faces look up.
 */
export function shellGeometry(step = 0.03) {
  const nu = Math.ceil((2 * PATCH.halfL) / step);
  const nv = Math.ceil((2 * PATCH.halfW) / step);
  const W = nu + 1;
  const count = W * (nv + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const att = new Float32Array(count * 4);
  const f = {};
  const n = v3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = -PATCH.halfL + (i / nu) * 2 * PATCH.halfL;
      const v = -PATCH.halfW + (j / nv) * 2 * PATCH.halfW;
      const { x, z } = fromPatch(u, v);
      mossField(u, v, f);
      const k = j * W + i;
      pos.set([x, heroHeightAt(x, z), z], k * 3);
      heroNormalAt(x, z, 0.01, n);
      nor.set([n.x, n.y, n.z], k * 3);
      att.set([f.cover, f.pile, f.dry, f.hollow], k * 4);
    }
  }
  // keep cells that touch moss; drop the unused vertices
  const idx = [];
  const used = new Int32Array(count).fill(-1);
  let nUsed = 0;
  const use = (k) => {
    if (used[k] < 0) used[k] = nUsed++;
    return used[k];
  };
  // a cell stays if moss is anywhere near it (the shader's 1 cm cover mask frays out between vertices)
  const near = (i, j) => {
    for (let jj = Math.max(0, j - 1); jj <= Math.min(nv, j + 2); jj++) {
      for (let ii = Math.max(0, i - 1); ii <= Math.min(nu, i + 2); ii++) if (att[(jj * W + ii) * 4] > 0.01) return true;
    }
    return false;
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      if (!near(i, j)) continue;
      // (a, b, c) faces down for this grid orientation; (a, c, b) faces up
      idx.push(use(a), use(c), use(b), use(b), use(c), use(d));
    }
  }
  const P = new Float32Array(nUsed * 3);
  const N = new Float32Array(nUsed * 3);
  const A = new Float32Array(nUsed * 4);
  for (let k = 0; k < count; k++) {
    const m = used[k];
    if (m < 0) continue;
    P.set(pos.subarray(k * 3, k * 3 + 3), m * 3);
    N.set(nor.subarray(k * 3, k * 3 + 3), m * 3);
    A.set(att.subarray(k * 4, k * 4 + 4), m * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aMossA', new THREE.BufferAttribute(A, 4));
  g.setIndex(nUsed > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // the shells rise above the floor
  g.boundingBox.max.y += MOSS.base + MOSS.pile + 0.005;
  g.boundingSphere.radius += MOSS.base + MOSS.pile + 0.005;
  return g;
}

// ── 3D cards: lying fronds and Dicranum tufts ───────────────

class CardGeo {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.tan = [];
    this.h = [];
    this.idx = [];
  }
  get count() {
    return this.pos.length / 3;
  }
  vert(p, n, t, u, v, h) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.tan.push(t.x, t.y, t.z);
    this.uv.push(u, v);
    this.h.push(h);
    return this.count - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTan', new THREE.Float32BufferAttribute(this.tan, 3));
    g.setAttribute('aH', new THREE.Float32BufferAttribute(this.h, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// A frond card in units of its length L: x ∈ [-0.25, 0.25] across (atlas u), s ∈ [0, 1] along (atlas v),
// y up. The base dives into the carpet, the middle arches over it, the tip droops a little.
export function frondLocal(x, s, out = v3()) {
  // (clamped: the normal's finite difference samples just below s = 0, where pow() of a negative is NaN)
  const yc = -0.17 * (1 - smoothstep(0, 0.36, s)) + 0.105 * Math.sin(Math.PI * Math.pow(Math.max(s, 0), 0.85)) - 0.05 * smoothstep(0.7, 1, s);
  const ax = Math.min(Math.abs(x) / 0.25, 1);
  const y = yc - 0.032 * Math.pow(ax, 1.6) * (0.4 + 0.6 * smoothstep(0, 0.3, s));
  return out.set(x + 0.025 * s * s, y, s);
}
const _fa = v3();
const _fb = v3();
export function frondNormal(x, s, out = v3()) {
  const e = 1e-3;
  const dx = _fa.copy(frondLocal(x + e, s, _fa)).sub(frondLocal(x - e, s, _fb));
  const ds = frondLocal(x, s + e, v3()).sub(frondLocal(x, s - e, v3()));
  return out.crossVectors(ds, dx).normalize();
}

const FR_SEG = 8;
const FR_X = [-0.25, 0, 0.25];
export function frondGeometry() {
  const g = new CardGeo();
  const p = v3();
  const n = v3();
  const t = v3();
  for (let i = 0; i <= FR_SEG; i++) {
    const s = i / FR_SEG;
    for (const x of FR_X) {
      frondLocal(x, s, p);
      frondNormal(x, s, n);
      t.copy(frondLocal(x + 1e-3, s, v3())).sub(frondLocal(x - 1e-3, s, v3())).normalize();
      g.vert(p, n, t, x / 0.5 + 0.5, s, s);
    }
  }
  for (let i = 0; i < FR_SEG; i++) {
    for (let j = 0; j < 2; j++) {
      const a = i * 3 + j;
      const b = a + 1;
      const c = a + 3;
      const d = c + 1;
      g.idx.push(a, c, b, b, c, d);
    }
  }
  return g.build();
}

// A Dicranum shoot tip (metres): falcate leaves, all swept toward +z (the comb direction).
export function tuftGeometry(seed = 77) {
  const rng = new RNG(seed);
  const g = new CardGeo();
  const tips = [];
  const comb = v3(0, -0.35, 1).normalize();
  const nLeaves = 13;
  const SEG = 3;
  for (let l = 0; l < nLeaves; l++) {
    const inner = l < 3;
    const phi = (l / nLeaves) * TAU + rng.float(-0.3, 0.3);
    const el = THREE.MathUtils.degToRad(inner ? rng.float(78, 88) : rng.float(48, 72));
    const d0 = v3(Math.cos(phi) * Math.cos(el), Math.sin(el), Math.sin(phi) * Math.cos(el));
    const len = inner ? rng.float(0.0035, 0.005) : rng.float(0.006, 0.0098);
    const w = inner ? 0.0011 : 0.0014;
    const r0 = inner ? 0.0002 : rng.float(0.0004, 0.0011);
    let p = v3(Math.cos(phi) * r0, inner ? 0.002 : rng.float(-0.001, 0.0015), Math.sin(phi) * r0);
    const rows = [];
    let d = d0.clone();
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG;
      const side = v3().crossVectors(UP, d);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      rows.push({ p: p.clone(), d: d.clone(), side, s });
      const pull = Math.pow((i + 1) / SEG, 1.2) * (inner ? 0.4 : 0.92);
      d = d0.clone().lerp(comb, pull).normalize();
      p = p.clone().addScaledVector(d, len / SEG);
    }
    const base = g.count;
    for (const r of rows) {
      const n = v3().crossVectors(r.d, r.side).normalize();
      if (n.y < 0) n.negate();
      n.lerp(UP, 0.35).normalize();
      for (const sd of [-0.5, 0.5]) g.vert(r.p.clone().addScaledVector(r.side, sd * w), n, r.side, sd + 0.5, r.s, r.s);
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      g.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    if (!inner) tips.push(rows[SEG].p.clone());
  }
  return { geometry: g.build(), tips };
}

// world-space frame for a card lying along `fwd` on a surface with normal `nrm`
function cardMatrix(m, pos, fwd, nrm, sx, sy, sz) {
  const f = fwd.clone().addScaledVector(nrm, -fwd.dot(nrm)).normalize();
  const r = v3().crossVectors(nrm, f).normalize();
  m.makeBasis(r.multiplyScalar(sx), nrm.clone().multiplyScalar(sy), f.multiplyScalar(sz));
  m.setPosition(pos);
  return m;
}

const fwdOf = (ang) => v3(-Math.sin(ang), 0, Math.cos(ang)); // the stamp convention: R(ang) · (0, 1)
const inside = (u, v, m = 0) => Math.abs(u) < PATCH.halfL - m && Math.abs(v) < PATCH.halfW - m;

// Sample a patch point, biased toward the glide footprint (|u| ≤ 1.45, |v| ≤ 0.62).
function samplePoint(rng, strip = 0.7) {
  if (rng.next() < strip) return [rng.float(-1.45, 1.45), rng.float(-0.62, 0.62)];
  return [rng.float(-PATCH.halfL, PATCH.halfL), rng.float(-PATCH.halfW, PATCH.halfW)];
}

const _fc = v3();
function frondClear(m, L) {
  const need = MOSS.trailBare + 0.004;
  for (let s = 0.1; s <= 1.0001; s += 0.15) {
    for (const x of [-0.25, 0, 0.25]) {
      frondLocal(x, s, _fc).applyMatrix4(m);
      const q = toPatch(_fc.x, _fc.z);
      if (antTrailDist(q.u, q.v) < need) return false;
    }
  }
  return true;
}

/** Instances for the lying fronds: matrices, per-instance params and dew tips. */
export function placeFronds(count, atlasTips, seed = 9011) {
  const rng = new RNG(seed);
  const mats = new Float32Array(count * 16);
  const params = new Float32Array(count * 4);
  const tips = [];
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const f = {};
  const g = {};
  const n = v3();
  const tip = v3();
  let k = 0;
  for (let tries = 0; k < count && tries < count * 60; tries++) {
    const [u, v] = samplePoint(rng);
    mossField(u, v, f);
    if (f.cover < 0.08 || f.pile < 0.04) continue;
    const edge = f.cover < 0.55;
    // inside the carpet only on hummock tops, where shoots stand proud of the mat
    const hummock = smoothstep(0.3, 0.75, f.dry + 0.25 * f.pile);
    if (rng.next() > (edge ? 0.6 : 0.08 + 0.92 * hummock) * (1 - 0.85 * f.dicr)) continue;
    const hylo = rng.next() < f.hylo / Math.max(f.hylo + f.pleu, 1e-3);
    let ang;
    if (edge) {
      // creeping out over the bare floor: point down the cover gradient
      const e = 0.02;
      const gu = mossField(u + e, v, g).cover - mossField(u - e, v, g).cover;
      const gv = mossField(u, v + e, g).cover - mossField(u, v - e, g).cover;
      const wx = -(gu * PATCH.u.x + gv * PATCH.v.x);
      const wz = -(gu * PATCH.u.y + gv * PATCH.v.y);
      ang = Math.atan2(-wx, wz) + rng.float(-0.6, 0.6);
    } else {
      ang = f.flow + rng.float(-0.5, 0.5) * (hylo ? TAU : 5.0);
    }
    const L = (edge ? rng.float(0.024, 0.036) : hylo ? rng.float(0.03, 0.044) : rng.float(0.027, 0.045)) * (rng.chance(0.15) ? 0.75 : 1);
    const arch = edge ? rng.float(0.5, 0.85) : hylo ? rng.float(1.3, 2.0) : rng.float(0.8, 1.5);
    const { x, z } = fromPatch(u, v);
    const ground = heroHeightAt(x, z);
    heroNormalAt(x, z, 0.02, n).lerp(UP, 0.5).normalize();
    const top = ground + MOSS.base + f.pile * MOSS.pile * rng.float(0.78, 0.98);
    const pos = v3(x, top, z);
    cardMatrix(m, pos, fwdOf(ang), n, L, L * arch, L);
    // stay clear of the other modules and inside the patch; lift a creeping tip off the floor
    frondLocal(0, 0.96, tip).applyMatrix4(m);
    const tp = toPatch(tip.x, tip.z);
    const mid = frondLocal(0, 0.5, v3()).applyMatrix4(m);
    const mp = toPatch(mid.x, mid.z);
    if (!inside(tp.u, tp.v, 0.06) || clearOther(tp.u, tp.v) < 0.005 || clearOther(mp.u, mp.v) < 0.005) continue;
    // nothing lies across the ants' corridor (sample the card's centre line and its edges)
    if (!frondClear(m, L)) continue;
    const lift = heroHeightAt(tip.x, tip.z) + 0.0025 - tip.y;
    if (lift > 0) {
      if (lift > 0.012) continue;
      pos.y += lift;
      m.setPosition(pos);
    }
    m.toArray(mats, k * 16);
    const cell = (hylo ? 2 : 0) + (rng.next() < 0.5 ? 0 : 1);
    const mir = rng.next() < 0.5 ? 1 : -1;
    params.set([cell, mir, rng.next(), f.dry - f.hollow], k * 4);
    // dew tips: the shoot apex, sometimes a branch tip as well
    nm.getNormalMatrix(m);
    const list = atlasTips[cell];
    const pick = [list[0]];
    if (list.length > 1 && rng.chance(0.4)) pick.push(list[1 + Math.floor(rng.next() * (list.length - 1))]);
    for (const [tu, tv] of pick) {
      const cu = mir > 0 ? tu : 1 - tu;
      const lx = (cu - 0.5) * 0.5;
      const p = frondLocal(lx, tv, v3()).applyMatrix4(m);
      const nn = frondNormal(lx, tv, v3()).applyMatrix3(nm).normalize();
      if (nn.y < 0) nn.negate();
      tips.push({ p, n: nn, c: hylo ? [0.3, 0.29, 0.07] : [0.27, 0.32, 0.06], w: Math.abs(u) < 1.45 && Math.abs(v) < 0.62 ? 1 : 0.5 });
    }
    k++;
  }
  return { count: k, matrices: mats.subarray(0, k * 16), params: params.subarray(0, k * 4), tips };
}

/** Instances for the Dicranum tufts (combed along the shoot flow). */
export function placeTufts(count, tuftTips, seed = 9127) {
  const rng = new RNG(seed);
  const mats = new Float32Array(count * 16);
  const params = new Float32Array(count * 4);
  const tips = [];
  const m = new THREE.Matrix4();
  const f = {};
  const n = v3();
  let k = 0;
  for (let tries = 0; k < count && tries < count * 80; tries++) {
    const [u, v] = samplePoint(rng, 0.72);
    mossField(u, v, f);
    if (f.cover < 0.3 || f.dicr < 0.15) continue;
    if (rng.next() > Math.pow(f.dicr * f.cover, 1.2)) continue;
    if (clearOther(u, v) < 0.022 || !inside(u, v, 0.05)) continue;
    if (antTrailDist(u, v) < MOSS.trailBare + 0.016) continue;
    const { x, z } = fromPatch(u, v);
    heroNormalAt(x, z, 0.02, n).lerp(UP, 0.6).normalize();
    const s = rng.float(0.85, 1.3);
    const pos = v3(x, heroHeightAt(x, z) + MOSS.base + f.pile * MOSS.pile * rng.float(0.72, 0.9), z);
    cardMatrix(m, pos, fwdOf(f.flow + rng.float(-0.25, 0.25)), n, s, s, s);
    m.toArray(mats, k * 16);
    params.set([6, 1, rng.next(), f.dry - f.hollow], k * 4);
    if (rng.chance(0.35)) {
      const p = tuftTips[Math.floor(rng.next() * tuftTips.length)].clone().applyMatrix4(m);
      tips.push({ p, n: v3(0, 1, 0), c: [0.12, 0.2, 0.035], w: 1 });
    }
    k++;
  }
  return { count: k, matrices: mats.subarray(0, k * 16), params: params.subarray(0, k * 4), tips };
}

// ── haircap moss (Polytrichum commune) ──────────────────────
// Merged geometry in world space. Extra attribute aBase (xyz: the shoot apex the part grows out of,
// w: kind 0 plant, 1 seta, 2 capsule, 3 male splash-cup) lets the shader grow setae and cups with the season.

function pushBase(list, md, from, p, kind) {
  for (let i = from; i < md.count; i++) list.push(p.x, p.y, p.z, kind);
}

function taperedLeaf(md, base, dir, side, len, w, cols, bend) {
  // three rows: base, middle, tip; bends away from the stem (spreading, slightly recurved)
  const rows = [];
  let p = base.clone();
  let d = dir.clone();
  for (let i = 0; i <= 2; i++) {
    rows.push({ p: p.clone(), d: d.clone(), w: w * [1, 0.72, 0.06][i] });
    d = d.clone().addScaledVector(UP, -bend).normalize();
    p = p.clone().addScaledVector(d, len / 2);
  }
  const i0 = md.count;
  for (let i = 0; i < 3; i++) {
    const r = rows[i];
    const n = v3().crossVectors(r.d, side).normalize();
    if (n.y < 0) n.negate();
    n.lerp(UP, 0.45).normalize();
    for (const s of [-0.5, 0.5]) md.vert(r.p.clone().addScaledVector(side, s * r.w), n, s + 0.5, i / 2, cols[i], 0, i / 2);
  }
  for (let i = 0; i < 2; i++) {
    const a = i0 + i * 2;
    md.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return rows[2].p;
}

export function haircapGeometry(nStems, seed = 4711) {
  const rng = new RNG(seed);
  const S = SPOTS.haircapMoss;
  const md = new MeshData();
  const base = [];
  const tips = [];
  const LEAF = [
    [0.07, 0.09, 0.035],
    [0.035, 0.085, 0.02],
    [0.11, 0.06, 0.02],
  ];
  const OLD = [
    [0.07, 0.05, 0.025],
    [0.06, 0.045, 0.02],
    [0.08, 0.05, 0.02],
  ];
  let made = 0;
  for (let tries = 0; made < nStems && tries < nStems * 80; tries++) {
    const a = rng.float(0, TAU);
    const rr = S.r * 1.12 * Math.sqrt(rng.next());
    const fall = rr / S.r;
    if (rng.next() > 1.15 - fall * fall) continue;
    const u = S.u + Math.cos(a) * rr;
    const v = S.v + Math.sin(a) * rr;
    if (clearOther(u, v) < 0.015 || !inside(u, v, 0.03)) continue;
    const { x, z } = fromPatch(u, v);
    const g = heroHeightAt(x, z) - 0.012;
    const H = rng.float(0.05, 0.15) * (0.62 + 0.38 * (1 - fall));
    const out = v3(Math.cos(a), 0, Math.sin(a));
    const lean = v3(rng.float(-1, 1), 0, rng.float(-1, 1)).multiplyScalar(0.12).addScaledVector(out, 0.1 + 0.15 * fall);
    const axisDir = UP.clone().add(lean).normalize();
    const pts = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      pts.push(v3(x, g, z).addScaledVector(axisDir, H * t).addScaledVector(lean, H * 0.15 * t * t));
    }
    const apex = pts[3];
    // the leaning shoot, its leaves and seta stay out of the neighbours' spots (the fern's, mostly)
    const ap = toPatch(apex.x, apex.z);
    if (clearOther(ap.u, ap.v) < 0.03) continue;
    made++;
    const i0 = md.count;
    addTube(md, pts, [0.00095, 0.0008, 0.0007, 0.0006], { colorFn: (i) => (i < 2 ? [0.06, 0.04, 0.025] : [0.09, 0.07, 0.03]) });
    pushBase(base, md, i0, apex, 0);
    // leaves on the upper half, spiralling; the top ones erect, the lower ones spread and recurved
    const nL = rng.int(12, 17);
    const ph = rng.float(0, TAU);
    for (let l = 0; l < nL; l++) {
      const t = 0.42 + 0.58 * Math.pow(l / (nL - 1), 0.8);
      const p = pts[0].clone().lerp(apex, t);
      const az = ph + l * 2.39996;
      const radial = v3(Math.cos(az), 0, Math.sin(az));
      const el = THREE.MathUtils.degToRad(15 + 60 * Math.pow(t, 3) + rng.float(-8, 8));
      const dir = radial.clone().multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el)).normalize();
      const side = v3().crossVectors(UP, radial).normalize();
      const len = (t > 0.92 ? 0.0055 : 0.0075) + rng.float(0, 0.0035);
      const j0 = md.count;
      const tipP = taperedLeaf(md, p, dir, side, len, 0.0011, t < 0.6 ? OLD : LEAF, t > 0.92 ? 0.05 : 0.28);
      pushBase(base, md, j0, apex, 0);
      if (t > 0.75 && rng.chance(0.18)) tips.push({ p: tipP, n: dir.clone().lerp(UP, 0.5).normalize(), c: [0.04, 0.09, 0.02], w: 0.8 });
    }
    // sporophytes (female shoots) or splash-cups (male shoots)
    const r = rng.next();
    if (r < 0.36) {
      const sl = rng.float(0.04, 0.07);
      const sd = UP.clone().add(v3(rng.float(-0.15, 0.15), 0, rng.float(-0.15, 0.15))).normalize();
      const sp = [];
      for (let i = 0; i <= 4; i++) sp.push(apex.clone().addScaledVector(sd, sl * (i / 4)).addScaledVector(out, 0.004 * (i / 4) ** 2));
      const j0 = md.count;
      addTube(md, sp, [0.0003, 0.00027, 0.00025, 0.00024, 0.00024], { colorFn: (i) => [[0.32, 0.07, 0.02], [0.38, 0.1, 0.025], [0.44, 0.15, 0.03], [0.5, 0.22, 0.05], [0.52, 0.26, 0.06]][i] });
      pushBase(base, md, j0, apex, 1);
      // the capsule: four-angled, nodding a little, under its golden hairy calyptra
      const top = sp[4];
      const cd = sd.clone().lerp(out, 0.55).normalize();
      const cp = [0, 0.0007, 0.0012, 0.0036, 0.0045, 0.0052].map((t) => top.clone().addScaledVector(cd, t));
      const j1 = md.count;
      addTube(md, cp, [0.00035, 0.0007, 0.00105, 0.001, 0.0006, 0.00005], { colorFn: (i) => (i < 2 ? [0.3, 0.16, 0.05] : [0.5, 0.36, 0.13]) });
      pushBase(base, md, j1, apex, 2);
    } else if (r < 0.52) {
      const j0 = md.count;
      const nb = 7;
      for (let b = 0; b < nb; b++) {
        const az = (b / nb) * TAU + rng.float(-0.2, 0.2);
        const radial = v3(Math.cos(az), 0, Math.sin(az));
        const dir = radial.clone().multiplyScalar(0.62).addScaledVector(UP, 0.78).normalize();
        const side = v3().crossVectors(UP, radial).normalize();
        taperedLeaf(md, apex.clone().addScaledVector(UP, -0.0006), dir, side, 0.0036, 0.0024, [[0.25, 0.06, 0.02], [0.5, 0.16, 0.04], [0.55, 0.24, 0.06]], 0.1);
      }
      pushBase(base, md, j0, apex, 3);
    }
  }
  const geometry = md.build();
  geometry.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 4));
  return { geometry, tips, stems: made };
}

// ── lichens ─────────────────────────────────────────────────

// One reindeer-lichen mat (local, centred on the origin, ground at y = 0): a low, broad, lobed dome with an
// irregular rim that sinks a centimetre into the moss. Its surface becomes thousands of rounded branch-tip
// heads in the cushion shells (see CUSHION_FRAG). Per vertex: position, normal, aOff (the smooth envelope
// normal the shells grow along, so they never cross in the creases), aLich (kind, lobe, height, random).
export function cushionDome(rng, kind, detail = 1) {
  const stellaris = kind === 'stellaris';
  const R = 0.05;
  const H = R * (stellaris ? 0.62 : 0.55);
  const lobes = [];
  const nBig = stellaris ? 26 : 20;
  for (let i = 0; i < nBig * 3; i++) {
    const small = i >= nBig;
    const ph = rng.float(0, TAU);
    const ct = rng.float(0.05, 1);
    const st = Math.sqrt(1 - ct * ct);
    const sz = stellaris ? rng.float(0.28, 0.42) : rng.float(0.25, 0.45);
    lobes.push({ d: v3(st * Math.cos(ph), ct, st * Math.sin(ph)), s: small ? rng.float(0.1, 0.16) : sz, w: small ? 0.4 : 1 });
  }
  const a1 = rng.float(0, TAU);
  const a2 = rng.float(0, TAU);
  const rimR = (ph) => 1 + 0.14 * Math.sin(3 * ph + a1) + 0.08 * Math.sin(5 * ph + a2);
  const dir = v3();
  const shape = (ph, th, out) => {
    dir.set(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
    let bump = 0;
    for (const l of lobes) {
      const a = Math.acos(Math.min(1, dir.dot(l.d)));
      const k = 1 - (a * a) / (l.s * l.s);
      if (k > 0) bump += k * k * l.w;
    }
    const r = 0.84 + 0.16 * Math.min(bump, 1.3);
    const k = rimR(ph);
    out.set(dir.x * R * k * r, dir.y * H * r - 0.01, dir.z * R * k * r);
    return Math.min(bump, 1);
  };
  const SEG = Math.round(40 * Math.min(1, 0.55 + 0.45 * detail));
  const RING = Math.round(12 * Math.min(1, 0.6 + 0.4 * detail));
  const pos = [];
  const nor = [];
  const off = [];
  const lich = [];
  const idx = [];
  const p = v3();
  const pa = v3();
  const pb = v3();
  const e = 1e-3;
  for (let j = 0; j <= RING; j++) {
    const th = Math.max(1e-3, (1 - j / RING) * Math.PI * 0.5 * 1.04);
    for (let i = 0; i <= SEG; i++) {
      const ph = (i / SEG) * TAU;
      const b = shape(ph, th, p);
      shape(ph + e, th, pa);
      shape(ph - e, th, pb);
      const dph = pa.clone().sub(pb);
      shape(ph, th + e, pa);
      shape(ph, th - e, pb);
      const n = v3().crossVectors(dph, pa.clone().sub(pb)).normalize();
      if (n.dot(v3(p.x, p.y + 0.01, p.z)) < 0) n.negate();
      const k = rimR(ph);
      const o = v3(Math.sin(th) * Math.cos(ph) / (R * k), Math.cos(th) / H, Math.sin(th) * Math.sin(ph) / (R * k)).normalize();
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      off.push(o.x, o.y, o.z);
      lich.push(stellaris ? 1 : 0, b, Math.cos(th), 0);
    }
  }
  for (let j = 0; j < RING; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * (SEG + 1) + i;
      const b = a + SEG + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1); // counter-clockwise seen from outside (front faces)
    }
  }
  // height of the mat's outer surface (shells included) at local (x, z), −Infinity outside it
  const topAt = (x, z) => {
    const ph = Math.atan2(z, x);
    const rho = Math.hypot(x, z) / (R * rimR(ph) * 0.92);
    return rho < 1 ? H * 0.92 * Math.sqrt(1 - rho * rho) - 0.01 + MOSS.lichThick * 0.8 : -Infinity;
  };
  return { pos, nor, off, lich, idx, shape, rimR, topAt, R, H, stellaris };
}

// A pale, dichotomously forked sprig (a few podetia leaning out of the mat over the moss), local.
function antler(md, rng, start, dir, len, rad, stellaris, depth = 0) {
  const end = start.clone().addScaledVector(dir, len);
  const tip = depth >= 3;
  const pale = stellaris ? [0.54, 0.54, 0.4] : [0.52, 0.53, 0.5];
  const tipC = stellaris ? [0.56, 0.55, 0.42] : [0.3, 0.23, 0.15];
  addTube(md, [start, end], [rad, tip ? rad * 0.35 : rad * 0.85], {
    radial: 3,
    colorFn: (i) => (tip && i === 1 ? tipC : pale).map((x) => x * (0.78 + 0.22 * Math.min(1, (depth + i) / 3))),
    sway: () => 0.5,
  });
  if (tip) return;
  const side = v3().crossVectors(dir, UP);
  if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
  side.normalize();
  const spread = THREE.MathUtils.degToRad(rng.float(24, 36));
  for (const sg of [-1, 1]) {
    const d = dir.clone().applyAxisAngle(UP, sg * spread).addScaledVector(UP, rng.float(-0.05, 0.25)).normalize();
    antler(md, rng, end, d, len * rng.float(0.58, 0.72), rad * 0.78, stellaris, depth + 1);
  }
}

// A fallen pine needle (sometimes a pair from one sheath) lying over a mat; points in local space.
function pineNeedle(md, rng, pts) {
  const c = rng.chance(0.6) ? [0.32, 0.13, 0.045] : [0.21, 0.14, 0.085];
  const tint = rng.float(0.85, 1.1);
  addTube(md, pts, pts.map((_, i) => 0.00055 * (i === pts.length - 1 ? 0.4 : 1)), { colorFn: () => c.map((x) => x * tint), sway: () => 0 });
}

// Pixie cups (Cladonia pyxidata / chlorophaea), optionally with the scarlet fruit of C. coccifera, on a
// bed of squamules. Local, base at y = 0.
function pixieCups(rng, red) {
  const md = new MeshData();
  const n = rng.int(5, 10);
  const grey = red ? [0.31, 0.35, 0.23] : [0.32, 0.36, 0.28];
  for (let c = 0; c < n; c++) {
    const a = rng.float(0, TAU);
    const r = rng.float(0, 0.011);
    const o = v3(Math.cos(a) * r, -0.001, Math.sin(a) * r);
    const h = rng.float(0.008, 0.016);
    const cupR = rng.float(0.0022, 0.0038);
    const tilt = v3(rng.float(-0.2, 0.2), 1, rng.float(-0.2, 0.2)).normalize();
    // lathe profile (r, y), outside up to the rim, then down into the cup
    const prof = [
      [0.0006, 0],
      [0.0005, h * 0.45],
      [cupR * 0.45, h * 0.78],
      [cupR, h],
      [cupR * 0.82, h * 0.98],
      [cupR * 0.35, h * 0.86],
      [0.0001, h * 0.84],
    ];
    const SEG = 8;
    const i0 = md.count;
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tilt);
    for (let j = 0; j < prof.length; j++) {
      const [pr, py] = prof[j];
      const inner = j >= 4;
      for (let i = 0; i <= SEG; i++) {
        const ph = (i / SEG) * TAU;
        const p = v3(Math.cos(ph) * pr, py, Math.sin(ph) * pr).applyQuaternion(q).add(o);
        const nn = v3(Math.cos(ph) * (inner ? -0.6 : 1), inner ? 1 : 0.3, Math.sin(ph) * (inner ? -0.6 : 1)).normalize().applyQuaternion(q);
        const shade = inner ? 0.7 : 0.85 + 0.15 * (j / 3);
        md.vert(p, nn, i / SEG, j / prof.length, grey.map((x) => x * shade * rng.float(0.92, 1.08)), 0, py / h);
      }
    }
    for (let j = 0; j < prof.length - 1; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = i0 + j * (SEG + 1) + i;
        const b = a + SEG + 1;
        md.idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    if (red) {
      // scarlet apothecia on the rim
      const nr = rng.int(2, 4);
      for (let k = 0; k < nr; k++) {
        const ph = rng.float(0, TAU);
        const c = v3(Math.cos(ph) * cupR, h + 0.0004, Math.sin(ph) * cupR).applyQuaternion(q).add(o);
        const rr = rng.float(0.0009, 0.0014);
        addTube(md, [c.clone().addScaledVector(UP, -rr * 0.6), c.clone().addScaledVector(UP, rr * 0.4), c.clone().addScaledVector(UP, rr * 0.9)], [rr * 0.6, rr, rr * 0.2], { radial: 5, color: [0.5, 0.025, 0.018] });
      }
    }
  }
  // squamules: small grey-green scales around the foot
  const ns = rng.int(7, 12);
  for (let s = 0; s < ns; s++) {
    const a = rng.float(0, TAU);
    const r = rng.float(0.003, 0.011);
    const p = v3(Math.cos(a) * r, 0.0002, Math.sin(a) * r);
    const dir = v3(Math.cos(a), rng.float(0.2, 0.6), Math.sin(a)).normalize();
    const side = v3().crossVectors(UP, dir).normalize();
    taperedLeaf(md, p, dir, side, rng.float(0.0025, 0.004), rng.float(0.0018, 0.003), [[0.22, 0.26, 0.18], [0.3, 0.34, 0.24], [0.34, 0.37, 0.28]], -0.15);
  }
  return md;
}

// Iceland moss (Cetraria islandica): erect, twisted, channelled olive-brown ribbons that fork irregularly,
// reddish at the base. Local, base at y = 0.
function cetraria(rng) {
  const md = new MeshData();
  const strips = []; // vertex index of each cross-section row (3 vertices: margin, channel, margin)
  const ribbon = (p, dir, len, w, depth, twist) => {
    const SEG = 5;
    let side = v3().crossVectors(UP, dir);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    let pp = p.clone();
    let d = dir.clone();
    const curl = rng.float(-0.35, 0.15);
    const forkAt = depth < 2 && rng.chance(depth ? 0.45 : 0.85) ? rng.int(2, 4) : -1;
    const rows = [];
    const forks = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const nrm = v3().crossVectors(d, side).normalize();
      if (nrm.y < 0) nrm.negate();
      const ww = w * (1 - 0.3 * t);
      const base = depth ? 0 : smoothstep(0.3, 0.0, t);
      const c = [0.16 + 0.07 * base, 0.11 - 0.04 * base, 0.045].map((x) => x * rng.float(0.92, 1.08) * (1 - 0.25 * t));
      rows.push(md.count);
      // channelled: the margins roll up, a little lighter
      for (const sgn of [-1, 0, 1]) {
        const q = pp.clone().addScaledVector(side, sgn * ww * 0.5).addScaledVector(nrm, Math.abs(sgn) * ww * 0.32);
        md.vert(q, nrm.clone().addScaledVector(side, -sgn * 0.5).normalize(), (sgn + 1) / 2, t, sgn ? c.map((x) => x * 1.3) : c, 0, t);
      }
      if (i === forkAt) {
        for (const sg of [-1, 1]) forks.push([pp.clone(), d.clone().addScaledVector(side, sg * rng.float(0.35, 0.7)).normalize(), len * (1 - t) * rng.float(0.6, 0.95), ww * 0.75, depth + 1, -twist]);
        break;
      }
      // twist about the ribbon's own axis and curl over
      side = side.applyAxisAngle(d, twist / SEG).normalize();
      d = d.clone().addScaledVector(UP, curl / SEG).addScaledVector(side, rng.float(-0.12, 0.12)).normalize();
      side = side.addScaledVector(d, -side.dot(d)).normalize();
      pp = pp.clone().addScaledVector(d, len / SEG);
    }
    strips.push(rows);
    for (const f of forks) ribbon(...f);
  };
  const n = rng.int(6, 10);
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, TAU);
    const p = v3(Math.cos(a) * rng.float(0, 0.007), -0.002, Math.sin(a) * rng.float(0, 0.007));
    const lean = rng.float(0.25, 0.9);
    ribbon(p, v3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize(), rng.float(0.015, 0.03), rng.float(0.003, 0.0055), 0, rng.float(-1.2, 1.2));
  }
  for (const rows of strips) {
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < 2; j++) {
        const a = rows[i] + j;
        const b = rows[i + 1] + j;
        md.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  return md;
}

// Append a transformed copy of `src` (MeshData) to `dst`, tinting its colours.
function appendMesh(dst, src, m, tint = [1, 1, 1]) {
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const p = v3();
  const n = v3();
  const o = dst.count;
  for (let i = 0; i < src.count; i++) {
    p.fromArray(src.pos, i * 3).applyMatrix4(m);
    n.fromArray(src.nor, i * 3).applyMatrix3(nm).normalize();
    dst.pos.push(p.x, p.y, p.z);
    dst.nor.push(n.x, n.y, n.z);
    dst.uv.push(src.uv[i * 2], src.uv[i * 2 + 1]);
    dst.col.push(src.col[i * 3] * tint[0], src.col[i * 3 + 1] * tint[1], src.col[i * 3 + 2] * tint[2]);
    dst.sway.push(src.sway[i]);
    dst.h.push(src.h[i]);
  }
  for (const k of src.idx) dst.idx.push(k + o);
}

// Bare spots (little or no moss, nobody else's): where pixie cups and Iceland moss grow.
export function bareSpots(n, seed = 3301, minGap = 0.16) {
  const rng = new RNG(seed);
  const out = [];
  const f = {};
  const cand = [];
  for (let i = 0; i < 1600; i++) {
    const [u, v] = samplePoint(rng, 0.8);
    if (!inside(u, v, 0.12)) continue;
    if (clearOther(u, v) < 0.06) continue;
    if (Math.min(spotDist(SPOTS.reindeerLichen1, u, v), spotDist(SPOTS.reindeerLichen2, u, v), spotDist(SPOTS.haircapMoss, u, v)) < 1.25) continue;
    if (antTrailDist(u, v) < 0.05) continue;
    if (CLEARINGS.some((q) => Math.hypot(u - q.u, v - q.v) < q.r + 0.12)) continue;
    mossField(u, v, f);
    cand.push([f.cover + rng.float(0, 0.05), u, v]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  for (const [, u, v] of cand) {
    if (out.length >= n) break;
    if (out.every((q) => Math.hypot(q[0] - u, q[1] - v) > minGap)) out.push([u, v]);
  }
  return out;
}

export function lichenGeometry(tier, seed = 5813) {
  const rng = new RNG(seed);
  const md = new MeshData();
  const tips = [];
  const variants = {
    rangiferina: [0, 1, 2].map(() => cushionDome(rng, 'rangiferina', tier.lichDetail)),
    stellaris: [0, 1].map(() => cushionDome(rng, 'stellaris', tier.lichDetail)),
  };
  const cush = { pos: [], nor: [], off: [], lich: [], idx: [] };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const n = v3();
  const placeLocal = (u, v, scale, yaw, sink, follow = 0.6) => {
    const { x, z } = fromPatch(u, v);
    heroNormalAt(x, z, 0.03, n).lerp(UP, 1 - follow).normalize();
    q.setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    m.compose(v3(x, heroHeightAt(x, z) - sink, z), q, v3(scale, scale, scale));
    return m;
  };
  // cushions: a stellaris-rich carpet at spot 1, mostly rangiferina at spot 2
  const cushions = [];
  const spots = [
    [SPOTS.reindeerLichen1, tier.cushions[0], 0.62],
    [SPOTS.reindeerLichen2, tier.cushions[1], 0.3],
  ];
  for (const [S, count, pStell] of spots) {
    const placed = [];
    for (let tries = 0; tries < 400 && placed.length < count; tries++) {
      const a = rng.float(0, TAU);
      const r = S.r * 0.86 * Math.sqrt(rng.next());
      const u = S.u + Math.cos(a) * r;
      const v = S.v + Math.sin(a) * r;
      const stell = rng.next() < pStell;
      const s = stell ? rng.float(0.7, 1.15) : rng.float(0.8, 1.35);
      const R = 0.05 * s * 1.1;
      if (!inside(u, v, R) || clearOther(u, v) < R + 0.01 || antTrailDist(u, v) < R + MOSS.trailBare + 0.01) continue;
      // mats may run into each other
      if (!placed.every((c) => Math.hypot(c.u - u, c.v - v) > 0.62 * (c.R + R))) continue;
      placed.push({ u, v, R, s, stell });
    }
    cushions.push(...placed);
  }
  const nm = new THREE.Matrix3();
  const tmp = v3();
  for (const c of cushions) {
    const list = c.stell ? variants.stellaris : variants.rangiferina;
    const vr = list[Math.floor(rng.next() * list.length)];
    const mm = placeLocal(c.u, c.v, c.s, rng.float(0, TAU), 0.0, 0.5).clone();
    nm.getNormalMatrix(mm);
    // the mat (cushion shells)
    const o = cush.pos.length / 3;
    const rnd = rng.next();
    for (let i = 0; i < vr.pos.length / 3; i++) {
      tmp.fromArray(vr.pos, i * 3).applyMatrix4(mm);
      cush.pos.push(tmp.x, tmp.y, tmp.z);
      tmp.fromArray(vr.nor, i * 3).applyMatrix3(nm).normalize();
      cush.nor.push(tmp.x, tmp.y, tmp.z);
      tmp.fromArray(vr.off, i * 3).applyMatrix3(nm).normalize();
      cush.off.push(tmp.x, tmp.y, tmp.z);
      cush.lich.push(vr.lich[i * 4], vr.lich[i * 4 + 1], vr.lich[i * 4 + 2], rnd);
    }
    for (const k of vr.idx) cush.idx.push(k + o);
    // forked sprigs fraying out of the rim over the moss
    const sprigs = new MeshData();
    const nA = Math.max(3, Math.round(tier.antlers * (0.8 + 0.4 * rng.next())));
    for (let k = 0; k < nA; k++) {
      const ph = (k / nA) * TAU + rng.float(-0.25, 0.25);
      const th = Math.acos(rng.float(0.35, 0.55));
      const start = v3();
      vr.shape(ph, th, start);
      start.multiplyScalar(0.97);
      const out = v3(Math.cos(ph), rng.float(-0.12, 0.08), Math.sin(ph)).normalize();
      antler(sprigs, rng, start, out, rng.float(0.006, 0.011), 0.00055, vr.stellaris);
    }
    // pine needles lying across the mat
    const nN = tier.lite ? rng.int(0, 1) : rng.int(1, 3);
    for (let k = 0; k < nN; k++) {
      const a = rng.float(0, TAU);
      const r0 = vr.R * rng.float(0, 0.5);
      const dirN = rng.float(0, TAU);
      const L = rng.float(0.04, 0.07);
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = (i / 8 - rng.float(0.3, 0.5)) * L;
        const x = Math.cos(a) * r0 + Math.cos(dirN) * t;
        const z = Math.sin(a) * r0 + Math.sin(dirN) * t;
        pts.push(v3(x, Math.max(vr.topAt(x, z), 0.016), z));
      }
      pineNeedle(sprigs, rng, pts);
      if (rng.chance(0.3)) pineNeedle(sprigs, rng, pts.map((q, i) => q.clone().add(v3(-Math.sin(dirN), 0, Math.cos(dirN)).multiplyScalar(0.0012 * i))));
    }
    appendMesh(md, sprigs, mm);
    // dew on the tip heads
    for (let i = 0; i < 10; i++) {
      const ph = rng.float(0, TAU);
      const th = Math.acos(rng.float(0.7, 1.0));
      const q = v3();
      vr.shape(ph, th, q);
      const ov = v3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      q.addScaledVector(ov, MOSS.lichThick * 0.85).applyMatrix4(mm);
      if (q.y < heroHeightAt(q.x, q.z) + 0.006) continue;
      tips.push({ p: q, n: v3(0, 1, 0), c: c.stell ? [0.55, 0.55, 0.42] : [0.52, 0.53, 0.5], w: 0.6 });
    }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cush.pos, 3));
  cg.setAttribute('normal', new THREE.Float32BufferAttribute(cush.nor, 3));
  cg.setAttribute('aOff', new THREE.Float32BufferAttribute(cush.off, 3));
  cg.setAttribute('aLich', new THREE.Float32BufferAttribute(cush.lich, 4));
  cg.setIndex(cush.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(cush.idx, 1) : new THREE.Uint16BufferAttribute(cush.idx, 1));
  cg.computeBoundingSphere();
  cg.boundingSphere.radius += MOSS.lichThick + 0.005;
  // pixie cups (two groups scarlet-fruited) and Iceland moss: in the clearings first, then on other bare spots
  const sites = [];
  CLEARINGS.forEach((q, i) => {
    const a = rng.float(0, TAU);
    sites.push(['cups', q.u + Math.cos(a) * q.r * 0.25, q.v + Math.sin(a) * q.r * 0.25, i < 2]);
    sites.push(['cetraria', q.u - Math.cos(a) * q.r * 0.45, q.v - Math.sin(a) * q.r * 0.45]);
  });
  const nCups = Math.max(0, tier.cups - CLEARINGS.length);
  const nCet = Math.max(0, tier.cetraria - CLEARINGS.length);
  const bare = bareSpots(nCups + nCet);
  bare.forEach(([u, v], i) => sites.push([i < nCups ? 'cups' : 'cetraria', u, v, false]));
  for (const [kind, u, v, red] of sites) {
    const mm = placeLocal(u, v, rng.float(0.85, 1.15), rng.float(0, TAU), 0.0015, 0.8);
    appendMesh(md, kind === 'cups' ? pixieCups(rng, red) : cetraria(rng), mm);
  }
  // a few Iceland moss tufts among the reindeer lichen
  for (const S of [SPOTS.reindeerLichen1, SPOTS.reindeerLichen2]) {
    for (let k = 0; k < 2; k++) {
      const a = rng.float(0, TAU);
      const u = S.u + Math.cos(a) * S.r * 0.95;
      const v = S.v + Math.sin(a) * S.r * 0.95;
      if (!inside(u, v, 0.04) || clearOther(u, v) < 0.03 || antTrailDist(u, v) < 0.05) continue;
      appendMesh(md, cetraria(rng), placeLocal(u, v, rng.float(0.8, 1.1), rng.float(0, TAU), 0.002, 0.8));
    }
  }
  const geometry = md.build();
  return { geometry, cushionGeometry: cg, tips, cushions: cushions.length, bare: sites.length };
}

// ── dew tips on the shell carpet ────────────────────────────
// The shader's shoot lookup ported to the CPU: at a point, walk the shells from the top and find the first
// one whose shoot is solid there. Where that texel is leafy (toward a branch tip), a drop can sit on it.

const fr = (x) => x - Math.floor(x);
function hash42(x, y) {
  let a = fr(x * 0.1031);
  let b = fr(y * 0.103);
  let c = fr(x * 0.0973);
  let d = fr(y * 0.1099);
  const k = a * (d + 33.33) + b * (c + 33.33) + c * (a + 33.33) + d * (b + 33.33);
  a += k;
  b += k;
  c += k;
  d += k;
  return [fr((a + b) * c), fr((a + c) * b), fr((b + c) * d), fr((c + d) * a)];
}
function mapAt(map, x, z) {
  const { u, v } = toPatch(x, z);
  const fs = clamp((u / (2 * PATCH.halfL) + 0.5) * MAP_W - 0.5, 0, MAP_W - 1.001);
  const ft = clamp((v / (2 * PATCH.halfW) + 0.5) * MAP_H - 0.5, 0, MAP_H - 1.001);
  const i = Math.floor(fs);
  const j = Math.floor(ft);
  const a = fs - i;
  const b = ft - j;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const t = (k) => map[k * 4 + c] / 255;
    const k0 = j * MAP_W + i;
    out[c] = (t(k0) * (1 - a) + t(k0 + 1) * a) * (1 - b) + (t(k0 + MAP_W) * (1 - a) + t(k0 + MAP_W + 1) * a) * b;
  }
  return out;
}
const SP_TINT = [
  [0.36, 0.4, 0.08],
  [0.42, 0.37, 0.09],
  [0.22, 0.3, 0.06],
];

export function shellTips(count, atlas, map, shells, lite = false, seed = 6113) {
  const rng = new RNG(seed);
  const tips = [];
  const f = {};
  const S = atlas.size;
  const N = shells;
  for (let tries = 0; tips.length < count && tries < count * 25; tries++) {
    const [u, v] = samplePoint(rng, 0.8);
    if (mossCover(u, v) < 0.55) continue; // cheap test first
    mossField(u, v, f);
    const pile = f.pile * smoothstep(0.12, 0.7, f.cover);
    const { x, z } = fromPatch(u, v);
    let found = null;
    for (let k = 0; k < N - 1 && !found; k++) {
      const L = N - 1 - k; // shell index, top first; the bottom shell never gets drops
      const lay = L / (N - 1);
      if (lay > pile + 0.12) continue;
      const th = L * 2.39996 + 0.7;
      const ox = L * 17.31;
      const oy = L * -9.73;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const px = (ct * x - st * z) / MOSS.cell + ox;
      const py = (st * x + ct * z) / MOSS.cell + oy;
      const gx = Math.floor(px - 0.5);
      const gy = Math.floor(py - 0.5);
      let key = 0;
      let best = null;
      for (let q = 0; q < 4; q++) {
        const cx = gx + (q & 1);
        const cy = gy + (q >> 1);
        const h = hash42(cx + L * 31.7, cy + L * 31.7);
        const h2 = fr(h[3] * 7.31 + h[0] * 3.17);
        const h3 = fr(h[3] * 13.7 + h[1] * 5.11);
        const reach = pile + (h3 - 0.5) * 0.24;
        if (lay > reach) continue;
        const c0 = cx + 0.5 + (h[0] - 0.5) * 0.4;
        const c1 = cy + 0.5 + (h[1] - 0.5) * 0.4;
        // the candidate's centre back in world space: R(−th) · (c − off) · cell
        const wx = (ct * (c0 - ox) + st * (c1 - oy)) * MOSS.cell;
        const wz = (-st * (c0 - ox) + ct * (c1 - oy)) * MOSS.cell;
        const mp = mapAt(map, wx, wz);
        const sp = h[2] < mp[1] ? 2 : h[2] < mp[1] + mp[0] ? 1 : 0;
        const jit = sp > 1.5 ? 0.45 : sp > 0.5 ? 6.2832 : 5.0;
        const angW = mp[2] * 5 - 0.6 + (h[3] - 0.5) * jit;
        const sc = (lite ? 0.86 : 0.72) + (lite ? 0.14 : 0.28) * h2;
        const aL = -(angW + th);
        const ca = Math.cos(aL);
        const sa = Math.sin(aL);
        const dx = px - c0;
        const dy = py - c1;
        const qx = (ca * dx - sa * dy) / sc;
        const qy = (sa * dx + ca * dy) / sc;
        if (Math.abs(qx) > 0.4 || Math.abs(qy) > 0.8) continue;
        const mir = h3 > 0.5 ? 1 : -1;
        const cell = sp * 2 + (fr(h2 * 3.7) >= 0.5 ? 1 : 0);
        const su = ((cell % 4) + qx * mir * 1.25 + 0.5) * 0.25;
        const sv = (Math.floor(cell / 4) + qy * 0.625 + 0.5) * 0.5;
        const ti = (Math.min(S - 1, Math.floor(sv * S)) * S + Math.min(S - 1, Math.floor(su * S))) * 4;
        const a = atlas.data[ti + 3] / 255;
        const kk = a > 0.42 ? 1 + h2 : a;
        if (kk > key) {
          key = kk;
          best = { a, t: atlas.data[ti] / 255, sp, lay, margin: reach - lay };
        }
      }
      if (best && best.a > 0.42) found = best; // this shell is the one you see here
    }
    // a drop only on a solid, leafy texel of a shell safely inside the carpet
    if (!found || found.a < 0.7 || found.t < 0.58 || found.margin < 0.06) continue;
    const y = heroHeightAt(x, z) + MOSS.base * (0.4 + 0.6 * f.cover) + found.lay * MOSS.pile;
    tips.push({ p: v3(x, y, z), n: v3(0, 1, 0), c: SP_TINT[found.sp], w: Math.abs(u) < 1.45 && Math.abs(v) < 0.62 ? 1 : 0.5 });
  }
  return tips;
}

// ── everything CPU-side for one tier ────────────────────────

const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/** All geometry and instance data for a quality tier (no GPU objects). */
export function buildMossData(quality = {}) {
  const tier = mossTier(quality);
  const atlas = mossAtlas(tier.atlas);
  const map = mossMapData();
  const mask = mossMaskData();
  const shell = shellGeometry(tier.grid);
  const frondGeo = frondGeometry();
  const fronds = placeFronds(tier.fronds, atlas.tips);
  const tuft = tuftGeometry();
  const tufts = placeTufts(tier.tufts, tuft.tips);
  const haircap = haircapGeometry(tier.haircap);
  const lichens = lichenGeometry(tier);

  // dew tips: the 3D shoots, haircap and lichens, topped up with tips on the shell carpet itself;
  // then thinned to the tier's budget with the glide footprint kept first
  let tips = [...fronds.tips, ...tufts.tips, ...haircap.tips, ...lichens.tips];
  tips = tips.concat(shellTips(Math.max(0, tier.tips - tips.length), atlas, map, tier.shells, !!tier.lite));
  if (tips.length > tier.tips) {
    const rng = new RNG(1213);
    tips = tips
      .map((t) => [t.w * rng.next(), t])
      .sort((a, b) => b[0] - a[0])
      .slice(0, tier.tips)
      .map((e) => e[1]);
  }
  for (const t of tips) delete t.w;

  const tris = {
    shells: triCount(shell) * tier.shells,
    fronds: triCount(frondGeo) * fronds.count,
    tufts: triCount(tuft.geometry) * tufts.count,
    haircap: triCount(haircap.geometry),
    lichens: triCount(lichens.geometry) + triCount(lichens.cushionGeometry) * tier.lichShells,
  };
  return { tier, atlas, map, mask, shell, frondGeo, fronds, tuft, tufts, haircap, lichens, tips, tris };
}

/** Fraction of the patch rectangle covered by moss (cover > 0.5) and the mean cover. */
export function mossCoverage(step = 0.02) {
  let n = 0;
  let covered = 0;
  let sum = 0;
  for (let u = -PATCH.halfL + step / 2; u < PATCH.halfL; u += step) {
    for (let v = -PATCH.halfW + step / 2; v < PATCH.halfW; v += step) {
      const c = mossField(u, v).cover;
      n++;
      sum += c;
      if (c > 0.5) covered++;
    }
  }
  return { fraction: covered / n, mean: sum / n };
}

// ════════════════════════════════════════════════════════════
// GPU: textures, shaders, materials, meshes
// ════════════════════════════════════════════════════════════

const NO_LOSS = { value: -1 }; // shells and merged plants never drop out with the season's leaf loss
const NO_SNOW = { value: 0 }; // … and the shells do their own snow

// three's PCF takes 17 shadow-map taps per fragment; for the shell stack (every shell shades) a
// bilinear 2 × 2 tap is plenty (the flyover's tight shadow box is ~2 mm per texel). Swapped in with a
// macro, only if r169's call looks exactly as expected; otherwise three's own shadows are kept.
const SHADOW_CALL = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
const CHEAP_SHADOW_OK = () =>
  (THREE.ShaderChunk.lights_fragment_begin || '').includes(SHADOW_CALL) &&
  (THREE.ShaderChunk.shadowmap_pars_fragment || '').includes('float texture2DCompare( sampler2D depths, vec2 uv, float compare )');
const MOSS_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
float mossShadow(sampler2D sMap, vec2 sSize, float sInt, float sBias, float sRad, vec4 sC) {
  sC.xyz /= sC.w;
  sC.z += sBias;
  if (sC.x < 0.0 || sC.x > 1.0 || sC.y < 0.0 || sC.y > 1.0 || sC.z > 1.0) return 1.0;
  vec2 tc = sC.xy * sSize - 0.5;
  vec2 fr = fract(tc);
  vec2 ts = 1.0 / sSize;
  vec2 b = (floor(tc) + 0.5) * ts;
  float s00 = texture2DCompare(sMap, b, sC.z);
  float s10 = texture2DCompare(sMap, b + vec2(ts.x, 0.0), sC.z);
  float s01 = texture2DCompare(sMap, b + vec2(0.0, ts.y), sC.z);
  float s11 = texture2DCompare(sMap, b + ts, sC.z);
  return mix(1.0, mix(mix(s00, s10, fr.x), mix(s01, s11, fr.x), fr.y), sInt);
}
#endif
void main() {`;

function cheapShadows(sh) {
  if (!CHEAP_SHADOW_OK()) return;
  sh.fragmentShader = sh.fragmentShader
    .replace('void main() {', MOSS_SHADOW)
    .replace('#include <lights_fragment_begin>', '#define getShadow mossShadow\n#include <lights_fragment_begin>\n#undef getShadow');
}

// Shared by the shells and the 3D cards: atlas, season, palette.
const MOSS_COMMON = /* glsl */ `
uniform sampler2D tMossAtlas;
uniform vec4 uAtlas;   // x: atlas texels per shell cell unit, y: atlas size
uniform vec4 uMossS;   // x: fresh growth, y: wet (dew), z: snow, w: summer dryness
uniform vec4 uMossK;   // x: depth darkening, y: normal strength, z: sheen (Lambert), w: 1 = lite (phones)
float mSheen = 0.0;
float mSnow = 0.0;     // 0 … 1 snow over this fragment (buried or dusted)
float mSnowTone = 1.0; // the snow crust's grain brightness
vec2 mRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
#ifdef MOSS_SNOW
vec2 mSnowSlope = vec2(0.0); // the snow crust's slope (world x, z) from floorSnowSurf
// The floor's snow on something hM metres above heroHeightAt at world xz, seen with a pixel footprint foot (m);
// open = how open it is to the sky (up-ness² × openness). All of it is the floor's shared snow GLSL, so moss
// and floor match exactly: lying snow (floorSnowLieAt: ragged, granular, clumps past its edge) and the dusting
// (floorSnowDustAt), and the crust's tone and slope (floorSnowSurf). Returns (cover, lying, tone).
vec3 mossSnow(vec2 xz, float hM, float foot, float open) {
  float lie = floorSnowLieAt(xz, hM, foot);
  float dust = floorSnowDustAt(xz, floorSnowAt(xz).z, open, foot) * 0.9;
  vec3 surf = floorSnowSurf(xz, foot);
  mSnowSlope = surf.yz;
  return vec3(max(lie, dust), lie, surf.x);
}
#endif
// Albedo (linear) from the atlas tissue value; sp: 0 Pleurozium, 1 Hylocomium, 2 Dicranum.
vec3 mossAlbedo(float sp, float t, float rnd, float dry, float hollow, float fresh) {
  vec3 w = vec3(step(sp, 0.5), step(0.5, sp) * step(sp, 1.5), step(1.5, sp));
  vec3 stem = mat3(vec3(0.34, 0.06, 0.02), vec3(0.3, 0.085, 0.025), vec3(0.11, 0.075, 0.035)) * w;
  vec3 lo = mat3(vec3(0.1, 0.1, 0.025), vec3(0.12, 0.095, 0.028), vec3(0.06, 0.085, 0.02)) * w;
  vec3 mid = mat3(vec3(0.27, 0.3, 0.06), vec3(0.33, 0.29, 0.07), vec3(0.15, 0.22, 0.042)) * w;
  vec3 hi = mat3(vec3(0.44, 0.47, 0.1), vec3(0.52, 0.44, 0.11), vec3(0.28, 0.36, 0.07)) * w;
  vec3 leaf = mix(mix(lo, mid, smoothstep(0.18, 0.62, t)), hi, smoothstep(0.6, 1.0, t));
  // early summer: this year's shoots, bright yellow-green
  leaf = mix(leaf, leaf * vec3(1.12, 1.3, 1.05) + vec3(0.02, 0.04, 0.0), fresh * smoothstep(0.7, 1.0, t));
  vec3 c = mix(stem, leaf, smoothstep(0.1, 0.2, t));
  // every shoot a little different: brighter or darker, yellower or greener
  float hue = fract(rnd * 7.31) - 0.5;
  c *= (0.8 + 0.4 * rnd) * vec3(1.0 + 0.16 * hue, 1.0, 1.0 - 0.3 * hue);
  // hummock tops dry out golden-brown and paler; damp hollows stay dark and deep green
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(lum) * vec3(1.55, 1.25, 0.55) * 1.1, dry * 0.55);
  return mix(c, c * vec3(0.72, 0.8, 0.66), hollow);
}`;

// ── shells ──────────────────────────────────────────────────

const SHELL_VERT_PARS = /* glsl */ `
attribute vec4 aMossA;   // cover, pile (0 … 1), dry, hollow
uniform vec4 uShell;     // x: shells drawn, y: pile height (m), z: base offset (m), w: 1 = far (one layer)
varying vec4 vMossA;
varying vec3 vMossW;
varying vec3 vMossN;
varying vec2 vLayer;     // x: 0 base … 1 top, y: shell index`;

const SHELL_VERT = /* glsl */ `
{
  // instance 0 is the top shell: drawn first, so the shells below fail the depth test where it is solid
  float sIdx = uShell.x - 1.0 - float(gl_InstanceID);
  float sLay = uShell.x > 1.5 ? sIdx / (uShell.x - 1.0) : 0.0;
  float sH = uShell.z * (0.4 + 0.6 * aMossA.x) + (uShell.w > 0.5 ? aMossA.y * uShell.y * 0.7 : sLay * uShell.y);
  transformed += objectNormal * sH;
  vMossA = aMossA;
  vLayer = vec2(sLay, sIdx);
  vMossN = normalize(objectNormal);
}`;

const SHELL_FRAG_PARS = /* glsl */ `
${HASH_GLSL}
${MOSS_COMMON}
#define MOSS_CELL ${MOSS.cell.toFixed(4)}
uniform sampler2D tMossMap;
uniform sampler2D tMossMask;
uniform vec4 uShell;
uniform vec4 uPatchA;    // patch centre x, z, u axis x, z
uniform vec4 uPatchB;    // v axis x, z, 1 / (2 halfL), 1 / (2 halfW)
varying vec4 vMossA;
varying vec3 vMossW;
varying vec3 vMossN;
varying vec2 vLayer;
vec3 mNormalW = vec3(0.0, 1.0, 0.0);
vec4 hash42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
vec2 mPatchUv(vec2 w) {
  vec2 d = w - uPatchA.xy;
  return vec2(dot(d, uPatchA.zw) * uPatchB.z, dot(d, uPatchB.xy) * uPatchB.w) + 0.5;
}`;

// Before three's map_fragment: the shell's shoots, colour, alpha and normal.
const SHELL_FRAG = /* glsl */ `
{
  float mLay = vLayer.x;
  float mL = vLayer.y;
  // cover per centimetre from the mask (the ant corridor and ragged edges are finer than the shell grid)
  float mCover = textureLod(tMossMask, mPatchUv(vMossW.xz), 0.0).r;
  float mPile = vMossA.y * smoothstep(0.12, 0.7, mCover);
  bool mFar = uShell.w > 0.5;
  // every shell has its own field of shoots in a rotated, shifted grid of cells
  float mTh = mL * 2.39996 + 0.7;
  vec2 mOff = vec2(mL * 17.31, mL * -9.73);
  vec2 mP = mRot(vMossW.xz / MOSS_CELL, mTh) + mOff;
  vec2 mDx = dFdx(mP);
  vec2 mDy = dFdy(mP);
  float mFoot = max(length(mDx), length(mDy)) * MOSS_CELL; // world size of a pixel (m)
  vec2 mTq = mRot(vMossW.xz, 0.37) * vec2(1.0 / 0.032, 1.0 / 0.064) * (uMossK.w > 0.5 ? 0.7 : 1.0);
  vec2 mTdx = dFdx(mTq) * vec2(0.25, 0.5);
  vec2 mTdy = dFdy(mTq) * vec2(0.25, 0.5);
  // nothing here, or this shell floats above the carpet
  if (mCover < 0.015 || (!mFar && mLay > mPile + 0.12)) discard;

  float mLod = 0.5 * log2(max(max(dot(mDx, mDx), dot(mDy, mDy)) * uAtlas.x * uAtlas.x, 1e-8));
  vec2 mG0 = floor(mP - 0.5);
  vec4 mBest = vec4(0.5, 0.5, 0.5, 0.0);
  float mKey = 0.0;
  float mSp = 0.0;
  float mAng = 0.0;
  float mMir = 1.0;
  float mRnd = 0.5;
  float mA = 0.0;
  bool mLite = uMossK.w > 0.5;
  // lite: the bottom shell skips the shoot lookup and only shows the textured carpet surface
  bool mCheapBase = mLite && !mFar && mLay < 0.001;
  for (int k = 0; k < 4; k++) {
    if (mCheapBase) break;
    vec2 cid = mG0 + vec2(float(k & 1), float(k >> 1));
    vec4 h = hash42(cid + mL * 31.7);
    float h2 = fract(h.w * 7.31 + h.x * 3.17);
    float h3 = fract(h.w * 13.7 + h.y * 5.11);
    // shoots near the carpet top come and go one by one, not as a sheet
    if (!mFar && mLay > mPile + (h3 - 0.5) * 0.24) continue;
    vec2 c = cid + 0.5 + (h.xy - 0.5) * 0.4;
    // species and lying direction from the moss map at the shoot's own centre
    vec4 mp = textureLod(tMossMap, mPatchUv(mRot(c - mOff, -mTh) * MOSS_CELL), 0.0);
    float sp = h.z < mp.g ? 2.0 : (h.z < mp.g + mp.r ? 1.0 : 0.0);
    float jit = sp > 1.5 ? 0.45 : (sp > 0.5 ? 6.2832 : 5.0);
    float angW = mp.b * 5.0 - 0.6 + (h.w - 0.5) * jit;
    float sc = mix(mLite ? 0.86 : 0.72, 1.0, h2);
    float aL = -(angW + mTh);
    float ca = cos(aL);
    float sa = sin(aL);
    vec2 d = mP - c;
    vec2 q = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) / sc;
    if (abs(q.x) > 0.4 || abs(q.y) > 0.8) continue;
    float mir = h3 > 0.5 ? 1.0 : -1.0;
    float cell = sp * 2.0 + step(0.5, fract(h2 * 3.7));
    vec2 st = vec2(q.x * mir * 1.25 + 0.5, q.y * 0.625 + 0.5);
    vec2 auv = (vec2(mod(cell, 4.0), floor(cell * 0.25)) + st) * vec2(0.25, 0.5);
    float kk = 0.3125 / sc;
    vec2 gx = vec2(ca * mDx.x - sa * mDx.y, sa * mDx.x + ca * mDx.y) * kk;
    vec2 gy = vec2(ca * mDy.x - sa * mDy.y, sa * mDy.x + ca * mDy.y) * kk;
    vec4 t = textureGrad(tMossAtlas, auv, gx, gy);
    float key = t.a > 0.42 ? 1.0 + h2 : t.a;
    mA = max(mA, t.a);
    if (key > mKey) {
      mKey = key;
      mBest = t;
      mSp = sp;
      mAng = angW;
      mMir = mir;
      mRnd = h3;
    }
  }
  float mSolid = 0.0;
  vec4 tt = vec4(0.5, 0.5, 0.5, 0.0);
  if (mFar || mLay < 0.001) {
    // the bottom shell is the old, matted carpet: solid inside, fraying into loose strands at the edge
    tt = textureGrad(tMossAtlas, (vec2(3.0, 1.0) + fract(mTq)) * vec2(0.25, 0.5), mTdx, mTdy);
    // lite has no MSAA: a wider ramp that the dither below turns into a soft, broken edge
    mSolid = mLite ? smoothstep(0.25, 0.8, mCover + (tt.a - 0.35) * 0.45) : smoothstep(0.42, 0.62, mCover + (tt.a - 0.35) * 0.35);
  }
  float mAlpha = max(mA * (1.0 + (mLite ? 0.3 : 0.16) * max(mLod - 1.0, 0.0)) * smoothstep(0.05, 0.3, mCover), mSolid);
  float mTis = mBest.r;
  vec2 mNl = (mBest.gb * 2.0 - 1.0) * vec2(mMir, 1.0);
  if (mKey < 1.0 && mSolid > 0.0) {
    // lite: the base is the carpet's own surface (the shoots' colour family), not the dark old layer
    mTis = mLite ? mix(0.42, tt.r, tt.a) : mix(0.24, 0.2 + 0.25 * tt.r, tt.a);
    mNl = (tt.gb * 2.0 - 1.0) * tt.a;
    mAng = -0.37;
    mSp = 0.0;
    mRnd = 0.4;
  }
  float mDepth = mFar ? 0.002 : max(mPile - mLay, 0.0) * uShell.y * (mCheapBase ? 0.3 : (mLite ? 0.5 : 1.0));
  float mOld = (1.0 - exp(-mDepth / 0.013)) * uMossK.x;
  float mDry = clamp(vMossA.z + uMossS.w, 0.0, 1.0) * (1.0 - smoothstep(0.004, 0.02, mDepth));
  vec3 mCol = mossAlbedo(mSp, mTis, mRnd, mDry, vMossA.w, uMossS.x);
  mCol = mix(mCol, vec3(0.085, 0.065, 0.032) * (0.8 + 0.4 * mRnd), mOld * 0.75);
  mCol *= mix(1.0, 0.2 + 0.8 * exp(-mDepth / 0.012), uMossK.x);
  mCol *= 1.0 - 0.1 * uMossS.y;
  // lite base: slow brightness drift so the carpet is not one flat tone
  if (mCheapBase) mCol *= 0.78 + 0.44 * textureLod(tMossMap, mPatchUv(vMossW.xz), 0.0).a;
  float mNz = sqrt(max(1.0 - dot(mNl, mNl), 0.0));
  vec2 mNr = mRot(mNl, mAng);
  vec3 mBase = normalize(vMossN);
  mNormalW = normalize(mBase * mNz + vec3(mNr.x, 0.0, mNr.y) * uMossK.y);
  mSheen = (1.0 - mOld) * smoothstep(0.25, 0.7, mTis);
  // winter: the floor's own snow field (bound by setSnowField), so moss and floor agree exactly
#ifdef MOSS_SNOW
  if (uSnowK.x > 0.001) {
    float hM = uShell.z * (0.4 + 0.6 * vMossA.x) + (mFar ? mPile * 0.7 : mLay) * uShell.y;
    float open = mNormalW.y * mNormalW.y * (0.45 + 0.55 * (1.0 - mOld)); // tips up, open to the sky; less deep down
    vec3 sn = mossSnow(vMossW.xz, hM, mFoot, open);
    mSnow = sn.x;
    mSnowTone = sn.z;
    // where snow lies over this shell its shoots (and the old mat below) carry the crust: its undulation and grain
    mNormalW = normalize(mix(mNormalW, normalize(mBase + vec3(mSnowSlope.x, 0.0, mSnowSlope.y)), sn.y));
  }
#endif
  diffuseColor.rgb = mCol;
#ifndef ALPHA_TO_COVERAGE
  // no MSAA: dither the alpha so edges dissolve instead of cutting out
  mAlpha = clamp(mAlpha + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.5, 0.0, 1.0);
#endif
  diffuseColor.a = mAlpha;
}`;

// After the season tint (three's color_fragment slot): snow and the translucency mask under it.
const SNOW_FRAG = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.77, 0.82) * mSnowTone, mSnow);
sSnowMask = max(sSnowMask, mSnow);
mSheen *= 1.0 - max(mSnow, sSnowMask);`;

// Snow is translucent: sunlight wraps past the terminator, cool and blue-ish (the floor's FLOOR_LIGHT, SSS 0.8).
const SNOW_LIGHT = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
if (mSnow > 0.01) {
  float sNL = dot(normal, directLight.direction);
  float sWrap = max((sNL + 0.45) / 1.45, 0.0) - max(sNL, 0.0);
  reflectedLight.directDiffuse += directLight.color * sWrap * BRDF_Lambert(diffuseColor.rgb) * vec3(0.7, 0.88, 1.0) * (mSnow * 0.8);
}
#endif`;

// A broad glossy highlight on the leaves (Lambert tiers; added to the diffuse sum, which Lambert outputs).
const SHEEN_LIGHT = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  vec3 mHv = normalize(directLight.direction + geometryViewDir);
  float mNH = max(dot(normal, mHv), 0.0);
  float mNL = max(dot(normal, directLight.direction), 0.0);
  reflectedLight.directDiffuse += directLight.color * (mSheen * uMossK.z * (0.6 + 0.8 * uMossS.y) * mNL * pow(mNH, 24.0));
}
#endif`;

const ROUGH_FRAG = 'float roughnessFactor = mix(mix(0.93, 0.75, mSheen * (0.4 + 0.6 * uMossS.y)), 0.56, mSnow);'; // never glossy: wet moss, not plastic

function mossBaseMaterial(pbr, { side, a2c }) {
  const Mat = pbr ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial;
  const mat = new Mat({ side, alphaTest: 0.5, alphaToCoverage: a2c });
  if (pbr) {
    mat.roughness = 0.88;
    mat.metalness = 0;
  }
  return mat;
}

// The floor's snow field, once setSnowField has bound it: its GLSL and the very same uniform objects.
function bindSnow(sh, U) {
  if (!U.snow) return '';
  Object.assign(sh.uniforms, U.snow.uniforms);
  return `#define MOSS_SNOW\n${U.snow.glsl}\n`;
}

function shellMaterial(U, { pbr, a2c }) {
  const mat = mossBaseMaterial(pbr, { side: THREE.FrontSide, a2c });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U.shell);
    const snow = bindSnow(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${SHELL_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SHELL_VERT}`)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvMossW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${snow}${SHELL_FRAG_PARS}`)
      .replace('#include <map_fragment>', `${SHELL_FRAG}\n#include <map_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SNOW_FRAG}`)
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(mNormalW, 0.0)).xyz);')
      .replace('#include <roughnessmap_fragment>', ROUGH_FRAG)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${pbr ? '' : SHEEN_LIGHT}${snow ? SNOW_LIGHT : ''}`);
    cheapShadows(sh);
    injectFoliage(sh, { power: 4 });
    injectSeason(sh, 'moss');
    sh.uniforms.uSLoss = NO_LOSS;
    sh.uniforms.uSSnow = NO_SNOW;
  };
  mat.customProgramCacheKey = () => `moss-shell-${pbr ? 'pbr' : 'lam'}-${CHEAP_SHADOW_OK() ? 'cs' : 'ts'}-${U.snow ? 'snow' : 'dry'}`;
  return mat;
}

// ── 3D cards (fronds and Dicranum tufts) ────────────────────

const CARD_VERT_PARS = /* glsl */ `
attribute vec3 aTan;
attribute float aH;
attribute vec4 aFrond;   // per instance: atlas cell, mirror (±1), random, dry − hollow
attribute float aFrondG; // per instance: heroHeightAt under the card's anchor (m)
varying vec4 vFr;
varying vec2 vUvM;
varying vec3 vTanV;
varying float vFrH;
varying vec4 vFrW;       // world position, height above heroHeightAt`;

const CARD_VERT = /* glsl */ `
vFr = aFrond;
vUvM = uv;
vFrH = aH;
#ifdef USE_INSTANCING
  vTanV = normalize(mat3(modelViewMatrix) * (mat3(instanceMatrix) * aTan));
  vFrW.xyz = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vTanV = normalize(mat3(modelViewMatrix) * aTan);
  vFrW.xyz = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
vFrW.w = vFrW.y - aFrondG;`;

const CARD_FRAG_PARS = /* glsl */ `
${MOSS_COMMON}
varying vec4 vFr;
varying vec2 vUvM;
varying vec3 vTanV;
varying float vFrH;
varying vec4 vFrW;
vec3 mNormalV = vec3(0.0, 0.0, 1.0);`;

const CARD_FRAG = /* glsl */ `
{
  float cell = vFr.x;
  bool mirr = vFr.y < 0.0;
  vec2 st = clamp(vec2(mirr ? 1.0 - vUvM.x : vUvM.x, vUvM.y), 0.01, 0.99);
  vec2 auv = (vec2(mod(cell, 4.0), floor(cell * 0.25)) + st) * vec2(0.25, 0.5);
  vec4 t = texture(tMossAtlas, auv);
  vec2 ddx = dFdx(auv) * uAtlas.y;
  vec2 ddy = dFdy(auv) * uAtlas.y;
  vec2 fwx = dFdx(vFrW.xz);
  vec2 fwy = dFdy(vFrW.xz);
  float lod = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-8));
  float sp = cell < 1.5 ? 0.0 : (cell < 3.5 ? 1.0 : 2.0);
  float dry = clamp(max(vFr.w, 0.0) + uMossS.w, 0.0, 1.0);
  vec3 col = mossAlbedo(sp, t.r, vFr.z, dry, max(-vFr.w, 0.0), uMossS.x);
  // the base of a shoot dives into the carpet's shade
  col *= mix(0.55, 1.0, smoothstep(0.02, 0.45, vFrH));
  col *= 1.0 - 0.1 * uMossS.y;
  diffuseColor.rgb = col;
  diffuseColor.a = t.a * (1.0 + 0.16 * max(lod - 1.0, 0.0));
#ifndef ALPHA_TO_COVERAGE
  diffuseColor.a = clamp(diffuseColor.a + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.4, 0.0, 1.0);
#endif
  vec2 nl = (t.gb * 2.0 - 1.0) * vec2(mirr ? -1.0 : 1.0, 1.0) * uMossK.y;
  float nz = sqrt(max(1.0 - dot(nl, nl), 0.05));
  vec3 N = normalize(vNormal);
  vec3 T = normalize(vTanV - N * dot(vTanV, N));
  vec3 B = cross(T, N);
  mNormalV = normalize(T * nl.x + B * nl.y + N * nz);
  mSheen = smoothstep(0.25, 0.7, t.r) * smoothstep(0.2, 0.6, vFrH);
#ifdef MOSS_SNOW
  if (uSnowK.x > 0.001) {
    // a frond catches only scattered tufts: on its upper, sky-facing surface (the real shading normal), not on
    // its shaded lower half or the thin pinna edges
    float up = max((vec4(mNormalV, 0.0) * viewMatrix).y, 0.0);
    float open = up * up * 0.5 * smoothstep(0.2, 0.7, vFrH) * smoothstep(0.008, 0.03, vFrW.w) * smoothstep(0.5, 0.9, t.a);
    vec3 sn = mossSnow(vFrW.xz, vFrW.w, max(length(fwx), length(fwy)), open);
    mSnow = sn.x;
    mSnowTone = sn.z;
    vec3 crustV = normalize((viewMatrix * vec4(normalize(vec3(mSnowSlope.x, 1.0, mSnowSlope.y)), 0.0)).xyz);
    mNormalV = normalize(mix(mNormalV, crustV, sn.y));
  }
#endif
}`;

function cardMaterial(U, { pbr, a2c, cheap }) {
  const mat = mossBaseMaterial(pbr, { side: THREE.DoubleSide, a2c });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U.card);
    const snow = bindSnow(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CARD_VERT}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${snow}${CARD_FRAG_PARS}`)
      .replace('#include <map_fragment>', `${CARD_FRAG}\n#include <map_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SNOW_FRAG}`)
      .replace('#include <normal_fragment_maps>', 'normal = mNormalV;')
      .replace('#include <roughnessmap_fragment>', ROUGH_FRAG)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${pbr ? '' : SHEEN_LIGHT}${snow ? SNOW_LIGHT : ''}`);
    if (cheap) cheapShadows(sh);
    injectFoliage(sh, { power: 4 });
    injectSeason(sh, 'moss');
    sh.uniforms.uSSnow = NO_SNOW; // snow comes from the floor's field (mossSnow), not a blanket tint
  };
  mat.customProgramCacheKey = () => `moss-card-${pbr ? 'pbr' : 'lam'}-${cheap && CHEAP_SHADOW_OK() ? 'cs' : 'ts'}-${U.snow ? 'snow' : 'dry'}`;
  // shadow pass: the same atlas alpha and the same seasonal drop-out
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.tMossAtlas = U.card.tMossAtlas;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFrond;\nvarying vec4 vFr;\nvarying vec2 vUvM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFr = aFrond;\nvUvM = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tMossAtlas;\nvarying vec4 vFr;\nvarying vec2 vUvM;')
      .replace(
        '#include <alphatest_fragment>',
        /* glsl */ `{
  vec2 st = clamp(vec2(vFr.y < 0.0 ? 1.0 - vUvM.x : vUvM.x, vUvM.y), 0.01, 0.99);
  if (texture(tMossAtlas, (vec2(mod(vFr.x, 4.0), floor(vFr.x * 0.25)) + st) * vec2(0.25, 0.5)).a < 0.5) discard;
}`,
      );
    injectSeason(sh, 'moss', { depth: true });
  };
  depth.customProgramCacheKey = () => 'moss-card-depth';
  mat.userData.depth = depth;
  return mat;
}

// ── haircap and lichens: vertex-coloured plants ─────────────

const HAIR_VERT_PARS = /* glsl */ `
attribute vec4 aBase;    // xyz: the shoot apex this part grows from, w: kind
uniform vec4 uHair;      // x: setae grown, y: capsules ripe, z: male cups open
varying float vHairK;`;

const HAIR_VERT = /* glsl */ `
{
  float hk = aBase.w;
  float hg = hk > 2.5 ? uHair.z : (hk > 0.5 ? uHair.x : 1.0);
  transformed = mix(aBase.xyz, transformed, hg);
  vHairK = hk;
}`;

// Lichen grain: branch tips packed ~1.6 mm apart, bright tips and dark gaps (fades out with distance).
const GRAIN_VERT_PARS = /* glsl */ `
attribute float aSway;   // grain weight: 1 dome, 0.5 branches, 0 elsewhere
varying vec3 vLWP;
varying vec3 vLWN;
varying float vLGrain;`;
const GRAIN_VERT = /* glsl */ `
vLWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vLWN = normalize(mat3(modelMatrix) * objectNormal);
vLGrain = aSway;`;
const GRAIN_FRAG_PARS = /* glsl */ `
${HASH_GLSL}
varying vec3 vLWP;
varying vec3 vLWN;
varying float vLGrain;`;
const GRAIN_FRAG = /* glsl */ `
{
  // two scales of Worley cells: small heads of branchlets (~4 mm) and their tips (~1.4 mm); the cell
  // borders (F2 − F1 small) are the dark gaps between them
  vec3 gn = abs(normalize(vLWN));
  vec2 gp = gn.y > max(gn.x, gn.z) ? vLWP.xz : (gn.x > gn.z ? vLWP.zy : vLWP.xy);
  vec2 gq = gp / 0.0014;
  vec2 gw = fwidth(gq);
  float gFade = vLGrain * (1.0 - smoothstep(0.45, 1.2, max(gw.x, gw.y)));
  float gHeads = 1.0;
  float gTips = 1.0;
  if (vLGrain > 0.01) {
    for (int s = 0; s < 2; s++) {
      vec2 q = s == 0 ? gp / 0.0045 + 7.3 : gq;
      vec2 gi = floor(q);
      vec2 gf = fract(q);
      float f1 = 8.0;
      float f2 = 8.0;
      vec2 id = gi;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y));
          float d = length(g + hash22(gi + g) - gf);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = gi + g;
          } else {
            f2 = min(f2, d);
          }
        }
      }
      float r = hash12(id + 3.1); // every head and tip its own size and tone
      if (s == 0) gHeads = smoothstep(0.0, 0.22, f2 - f1) * (0.75 + 0.25 * smoothstep(1.0, 0.1, f1)) * (0.85 + 0.3 * r);
      else gTips = smoothstep(0.62 + 0.25 * r, 0.12, f1) * (0.7 + 0.5 * r);
    }
  }
  float gHeadFade = vLGrain * (1.0 - smoothstep(0.45, 1.2, max(gw.x, gw.y) * 0.33));
  diffuseColor.rgb *= mix(1.0, mix(0.45, 1.05, gHeads), gHeadFade);
  diffuseColor.rgb *= mix(1.0, mix(0.3, 1.12, gTips), gFade);
}`;

function plantMaterial(U, { pbr, season, trans, key, hair = false, grain = false }) {
  const Mat = pbr ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial;
  const mat = new Mat({ vertexColors: true, side: THREE.DoubleSide });
  if (pbr) {
    mat.roughness = 0.9;
    mat.metalness = 0;
  }
  const uTrans = { value: new THREE.Vector3(...trans) };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTrans = uTrans;
    if (hair) {
      sh.uniforms.uHair = U.uHair;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${HAIR_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${HAIR_VERT}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uHair;\nvarying float vHairK;')
        // ripe capsules lose the golden calyptra and turn brown
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vHairK > 1.5 && vHairK < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.1, 0.045), uHair.y);');
    }
    if (grain) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${GRAIN_VERT_PARS}`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>\n${GRAIN_VERT}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${GRAIN_FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${GRAIN_FRAG}`);
    }
    injectFoliage(sh, { power: 3 });
    injectSeason(sh, season);
    sh.uniforms.uSLoss = NO_LOSS;
  };
  mat.customProgramCacheKey = () => `moss-plant-${key}-${pbr ? 'pbr' : 'lam'}${grain ? '-grain' : ''}`;
  return mat;
}

// ── reindeer-lichen mats: shells of rounded branch-tip heads ──

const CUSHION_VERT_PARS = /* glsl */ `
attribute vec4 aLich;    // kind (0 rangiferina, 1 stellaris), lobe, height on the mat (0 rim … 1 top), random
attribute vec3 aOff;     // the direction the shells grow (smooth envelope normal)
uniform vec4 uLichS;     // x: shells drawn, y: shell depth (m), z: wet, w: snow
varying vec4 vLich;
varying vec3 vCWP;
varying vec3 vCWN;
varying float vCLay;`;

const CUSHION_VERT = /* glsl */ `
{
  float cIdx = uLichS.x - 1.0 - float(gl_InstanceID);   // top shell first
  vCLay = uLichS.x > 1.5 ? cIdx / (uLichS.x - 1.0) : 0.0;
  transformed += aOff * vCLay * uLichS.y;
  vLich = aLich;
}`;

const CUSHION_FRAG_PARS = /* glsl */ `
${HASH_GLSL}
uniform vec4 uLichS;
varying vec4 vLich;
varying vec3 vCWP;
varying vec3 vCWN;
varying float vCLay;
vec3 cNormalW = vec3(0.0, 1.0, 0.0);
float cSnow = 0.0;
// Worley F1 and the vector from the nearest feature point to p
vec3 cCell(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  float d1 = 8.0;
  vec2 v1 = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + hash22(i + g) - f;
      float d = dot(r, r);
      if (d < d1) {
        d1 = d;
        v1 = r;
      }
    }
  }
  return vec3(sqrt(d1), -v1);
}`;

// The mat's surface as a heightfield of rounded heads (clusters of branchlets, 4.5–6 mm) carrying rounded
// tips (1.4–1.7 mm); each shell keeps what reaches its height. Pale, with a faint lilac-grey cast deep down.
const CUSHION_FRAG = /* glsl */ `
{
  float lay = vCLay;
  vec3 n = normalize(vCWN);
  vec3 an = abs(n);
  vec2 p = vCWP.xz;
  vec3 T = vec3(1.0, 0.0, 0.0);
  vec3 B = vec3(0.0, 0.0, 1.0);
  if (an.x > an.y && an.x > an.z) {
    p = vCWP.zy;
    T = vec3(0.0, 0.0, 1.0);
    B = vec3(0.0, 1.0, 0.0);
  } else if (an.z > an.y) {
    p = vCWP.xy;
    B = vec3(0.0, 1.0, 0.0);
  }
  bool stell = vLich.x > 0.5;
  vec2 q1 = p / (stell ? 0.0058 : 0.0045) + vLich.w * 37.0;
  vec2 q2 = p / (stell ? 0.0017 : 0.0014) + 7.3;
  vec2 w2 = fwidth(q2);
  float fine = 1.0 - smoothstep(0.35, 0.9, max(w2.x, w2.y)); // tips still resolvable?
  vec3 c1 = cCell(q1);
  vec3 c2 = cCell(q2);
  float hHead = sqrt(max(0.0, 1.0 - c1.x * c1.x * 2.3));
  float hTip = mix(0.72, sqrt(max(0.0, 1.0 - c2.x * c2.x * 3.0)), fine);
  float hgt = hHead * (0.5 + 0.5 * hTip);
  float cA = lay > 0.001 ? clamp(0.5 + (hgt - lay) / max(fwidth(hgt) * 1.5, 0.02), 0.0, 1.0) : 1.0;
  float rnd = hash12(floor(q1 - c1.yz) + 1.7); // per head
  vec3 col = (stell ? vec3(0.58, 0.58, 0.44) : vec3(0.56, 0.57, 0.54)) * (0.9 + 0.2 * rnd);
  // deeper in the mat: somewhat darker, a faint lilac-grey, never slate
  float deep = 1.0 - lay;
  col *= mix(1.0, 0.5, deep * deep);
  col = mix(col, col * vec3(0.92, 0.88, 1.06), deep);
  // rangiferina: the highest tips turn brown
  if (!stell) col = mix(col, vec3(0.32, 0.24, 0.15), smoothstep(0.8, 0.96, lay) * smoothstep(0.8, 0.97, hTip) * fine * 0.85);
  // the rim sinks into the moss shade; lobe tops a little brighter
  col *= (0.62 + 0.38 * smoothstep(0.0, 0.4, vLich.z)) * (0.92 + 0.12 * vLich.y);
  // wet: greener, softer, a little darker
  col *= mix(vec3(1.0), vec3(0.84, 0.95, 0.8), uLichS.z);
  cSnow = uLichS.w * smoothstep(0.35, 0.75, n.y) * smoothstep(0.1, 0.8, lay + 0.25);
  diffuseColor.rgb = col;
#ifndef ALPHA_TO_COVERAGE
  cA = clamp(cA + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.4, 0.0, 1.0);
#endif
  diffuseColor.a = cA;
  // heads and tips bulge out of the mat
  vec2 bv = c1.yz * 0.9 * step(0.001, hHead) + c2.yz * 0.7 * fine;
  cNormalW = normalize(n + (T * bv.x + B * bv.y) * 1.1);
}`;

// Light scatters through the loose branch tips: a soft wrap and a little all-round glow, so the shade side
// stays pale.
const CUSHION_LIGHT = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  float cNL = dot(normal, directLight.direction);
  float cWrap = max(0.0, (cNL + 0.65) / 1.65) - max(0.0, cNL);
  reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * RECIPROCAL_PI * (cWrap + 0.2) * (1.0 - 0.5 * cSnow);
}
#endif`;

function cushionMaterial(U, { pbr, a2c, cheap }) {
  const Mat = pbr ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial;
  const mat = new Mat({ side: THREE.FrontSide, alphaTest: 0.5, alphaToCoverage: a2c });
  if (pbr) {
    mat.roughness = 0.95;
    mat.metalness = 0;
  }
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLichS = U.uLichS;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${CUSHION_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUSHION_VERT}`)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvCWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUSHION_FRAG_PARS}`)
      .replace('#include <map_fragment>', `${CUSHION_FRAG}\n#include <map_fragment>`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.77, 0.82), cSnow);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(cNormalW, 0.0)).xyz);')
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${CUSHION_LIGHT}`);
    if (cheap) cheapShadows(sh);
  };
  mat.customProgramCacheKey = () => `moss-cushion-${pbr ? 'pbr' : 'lam'}-${cheap && CHEAP_SHADOW_OK() ? 'cs' : 'ts'}`;
  return mat;
}

// ── textures ────────────────────────────────────────────────

function dataTexture(data, w, h, { mips = false, wrap = THREE.ClampToEdgeWrapping, anisotropy = 1, format = THREE.RGBAFormat } = {}) {
  const tex = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = wrap;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

// ── phenology helpers ───────────────────────────────────────

function windowMonths(m, a, b, ramp = 0.35) {
  const inside = (x) => smoothstep(a - ramp, a + ramp, x) * (1 - smoothstep(b - ramp, b + ramp, x));
  return Math.max(inside(m), inside(m + 12), inside(m - 12));
}

/** Season state for the moss shaders, from phenology(v) and the blended season params. */
export function mossSeason(sp, v = 0) {
  const m = phenology(v).month;
  const dew = sp.dew ?? 1;
  return {
    fresh: windowMonths(m, 5.0, 7.2, 0.4), // this year's bright shoot tips
    wet: dew,
    snow: sp.snow ?? 0,
    dry: 0.22 * windowMonths(m, 7.0, 8.8, 0.4) * (1 - 0.5 * dew), // late-summer drought on the hummocks
    setae: windowMonths(m, 5.7, 9.6, 0.4), // haircap sporophytes up, early summer → early autumn
    ripe: smoothstep(7.2, 8.6, m) * (m < 11 ? 1 : 0), // capsules shed the golden calyptra
    cups: windowMonths(m, 4.8, 6.9, 0.35), // haircap male splash-cups
    lichWet: clamp(0.2 * dew + 0.8 * windowMonths(m, 8.9, 11.6, 0.5)), // crisp in a dry summer, soft in a wet autumn
  };
}

// ── the module ──────────────────────────────────────────────

/**
 * Build the moss carpets and lichens.
 * → { group, update(dt, time, state), applySeason(sp, v), setSnowField(floor.snowField), stats, tips }
 * tips: [{ p: Vector3, n: Vector3, c: [r, g, b] }] on moss shoot tips (world space) for the dew drops.
 */
export function buildMoss(ctx = {}) {
  const quality = ctx.quality ?? {};
  const data = buildMossData(quality);
  const { tier } = data;
  const pbr = !!quality.pbrFoliage;
  const a2c = (quality.msaa ?? 0) > 0;
  const shadows = quality.shadows !== false;
  const maxAniso = ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  const aniso = Math.max(1, Math.min(quality.anisotropy ?? 4, 8, maxAniso));

  const group = new THREE.Group();
  group.name = 'flyover-moss';

  const atlasTex = dataTexture(data.atlas.data, data.atlas.size, data.atlas.size, { mips: true, wrap: THREE.RepeatWrapping, anisotropy: aniso });
  const mapTex = dataTexture(data.map, MAP_W, MAP_H);
  const maskTex = dataTexture(data.mask, MASK_W, MASK_H, { format: THREE.RedFormat });

  // uniforms shared by every moss material, so the season is set in one place
  const common = {
    tMossAtlas: { value: atlasTex },
    uAtlas: { value: new THREE.Vector4((data.atlas.size * 0.3125) / 0.86, data.atlas.size, 0, 0) },
    uMossS: { value: new THREE.Vector4(0, 1, 0, 0) },
    uMossK: { value: new THREE.Vector4(tier.deep ?? MOSS.deep, MOSS.bump, pbr ? 0 : MOSS.sheen, tier.lite ? 1 : 0) },
    uTrans: { value: new THREE.Vector3(...MOSS.trans) },
  };
  const U = {
    shell: {
      ...common,
      tMossMap: { value: mapTex },
      tMossMask: { value: maskTex },
      uShell: { value: new THREE.Vector4(tier.shells, MOSS.pile, MOSS.base, 0) },
      uPatchA: { value: new THREE.Vector4(PATCH.center.x, PATCH.center.y, PATCH.u.x, PATCH.u.y) },
      uPatchB: { value: new THREE.Vector4(PATCH.v.x, PATCH.v.y, 1 / (2 * PATCH.halfL), 1 / (2 * PATCH.halfW)) },
    },
    card: common,
    uHair: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLichS: { value: new THREE.Vector4(tier.lichShells, MOSS.lichThick, 0, 0) },
  };

  // the carpet: one instanced draw of the shell stack, top shell first
  const shellGeo = new THREE.InstancedBufferGeometry().copy(data.shell);
  shellGeo.instanceCount = tier.shells;
  shellGeo.boundingSphere = data.shell.boundingSphere.clone();
  shellGeo.boundingBox = data.shell.boundingBox.clone();
  const shells = new THREE.Mesh(shellGeo, shellMaterial(U, { pbr, a2c }));
  shells.name = 'moss-shells';
  shells.receiveShadow = shadows;
  shells.renderOrder = -1; // before the floor, so the floor under solid moss fails the depth test
  group.add(shells);

  // lying fronds and Dicranum tufts share one material
  const cardMat = cardMaterial(U, { pbr, a2c, cheap: tier.shells < 10 });
  const instanced = (geo, inst, name) => {
    const params = new Float32Array(Math.max(inst.count, 1) * 4);
    params.set(inst.params);
    geo.setAttribute('aFrond', new THREE.InstancedBufferAttribute(params, 4));
    const ground = new Float32Array(Math.max(inst.count, 1));
    for (let i = 0; i < inst.count; i++) ground[i] = heroHeightAt(inst.matrices[i * 16 + 12], inst.matrices[i * 16 + 14]);
    geo.setAttribute('aFrondG', new THREE.InstancedBufferAttribute(ground, 1));
    const mesh = new THREE.InstancedMesh(geo, cardMat, Math.max(inst.count, 1));
    mesh.instanceMatrix.array.set(inst.matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = inst.count;
    mesh.computeBoundingSphere();
    mesh.name = name;
    mesh.receiveShadow = shadows;
    mesh.castShadow = shadows && tier.castFronds;
    mesh.customDepthMaterial = cardMat.userData.depth;
    mesh.renderOrder = -2;
    group.add(mesh);
    return mesh;
  };
  const fronds = instanced(data.frondGeo, data.fronds, 'moss-fronds');
  const tufts = instanced(data.tuft.geometry, data.tufts, 'moss-dicranum');

  // haircap moss and lichens
  const haircap = new THREE.Mesh(data.haircap.geometry, plantMaterial(U, { pbr, season: 'moss', trans: [0.32, 0.4, 0.12], key: 'haircap', hair: true }));
  haircap.name = 'moss-haircap';
  haircap.receiveShadow = shadows;
  haircap.renderOrder = -2;
  group.add(haircap);

  const lichens = new THREE.Mesh(data.lichens.geometry, plantMaterial(U, { pbr, season: 'none', trans: [0.16, 0.16, 0.12], key: 'lichen', grain: true }));
  lichens.name = 'moss-lichens';
  lichens.receiveShadow = shadows;
  lichens.castShadow = shadows && tier.castLichen;
  lichens.renderOrder = -2;
  group.add(lichens);

  // reindeer-lichen mats: one instanced draw of their shell stack, top shell first
  const cushionGeo = new THREE.InstancedBufferGeometry().copy(data.lichens.cushionGeometry);
  cushionGeo.instanceCount = tier.lichShells;
  cushionGeo.boundingSphere = data.lichens.cushionGeometry.boundingSphere.clone();
  const cushions = new THREE.Mesh(cushionGeo, cushionMaterial(U, { pbr, a2c, cheap: tier.shells < 10 }));
  cushions.name = 'moss-cushions';
  cushions.receiveShadow = shadows;
  cushions.castShadow = shadows && tier.castLichen;
  cushions.renderOrder = -2;
  group.add(cushions);

  const casters = [fronds, tufts, lichens, cushions].filter((m) => m.castShadow).length;
  const stats = {
    drawCalls: 6,
    shadowDrawCalls: casters,
    triangles: Math.round(Object.values(data.tris).reduce((a, b) => a + b, 0)),
    instances: tier.shells + data.fronds.count + data.tufts.count,
    detail: { ...data.tris, shellCount: tier.shells, frondCount: data.fronds.count, tuftCount: data.tufts.count, haircapStems: data.haircap.stems, cushions: data.lichens.cushions, tips: data.tips.length },
  };

  // where the carpet is tallest-ish: probes for "is all of it under the snow?" (shell top above heroHeightAt)
  const probes = [];
  {
    const prng = new RNG(4401);
    const f = {};
    for (let tries = 0; probes.length < 400 && tries < 20000; tries++) {
      const u = prng.float(-PATCH.halfL, PATCH.halfL);
      const v = prng.float(-PATCH.halfW, PATCH.halfW);
      mossField(u, v, f);
      if (f.cover < 0.3) continue;
      const { x, z } = fromPatch(u, v);
      const pile = f.pile * smoothstep(0.12, 0.7, f.cover);
      probes.push(x, z, MOSS.base * (0.4 + 0.6 * f.cover) + Math.min(1, pile + 0.12) * MOSS.pile);
    }
  }
  let snowField = null;
  const snowOut = {};
  const allBuried = (snow) => {
    if (!snowField || snow < 0.5) return false;
    for (let i = 0; i < probes.length; i += 3) {
      const s = snowField.depthAt(probes[i], probes[i + 1], snow, snowOut);
      if (!(s.thickness > 0.003 && s.surface - 0.002 > probes[i + 2])) return false;
    }
    return true;
  };
  /** Bind the floor's snow field ({ uniforms, glsl, depthAt }): the shells and shoots then snow with the floor. */
  function setSnowField(field) {
    if (!field?.uniforms || !field?.glsl) return;
    snowField = field;
    U.snow = field;
    shells.material.needsUpdate = true;
    cardMat.needsUpdate = true;
    lastSeason?.();
  }
  let lastSeason = null;

  let buried = false;
  let lastNear = -1;
  function update(dt, time, state = {}) {
    const near = state.near ?? 1;
    if (Math.abs(near - lastNear) < 1e-4) return;
    lastNear = near;
    // far away: one cheap carpet layer, no cards; close: the full shell stack and the 3D shoots
    const close = near > 0.002;
    shellGeo.instanceCount = close ? tier.shells : 1;
    U.shell.uShell.value.x = shellGeo.instanceCount;
    U.shell.uShell.value.w = close ? 0 : 1;
    cushionGeo.instanceCount = close ? tier.lichShells : 1;
    U.uLichS.value.x = cushionGeo.instanceCount;
    fronds.visible = close && !buried && data.fronds.count > 0;
    tufts.visible = close && !buried && data.tufts.count > 0;
    fronds.count = Math.max(1, Math.round(data.fronds.count * (0.4 + 0.6 * near)));
    tufts.count = Math.max(1, Math.round(data.tufts.count * (0.4 + 0.6 * near)));
  }

  function applySeason(sp, v = 0) {
    lastSeason = () => applySeason(sp, v);
    const s = mossSeason(sp, v);
    common.uMossS.value.set(s.fresh, s.wet, s.snow, s.dry);
    U.uHair.value.set(s.setae, s.ripe, s.cups, 0);
    U.uLichS.value.z = s.lichWet;
    U.uLichS.value.w = s.snow;
    // once the snow is deeper than the carpet everywhere, the floor's snow takes over (invisibly);
    // without the floor's field the shells carry no snow, so they stay until deep winter
    buried = snowField ? allBuried(s.snow) : s.snow > 0.97;
    shells.visible = !buried;
    haircap.visible = s.snow < 0.9;
    lichens.visible = s.snow < 0.88;
    cushions.visible = s.snow < 0.9; // until then they poke through the snow at their edges
    lastNear = -1;
  }

  update(0, 0, { near: 1 });
  return { group, update, applySeason, setSnowField, stats, tips: data.tips };
}
