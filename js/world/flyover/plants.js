import * as THREE from 'three';
import { RNG, smoothstep, clamp, lerp, noise2 } from '../../lib/random.js';
import { frames } from '../../lib/geometry.js';
import { shared, seasonUniforms } from '../../gl/patches.js';
import { PATCH, SPOTS, fromPatch, toPatch, heroHeightAt, phenology } from './config.js';

// The hero flora of the forest-floor close-up, at true size: a lady-fern and a narrow buckler-fern clump (with
// fiddleheads in early summer), bilberry, lingonberry, twinflower, wood sorrel, chanterelles and a fly agaric.
// Everything is real geometry, merged into four meshes that share one painted atlas:
//   leavesTall – fern pinnules, bilberry leaves                     (alpha-tested, translucent, casts shadows)
//   leavesLow  – twinflower and wood-sorrel leaves, sorrel petals    (alpha-tested, translucent)
//   solid      – fern stipes and croziers, bilberry stems, flowers and berries, mushrooms (casts shadows)
//   gloss      – lingonberry, twinflower runners and bells, sorrel stalks (clearcoat on high/ultra)
// Seasons never rebuild anything: every vertex knows its element (a frond, a berry, a flower) and the vertex
// shader grows, ripens, browns, flattens or drops that element from a small per-kind uniform table.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = v3(0, 1, 0);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgb = (r, g, b) => [lin(r / 255), lin(g / 255), lin(b / 255)];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const fract = (x) => x - Math.floor(x);
const angAbs = (a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
// Any unit vector perpendicular to d.
const perpTo = (d) => {
  const p = v3().crossVectors(d, Math.abs(d.y) < 0.9 ? UP : v3(1, 0, 0));
  return p.normalize();
};

// ── tuning knobs ─────────────────────────────────────────────
export const FLOOR_PLANTS = {
  windSway: 0.006, // m a frond tip sways (sway weight 1)
  windFlutter: 0.0008, // m of leaf flutter
  snowDepth: 0.1, // m everything sinks into deep snow (only tips stay above the white ground)
  envSpecular: 0.42, // canopy reflection on glossy leaves and berries (from the hemisphere light)
  subsurface: 0.35, // soft wrap light in mushroom flesh
  translucency: [0.9, 0.95, 0.55], // light through thin leaves and petals
  lodNear: [0.3, 0.4], // state.near hysteresis: fine fern pinnules above, painted pinna cards below
  dewMaxSway: 0.0015, // dew sites only where the leaf moves less than this (m)
  silk: { u: 0.7, v: 0.42, h: 0.3 }, // the still fern-frond tip the dew module hangs its silk thread from
  silkTo: { u: 0.76, v: -0.08, h: 0.035 }, // … and the twig end it runs to (other fronds keep clear of the line)
};

// ── element kinds: one row each in the season table ─────────
const KIND = {
  STATIC: 0,
  FROND: 1, // this year's open fronds
  CROZ_TIGHT: 2,
  CROZ_HALF: 3,
  CROZ_LATE: 4,
  DEAD: 5, // last year's fronds, lying flat
  BIL_STEM: 6,
  BIL_LEAF: 7,
  BIL_FLOWER: 8,
  BIL_BERRY: 9,
  LIN_STEM: 10,
  LIN_LEAF: 11,
  LIN_FLOWER: 12,
  LIN_BERRY: 13,
  TWIN_RUNNER: 14,
  TWIN_LEAF: 15,
  TWIN_FLOWER: 16,
  SOR_LEAF: 17,
  SOR_FLOWER: 18,
  CHANT: 19,
  AGARIC: 20,
  BUTTON: 21,
  FROND_STILL: 22, // the frond that holds the silk thread: it never collapses before the snow
  FROND_IN: 23, // fronds arching in over the glide line: in autumn they sag, brown and drop out (never onto the trail)
  DEW: 24, // water drops on the hero coils: they come and go with their crozier (and the dew)
};
const NK = 25;
const GROUP = { none: 0, fern: 1, berry: 2, lingon: 3 };

// Per-kind look: [waxy bloom sheen, subsurface wrap, clearcoat, paler underside]
const KFX = Array.from({ length: NK }, () => [0, 0, 0, 0]);
for (const k of [KIND.FROND, KIND.FROND_IN, KIND.FROND_STILL, KIND.CROZ_LATE, KIND.DEAD]) KFX[k] = [0, 0, 0, 0.35];
KFX[KIND.CROZ_TIGHT] = [0, 0.1, 0, 0];
KFX[KIND.CROZ_HALF] = [0, 0.1, 0, 0];
KFX[KIND.BIL_LEAF] = [0, 0, 0, 0.4];
KFX[KIND.BIL_BERRY] = [0, 0.15, 0, 0];
KFX[KIND.LIN_LEAF] = [0, 0, 1, 0.85];
KFX[KIND.LIN_BERRY] = [0, 0.12, 1, 0];
KFX[KIND.TWIN_LEAF] = [0, 0, 0.35, 0.7];
KFX[KIND.SOR_LEAF] = [0, 0, 0, 0.55];
for (const k of [KIND.BIL_FLOWER, KIND.LIN_FLOWER, KIND.TWIN_FLOWER, KIND.SOR_FLOWER]) KFX[k] = [0, 0.12, 0, 0.2];
KFX[KIND.CHANT] = [0, 1, 0, 0];
KFX[KIND.AGARIC] = [0, 0.6, 0.3, 0];
KFX[KIND.BUTTON] = [0, 0.6, 0.3, 0];

// Per-kind colour shift target (unripe berries, dead fronds, winter bronze) + luminance of the base colour.
const KCOL = Array.from({ length: NK }, () => [0, 0, 0, 0.1]);
const DEAD_BROWN = rgb(122, 80, 40);
for (const k of [KIND.FROND, KIND.FROND_IN, KIND.FROND_STILL]) KCOL[k] = [...DEAD_BROWN, 0.16];
KCOL[KIND.BIL_BERRY] = [...rgb(150, 168, 92), 0.1];
KCOL[KIND.LIN_BERRY] = [...rgb(186, 196, 150), 0.1]; // unripe: pale green-white, albedo ≈ 0.5
// Per-kind blush: how much of the colour shift the upward (sunny) side keeps back — unripe lingonberries blush pink.
const KBLUSH = new Array(NK).fill(0);
KBLUSH[KIND.LIN_BERRY] = 0.6;
KBLUSH[KIND.BIL_BERRY] = 0.35;
// Per-kind fuzz: fine hairs, scales or a waxy bloom that catch the light toward the silhouette (rgb, strength).
const KFUZZ = Array.from({ length: NK }, () => [0, 0, 0, 0]);
KFUZZ[KIND.BIL_BERRY] = [0.4, 0.46, 0.6, 1]; // dusty bloom
// negative strength = fine hairs: a thin silvery-gold rim on the sunlit side only, no sky sheen
KFUZZ[KIND.CROZ_TIGHT] = [0.95, 0.85, 0.55, -0.45];
KFUZZ[KIND.CROZ_HALF] = [0.95, 0.85, 0.55, -0.4];
KFUZZ[KIND.CROZ_LATE] = [0.9, 0.9, 0.6, -0.25];
KFUZZ[KIND.TWIN_FLOWER] = [0.7, 0.62, 0.6, 0.25]; // glandular hairs
KCOL[KIND.LIN_LEAF] = [...rgb(98, 44, 30), 0.07];

// ── the painted atlas (1024 × 512 base units; drawn bottom-up: base of every leaf at the cell bottom) ──
const AW = 1024;
const AH = 512;
const cell = (x, y, w, h) => ({ x, y, w, h, r: [x / AW, 1 - (y + h) / AH, (x + w) / AW, 1 - y / AH] });
const ATLAS = {
  ladyPinnule: cell(0, 0, 64, 160),
  ladyPinnuleBite: cell(64, 0, 64, 160),
  buckPinnule: cell(128, 0, 64, 160),
  buckPinnuleBite: cell(192, 0, 64, 160),
  bilLeaf: cell(0, 160, 96, 160),
  bilLeafBite: cell(96, 160, 96, 160),
  twinLeaf: cell(192, 160, 96, 112),
  sorLeaflet: cell(0, 320, 128, 112),
  sorPetal: cell(128, 320, 96, 128),
  ladyPinna: cell(288, 0, 160, 448),
  buckPinna: cell(448, 0, 160, 448),
  linLeaf: cell(608, 0, 96, 160),
  white: cell(608, 176, 64, 64),
  scales: cell(704, 0, 128, 256),
  bell: cell(832, 0, 128, 128),
};
const PINNA_ASPECT = ATLAS.ladyPinna.w / ATLAS.ladyPinna.h;
const WU = (ATLAS.white.r[0] + ATLAS.white.r[2]) / 2;
const WV = (ATLAS.white.r[1] + ATLAS.white.r[3]) / 2;
const WHITE = [1, 1, 1];
const rectUV = (r) => (u, v) => [r[0] + u * (r[2] - r[0]), r[1] + v * (r[3] - r[1])];

const SPOT_NAMES = ['fernLeft', 'fernRight', 'bilberry', 'lingon', 'twinflower', 'woodSorrel', 'chanterelles', 'flyAgaric', 'fiddleheadsA', 'fiddleheadsB', 'flyAgaricB'];
const SPOT_ID = Object.fromEntries(SPOT_NAMES.map((n, i) => [n, i + 1]));

// ── detail per quality tier ──────────────────────────────────
const QT = {
  ultra: {
    pin: [2, 2], frondSeg: 30, radial: 6, coilRadial: 10, coilStep: 0.13, lady: 13, buck: 10, croz: { lady: [2, 1, 1], buck: [1, 1, 1] }, fidd: [2, 1, 1, 1], hero: [4, 3, 2, 2], dead: 3,
    bil: 30, bilFruit: 60, lin: 46, linLeaf: [4, 4], leafNy: 3, berryNu: 12, berryNv: 9, bellNu: 20, bellNv: 8,
    twinRun: 6, twinFl: 20, sorClumps: 4, sorLeaves: 12, sorFl: 6, chant: 7, chantRes: [104, 30], agRes: [112, 26], stemRes: [32, 18], warts: 85, btWarts: 70,
  },
  high: {
    pin: [2, 2], frondSeg: 26, radial: 6, coilRadial: 9, coilStep: 0.16, lady: 10, buck: 8, croz: { lady: [2, 1, 1], buck: [1, 1, 1] }, fidd: [2, 1, 1, 1], hero: [4, 2, 2, 2], dead: 3,
    bil: 26, bilFruit: 50, lin: 38, linLeaf: [4, 4], leafNy: 3, berryNu: 12, berryNv: 8, bellNu: 15, bellNv: 7,
    twinRun: 5, twinFl: 16, sorClumps: 4, sorLeaves: 10, sorFl: 5, chant: 6, chantRes: [84, 24], agRes: [88, 22], stemRes: [28, 16], warts: 75, btWarts: 60,
  },
  medium: {
    pin: [2, 1], frondSeg: 22, radial: 5, coilRadial: 8, coilStep: 0.2, lady: 10, buck: 8, croz: { lady: [2, 1, 1], buck: [1, 1, 0] }, fidd: [2, 1, 1, 1], hero: [3, 2, 1, 2], dead: 2,
    bil: 22, bilFruit: 38, lin: 30, linLeaf: [4, 3], leafNy: 2, berryNu: 10, berryNv: 7, bellNu: 15, bellNv: 6,
    twinRun: 5, twinFl: 12, sorClumps: 4, sorLeaves: 8, sorFl: 4, chant: 6, chantRes: [64, 20], agRes: [64, 18], stemRes: [20, 12], warts: 48, btWarts: 40,
  },
  low: {
    pin: [1, 1], frondSeg: 16, radial: 4, coilRadial: 6, coilStep: 0.26, lady: 7, buck: 5, croz: { lady: [1, 1, 0], buck: [1, 0, 0] }, fidd: [2, 1, 0, 1], hero: [2, 1, 1, 1], dead: 2,
    bil: 13, bilFruit: 22, lin: 18, linLeaf: [2, 2], leafNy: 2, berryNu: 8, berryNv: 6, bellNu: 10, bellNv: 5,
    twinRun: 4, twinFl: 8, sorClumps: 3, sorLeaves: 5, sorFl: 3, chant: 5, chantRes: [44, 14], agRes: [48, 16], stemRes: [16, 10], warts: 40, btWarts: 32,
  },
};

// ═══════════════════════════════════════════════════════════════
// Vertex soup with per-element attributes
// ═══════════════════════════════════════════════════════════════
const SEC_FINE = 0; // near only (fern pinnules)
const SEC_SHARED = 1; // always
const SEC_COARSE = 2; // far only (painted pinna cards)

class Soup {
  constructor(origin) {
    this.O = origin;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.wind = [];
    this.grow = [];
    this.info = [];
    this.spot = [];
    this.idx = [[], [], []];
    this.sec = SEC_SHARED;
    this.e = { kind: 0, ax: 0, ay: 0, az: 0, rnd: 0.5, rough: 0.6, trans: 0, group: 0, phase: 0, flutter: 0, spot: 0 };
  }

  get count() {
    return this.pos.length / 3;
  }

  get triangles() {
    return (this.idx[0].length + this.idx[1].length + this.idx[2].length) / 3;
  }

  // Start a new element: everything emitted until the next call grows, ripens and drops together.
  el(o) {
    const e = this.e;
    const a = o.anchor ?? this.O;
    e.kind = o.kind ?? 0;
    e.ax = a.x;
    e.ay = a.y;
    e.az = a.z;
    e.rnd = o.rnd ?? 0.5;
    e.rough = o.rough ?? 0.6;
    e.trans = o.trans ?? 0;
    e.group = o.group ?? 0;
    e.phase = o.phase ?? 0;
    e.flutter = o.flutter ?? 0;
    e.spot = o.spot ?? 0;
    return this;
  }

  // Change the surface of the current element without starting a new one.
  mat(rough, trans) {
    this.e.rough = rough;
    this.e.trans = trans;
    return this;
  }

  v(p, n, u, w, c, sway = 0) {
    const O = this.O;
    const e = this.e;
    this.pos.push(p.x - O.x, p.y - O.y, p.z - O.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, w);
    this.col.push(c[0], c[1], c[2]);
    this.wind.push(sway, e.phase, e.flutter);
    this.grow.push(e.ax - O.x, e.ay - O.y, e.az - O.z, e.rnd);
    this.info.push(e.kind, Math.round(clamp(e.rough) * 255), Math.round(clamp(e.trans) * 255), e.group);
    this.spot.push(e.spot);
    return this.count - 1;
  }

  tri(a, b, c) {
    this.idx[this.sec].push(a, b, c);
  }

  build() {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 3));
    g.setAttribute('aGrow', new THREE.Float32BufferAttribute(this.grow, 4));
    g.setAttribute('aInfo', new THREE.BufferAttribute(new Uint8Array(this.info), 4, true));
    const [f, s, c] = this.idx;
    const Arr = this.count > 65535 ? Uint32Array : Uint16Array;
    const idx = new Arr(f.length + s.length + c.length);
    idx.set(f, 0);
    idx.set(s, f.length);
    idx.set(c, f.length + s.length);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    // wind, the flattening spread and the snow sink move vertices a little
    g.boundingSphere.radius += 0.12;
    g.boundingBox.expandByScalar(0.12);
    g.userData.ranges = { fine: f.length, shared: s.length, coarse: c.length };
    return g;
  }
}

// ═══════════════════════════════════════════════════════════════
// Geometry helpers (all write world-space points into a soup)
// ═══════════════════════════════════════════════════════════════
const _da = v3();
const _db = v3();

// A (nu+1)×(nv+1) grid of points → vertices with normals from the grid itself (so displacement shades right).
function emitGrid(S, P, nu, nv, o = {}) {
  const W = nu + 1;
  const N = new Array(P.length);
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      let i0 = i - 1;
      let i1 = i + 1;
      if (o.wrapU) {
        if (i0 < 0) i0 = nu - 1;
        if (i1 > nu) i1 = 1;
      } else {
        i0 = Math.max(0, i0);
        i1 = Math.min(nu, i1);
      }
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(nv, j + 1);
      _da.subVectors(P[j * W + i1], P[j * W + i0]);
      _db.subVectors(P[j1 * W + i], P[j0 * W + i]);
      N[j * W + i] = v3().crossVectors(_da, _db);
    }
  }
  // poles and collapsed tips borrow the normal of the nearest healthy row
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const n = N[j * W + i];
      if (n.lengthSq() > 1e-22) continue;
      for (let k = 1; k <= nv; k++) {
        const a = j - k >= 0 ? N[(j - k) * W + i] : null;
        const b = j + k <= nv ? N[(j + k) * W + i] : null;
        if (a && a.lengthSq() > 1e-22) {
          n.copy(a);
          break;
        }
        if (b && b.lengthSq() > 1e-22) {
          n.copy(b);
          break;
        }
      }
      if (n.lengthSq() <= 1e-22) n.copy(o.fallback ?? UP);
    }
  }
  const base = S.count;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const k = j * W + i;
      const n = N[k].normalize();
      if (o.flip) n.negate();
      const u = i / nu;
      const v = j / nv;
      const uv = o.uv ? o.uv(u, v) : null;
      const c = typeof o.color === 'function' ? o.color(u, v, P[k]) : o.color ?? WHITE;
      const sw = typeof o.sway === 'function' ? o.sway(u, v, P[k]) : o.sway ?? 0;
      S.v(P[k], n, uv ? uv[0] : WU, uv ? uv[1] : WV, c, sw);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * W + i;
      const b = a + 1;
      const c = a + W + 1;
      const d = a + W;
      if (o.flip) {
        S.tri(a, c, b);
        S.tri(a, d, c);
      } else {
        S.tri(a, b, c);
        S.tri(a, c, d);
      }
    }
  }
  return N;
}

// Parametric surface F(u, v, out) over [0,1]².
function surface(S, F, nu, nv, o = {}) {
  const P = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) P.push(F(i / nu, j / nv, v3()));
  const N = emitGrid(S, P, nu, nv, o);
  return { P, N };
}

// Orthonormal frame around an axis (y = axis, x × y = z).
function frameAxis(o, axis) {
  const y = axis.clone().normalize();
  const ref = Math.abs(y.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
  const x = v3().crossVectors(y, ref).normalize();
  const z = v3().crossVectors(x, y).normalize();
  return { o: o.clone(), x, y, z };
}

// Smooth (r, y) profile through control points, parameterised by arc length. prof(v, out) → out = [r, y].
function polyProfile(pts) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1];
  const n = pts.length;
  const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const prof = (v, out = [0, 0]) => {
    const s = clamp(v) * total;
    let i = 0;
    while (i < n - 2 && L[i + 1] < s) i++;
    const t = clamp((s - L[i]) / Math.max(1e-9, L[i + 1] - L[i]));
    const a = pts[Math.max(0, i - 1)];
    const b = pts[i];
    const c = pts[i + 1];
    const d = pts[Math.min(n - 1, i + 2)];
    out[0] = Math.max(0, cr(a[0], b[0], c[0], d[0], t));
    out[1] = cr(a[1], b[1], c[1], d[1], t);
    return out;
  };
  prof.vAt = (i) => L[i] / total;
  return prof;
}

// Lathe around fr.y with an optional displacement disp(θ, v, r, y) → [dr, dy].
function revolveF(fr, prof, disp) {
  const pr = [0, 0];
  return (u, v, out) => {
    const th = u * TAU;
    prof(v, pr);
    let r = pr[0];
    let y = pr[1];
    if (disp) {
      const d = disp(th, v, r, y);
      r += d[0];
      y += d[1];
    }
    return out.copy(fr.o).addScaledVector(fr.x, Math.cos(th) * r).addScaledVector(fr.z, -Math.sin(th) * r).addScaledVector(fr.y, y);
  };
}

function revolve(S, fr, prof, nu, nv, o = {}) {
  const F = revolveF(fr, prof, o.disp);
  return { F, ...surface(S, F, nu, nv, { ...o, wrapU: true }) };
}

// A tube along a polyline. `side` fixes the frame for planar curves (bumps on the flanks of a crozier coil).
function tube(S, pts, radii, o = {}) {
  const radial = o.radial ?? 5;
  const n = pts.length;
  const T = [];
  const N = [];
  const Bv = [];
  if (o.side) {
    for (let i = 0; i < n; i++) {
      const t = v3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      const side = Array.isArray(o.side) ? o.side[i] : o.side;
      const nn = side.clone().addScaledVector(t, -side.dot(t));
      if (nn.lengthSq() < 1e-8) nn.copy(i > 0 ? N[i - 1] : v3(1, 0, 0));
      nn.normalize();
      T.push(t);
      N.push(nn);
      Bv.push(v3().crossVectors(t, nn).normalize());
    }
  } else {
    const fr = frames(pts);
    T.push(...fr.T);
    N.push(...fr.N);
    Bv.push(...fr.B);
  }
  const acc = [0];
  for (let i = 1; i < n; i++) acc.push(acc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = Math.max(1e-6, acc[n - 1]);
  const P = [];
  const dir = v3();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU + (o.rot ?? 0);
      const r = radii[i] * (o.mod ? o.mod(i, a) : 1);
      dir.copy(N[i]).multiplyScalar(Math.cos(a)).addScaledVector(Bv[i], Math.sin(a));
      P.push(pts[i].clone().addScaledVector(dir, r));
    }
  }
  const row = (v) => Math.min(n - 1, Math.round(v * (n - 1)));
  const rr = o.rect;
  emitGrid(S, P, radial, n - 1, {
    wrapU: true,
    uv: rr ? (u, v) => [rr[0] + u * (rr[2] - rr[0]), rr[1] + (acc[row(v)] / total) * (rr[3] - rr[1])] : null,
    color: typeof o.color === 'function' ? (u, v, p) => o.color(row(v), u, p) : o.color,
    sway: typeof o.sway === 'function' ? (u, v) => o.sway(row(v)) : o.sway ?? 0,
  });
}

// A thin blade (leaf, leaflet, pinnule, petal). base = attachment, d = midrib, n = upper side.
// Shape: fold (V, edges up), cup, roll (edges rolled down), arch (+ = tip bends toward the underside),
// curl (extra rolling near the tip), twist, lateral (sideways curve). profile(t) narrows opaque leaves.
function blade(S, base, d0, n0, len, wid, rect, o = {}) {
  const nx = o.nx ?? 2;
  const ny = o.ny ?? 2;
  const d = d0.clone().normalize();
  const w = v3().crossVectors(d, n0).normalize();
  const n = v3().crossVectors(w, d).normalize();
  const A = o.arch ?? 0;
  const C = o.curl ?? 0;
  const tw = o.twist ?? 0;
  const lat = o.lateral ?? 0;
  const fold = o.fold ?? 0;
  const cup = o.cup ?? 0;
  const roll = o.roll ?? 0;
  const prof = o.profile ?? null;
  const hw = wid * 0.5;
  const P = [];
  const mid = v3();
  const Nr = v3();
  const Wr = v3();
  const Nt = v3();
  let ax = 0;
  let ay = 0;
  let tPrev = 0;
  for (let j = 0; j <= ny; j++) {
    const t = j / ny;
    const sub = 6;
    for (let k = 0; k < sub && t > tPrev; k++) {
      const tm = tPrev + ((t - tPrev) * (k + 0.5)) / sub;
      const ph = A * tm + C * tm * tm * tm;
      ax += (Math.cos(ph) * (t - tPrev)) / sub;
      ay += (Math.sin(ph) * (t - tPrev)) / sub;
    }
    tPrev = t;
    const ph = A * t + C * t * t * t;
    Nr.copy(n).multiplyScalar(Math.cos(ph)).addScaledVector(d, Math.sin(ph));
    const a = tw * t;
    Wr.copy(w).multiplyScalar(Math.cos(a)).addScaledVector(Nr, Math.sin(a));
    Nt.copy(Nr).multiplyScalar(Math.cos(a)).addScaledVector(w, -Math.sin(a));
    mid.copy(base).addScaledVector(d, ax * len).addScaledVector(n, -ay * len).addScaledVector(w, lat * len * t * t);
    const f = prof ? prof(t) : 1;
    for (let i = 0; i <= nx; i++) {
      const s = -1 + (2 * i) / nx;
      const as = Math.abs(s);
      const x = s * f * hw;
      const sr = smoothstep(0.5, 1, as);
      const z = (fold * as + cup * s * s) * f * hw - roll * f * hw * sr * sr;
      P.push(mid.clone().addScaledVector(Wr, x).addScaledVector(Nt, z));
    }
  }
  const N = emitGrid(S, P, nx, ny, {
    uv: (u, v) => {
      const s = -1 + 2 * u;
      const f = prof ? prof(v) : 1;
      return [rect[0] + (s * f * 0.5 + 0.5) * (rect[2] - rect[0]), rect[1] + v * (rect[3] - rect[1])];
    },
    color: typeof o.color === 'function' ? (u, v, p) => o.color(-1 + 2 * u, v, p) : o.color,
    sway: typeof o.sway === 'function' ? (u, v, p) => o.sway(-1 + 2 * u, v, p) : o.sway ?? 0,
    fallback: n,
  });
  const ic = Math.round(nx / 2);
  const jm = Math.round(ny / 2);
  const W = nx + 1;
  return {
    tip: P[ny * W + ic].clone(),
    tipN: N[ny * W + ic].clone(),
    mid: P[jm * W + ic].clone(),
    midN: N[jm * W + ic].clone(),
  };
}

// A little pyramid of veil tissue (fly-agaric warts): an irregular rim on the surface, a shoulder and a peak.
function wart(S, p, n, size, height, rng, color) {
  const k = 6;
  const fr = frameAxis(p, n);
  const jit = Array.from({ length: k }, () => rng.float(0.7, 1.3));
  const rot = rng.float(0, TAU);
  const F = (u, v, out) => {
    const f = u * k;
    const i0 = Math.floor(f) % k;
    const j = lerp(jit[i0], jit[(i0 + 1) % k], f - Math.floor(f));
    const rr = size * j * (v < 0.5 ? 1 - 0.3 * (v / 0.5) : 0.7 * (1 - (v - 0.5) / 0.5));
    const hh = height * (v < 0.5 ? 0.72 * (v / 0.5) : 0.72 + 0.28 * ((v - 0.5) / 0.5)) - 0.0003;
    const th = u * TAU + rot;
    return out.copy(fr.o).addScaledVector(fr.x, Math.cos(th) * rr).addScaledVector(fr.z, -Math.sin(th) * rr).addScaledVector(fr.y, hh);
  };
  surface(S, F, k, 2, { wrapU: true, color, fallback: fr.y });
}

// ═══════════════════════════════════════════════════════════════
// Ferns: Athyrium filix-femina (left) and Dryopteris carthusiana (right)
// ═══════════════════════════════════════════════════════════════
const FERN = {
  lady: {
    pinnule: 'ladyPinnule',
    bite: 'ladyPinnuleBite',
    pinna: 'ladyPinna',
    stipe: [0.22, 0.3],
    pairs: [20, 25],
    np0: 11,
    pinnaMax: 0.19,
    profile: (t) => (smoothstep(-0.25, 0.4, t) * Math.pow(1 - t, 0.8)) / 0.71, // lanceolate, lowest pinnae shortened
    alpha: [0.1, 0.75],
    beta: 62 * DEG,
    elev: [64, 80],
    tipElev: [-30, 0],
    bend: [1.5, 2.2],
    droop: 0.16,
    basal: false,
    tint: [0.66, 0.68, 0.56],
    young: [0.82, 0.88, 0.5],
    stipeBase: rgb(48, 28, 20),
    stipeMid: rgb(118, 98, 52),
    rachis: rgb(96, 132, 46),
    r0: 0.0021,
  },
  buckler: {
    pinnule: 'buckPinnule',
    bite: 'buckPinnuleBite',
    pinna: 'buckPinna',
    stipe: [0.32, 0.4],
    pairs: [13, 17],
    np0: 10,
    pinnaMax: 0.24,
    profile: (t) => (Math.pow(1 - t, 0.85) * (0.82 + 0.18 * smoothstep(0, 0.2, t))) / 0.84, // ovate-triangular
    alpha: [0.18, 0.8],
    beta: 58 * DEG,
    elev: [56, 74],
    tipElev: [-35, -5],
    bend: [1.6, 2.4],
    droop: 0.12,
    basal: true, // the long inner basal pinnule of the lowest pinnae
    tint: [0.72, 0.72, 0.62],
    young: [0.86, 0.9, 0.55],
    stipeBase: rgb(68, 44, 28),
    stipeMid: rgb(108, 122, 50),
    rachis: rgb(82, 120, 42),
    r0: 0.0019,
  },
};
const BROWN_TIP = [1.45, 0.62, 0.42]; // multiplier that turns the green texture into a dry brown tip

// Unit-length arch in the frond plane: x outward, y up. θ eases from e0 at the crown to eT at the tip.
function spineArch(e0, eT, p, n) {
  const out = [{ s: 0, x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  const th = (s) => e0 - (e0 - eT) * Math.pow(s, p);
  for (let i = 1; i <= n; i++) {
    const s0 = (i - 1) / n;
    const s1 = i / n;
    for (let k = 0; k < 8; k++) {
      const a = th(s0 + ((s1 - s0) * (k + 0.5)) / 8);
      x += (Math.cos(a) * (s1 - s0)) / 8;
      y += (Math.sin(a) * (s1 - s0)) / 8;
    }
    out.push({ s: s1, x, y });
  }
  return out;
}

// A coil whose radius shrinks linearly from Rs to Re while it turns through phi (fiddlehead / crook).
// Starts at (x, y) with heading th0; returns points every ~step metres.
function coil(x, y, th0, Rs, Re, phi, step) {
  const Lc = (phi * (Rs - Re)) / Math.log(Rs / Re);
  const kc = (Rs - Re) / Lc;
  const n = Math.max(4, Math.ceil(Lc / step));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const l0 = ((i - 1) / n) * Lc;
    const l1 = (i / n) * Lc;
    for (let k = 0; k < 6; k++) {
      const l = l0 + ((l1 - l0) * (k + 0.5)) / 6;
      const th = th0 - Math.log(Rs / (Rs - kc * l)) / kc;
      x += (Math.cos(th) * (l1 - l0)) / 6;
      y += (Math.sin(th) * (l1 - l0)) / 6;
    }
    out.push({ l: l1, x, y });
  }
  return { pts: out, Lc };
}

// The frond as a plan: rachis points, and every pinna's attachment frame. No geometry yet.
function frondPlan(sp, prm, crown, H, L) {
  const lat3 = v3().crossVectors(UP, H).normalize();
  const sq = spineArch(prm.e0, prm.eT, prm.bend, prm.nSeg);
  const at3 = (x, y, s) => crown.clone().addScaledVector(H, x).addScaledVector(UP, y).addScaledVector(lat3, prm.lat * L * s * s);
  const pts = sq.map((q) => at3(q.x * L, q.y * L, q.s));
  const sArr = sq.map((q) => q.s * L);
  if (prm.crook) {
    const last = sq[sq.length - 1];
    const c = coil(last.x * L, last.y * L, prm.eT, prm.crook.Rs, prm.crook.Re, prm.crook.phi, 0.0012);
    for (const q of c.pts) {
      pts.push(at3(q.x, q.y, 1));
      sArr.push(L + q.l);
    }
  }
  const n = pts.length;
  const tan = pts.map((_, i) => v3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize());
  const at = (s) => {
    let i = 0;
    while (i < n - 2 && sArr[i + 1] < s) i++;
    const t = clamp((s - sArr[i]) / Math.max(1e-9, sArr[i + 1] - sArr[i]));
    return { p: pts[i].clone().lerp(pts[i + 1], t), T: tan[i].clone().lerp(tan[i + 1], t).normalize() };
  };
  // blade normal: the frond's upper side, kept on one side for the whole frond
  let sgnN = 0;
  const frameAt = (T, tw) => {
    const Sp = lat3.clone().addScaledVector(T, -lat3.dot(T)).normalize();
    const Sq = Sp.clone().multiplyScalar(Math.cos(tw)).add(v3().crossVectors(T, Sp).multiplyScalar(Math.sin(tw)));
    const Nb = v3().crossVectors(Sq, T).normalize();
    if (!sgnN) sgnN = Nb.y < 0 ? -1 : 1;
    return { Sq, Nb: Nb.multiplyScalar(sgnN) };
  };
  const sb = prm.sb;
  const Lb = (1 - sb) * L;
  const ellMax = sp.pinnaMax * Lb;
  const pinnae = [];
  for (let k = 0; k < prm.pairs; k++) {
    for (const sig of [1, -1]) {
      const x = (k + 0.5 + (sig < 0 ? 0.45 : 0)) / (prm.pairs + 0.5);
      const tb = Math.min(0.975, 1 - Math.pow(1 - x, 1.25));
      const ell = ellMax * sp.profile(tb) * prm.jit[k * 2 + (sig < 0 ? 1 : 0)] * (prm.pinnaScale ?? 1);
      if (ell < 0.0025) continue;
      const s = sb * L + tb * Lb;
      const { p: A, T } = at(s);
      const { Sq, Nb } = frameAt(T, prm.twist0 + prm.twist1 * tb);
      const al = lerp(sp.alpha[0], sp.alpha[1], Math.pow(tb, 1.2));
      const D0 = Sq.clone().multiplyScalar(sig * Math.cos(al)).addScaledVector(T, Math.sin(al)).addScaledVector(Nb, prm.asc ?? 0.12).normalize();
      // near the crook of an unrolling frond the pinnae are still rolled up
      const yf = prm.youngFrom ?? 0.78;
      const e = prm.crook && tb > yf ? 1 - ((tb - yf) / (1 - yf)) * 0.75 : 1;
      pinnae.push({ A, T, Nb, D0, sig, tb, ell, ellMax, s, e });
    }
  }
  const iE = n - 1;
  const tipFrame = frameAt(tan[iE], prm.twist0 + prm.twist1);
  // the pinnatifid tip starts a little before the end of the rachis so it overlaps the last pinnae
  const termLen = prm.crook ? 0 : 0.055 * L;
  const term = prm.crook ? null : at(L - 0.03 * L);
  const apex = prm.crook ? pts[iE].clone() : term.p.clone().addScaledVector(term.T, termLen);
  return { lat3, pts, tan, sArr, pinnae, apex, termLen, term, tipNb: tipFrame.Nb, L };
}

// Distance from p to the 3D segment ab.
const _sd = v3();
function segDist3(p, a, b) {
  _sd.subVectors(b, a);
  const t = clamp(_sd.dot(v3().subVectors(p, a)) / Math.max(1e-12, _sd.lengthSq()));
  return p.distanceTo(_sd.multiplyScalar(t).add(a));
}

// Fit a frond (the plan scales linearly with L from the crown): as long as wanted, but
//   • within `reach` of the crown and inside the patch, its highest point under `hMax` (the camera passes at 0.85 m)
//   • touching the ground only inside its own spot: outside it (over moss, the ant trail, other spots) it stays
//     at least 5 cm up
//   • clear of the volumes in `avoid` ({ a, b, r }: segments with a radius — the silk thread, the air above the
//     fiddleheads, which must stay visible from above)
// Returns 0 when not even a short frond fits that way.
function fitFrond(sp, prm, crown, H, fit, Lwant) {
  const unit = frondPlan(sp, prm, v3(), H, 1);
  const ext = unit.pts.concat(unit.pinnae.map((pn) => pn.A.clone().addScaledVector(pn.D0, pn.ell * 1.15)), [unit.apex]);
  const w = v3();
  const ok = (L) => {
    for (const p of ext) {
      w.copy(crown).addScaledVector(p, L);
      const hx = w.x - crown.x;
      const hz = w.z - crown.z;
      if (hx * hx + hz * hz > fit.reach * fit.reach) return false;
      const pp = toPatch(w.x, w.z);
      if (Math.abs(pp.u) > PATCH.halfL - 0.03 || Math.abs(pp.v) > PATCH.halfW - 0.03) return false;
      const hh = w.y - heroHeightAt(w.x, w.z);
      if (hh > fit.hMax) return false;
      if (Math.hypot(w.x - fit.cen.x, w.z - fit.cen.z) > fit.R && hh < 0.05) return false;
      for (const a of fit.avoid) if (segDist3(w, a.a, a.b) < a.r) return false;
    }
    return true;
  };
  if (ok(Lwant)) return Lwant;
  let lo = 0;
  let hi = Lwant;
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  return lo;
}

function frondParams(sp, rng, nSeg, o = {}) {
  const pairs = rng.int(sp.pairs[0], sp.pairs[1]);
  const prm = {
    e0: rng.float(sp.elev[0], sp.elev[1]) * DEG,
    eT: rng.float(sp.tipElev[0], sp.tipElev[1]) * DEG,
    bend: rng.float(sp.bend[0], sp.bend[1]),
    lat: rng.float(-0.08, 0.08),
    twist0: rng.float(-0.2, 0.2),
    twist1: rng.float(-0.3, 0.3),
    sb: rng.float(sp.stipe[0], sp.stipe[1]),
    pairs,
    nSeg,
    jit: Array.from({ length: pairs * 2 }, () => rng.float(0.93, 1.07)),
    rnd: rng.next(),
    phase: rng.float(0, TAU),
    seed: rng.int(1, 1e6),
    tint: mul3(sp.tint, rng.float(0.92, 1.07)),
  };
  return Object.assign(prm, o);
}

// One pinna with real pinnules (near) and a painted card (far).
function emitPinna(B, sp, prm, pn, o, sw, rng) {
  const { LS, q } = B;
  const { A, T, Nb, D0, tb, ell } = pn;
  const young = o.young ?? 0;
  const swA = sw(pn.s);
  const Tin = T.clone().addScaledVector(D0, -T.dot(D0));
  if (Tin.lengthSq() < 1e-10) Tin.copy(Nb);
  Tin.normalize();
  const kin = 0.12;
  const dr = sp.droop * (1 - 0.6 * young);
  const C = (tau, out) => out.copy(A).addScaledVector(D0, ell * tau).addScaledVector(Tin, kin * ell * tau * tau).addScaledVector(Nb, -dr * ell * tau * tau);
  const dC = (tau, out) => out.copy(D0).multiplyScalar(ell).addScaledVector(Tin, 2 * kin * ell * tau).addScaledVector(Nb, -2 * dr * ell * tau).normalize();
  const tint = mix3(prm.tint, sp.young, young);
  const ao = 0.76 + 0.24 * smoothstep(0, 0.35, tb);
  const nC0 = Nb.clone().addScaledVector(D0, -Nb.dot(D0)).normalize();

  // far: one painted card for the whole pinna
  LS.sec = SEC_COARSE;
  const wv = v3().crossVectors(D0, nC0);
  blade(LS, A, D0, nC0, ell, ell * PINNA_ASPECT, ATLAS[sp.pinna].r, {
    nx: 1,
    ny: 2,
    arch: 2 * dr,
    lateral: kin * (Math.sign(wv.dot(Tin)) || 1),
    color: mul3(tint, ao),
    sway: swA,
  });

  // near: costa ribbon + pinnules
  LS.sec = SEC_FINE;
  const c = v3();
  const dir = v3();
  {
    const P = [];
    const nCs = 4;
    for (let k = 0; k <= nCs; k++) {
      const tau = (k / nCs) * 0.92;
      C(tau, c);
      dC(tau, dir);
      const Nc = Nb.clone().addScaledVector(dir, -Nb.dot(dir)).normalize();
      const Wc = v3().crossVectors(dir, Nc);
      const hw = lerp(0.0005, 0.00018, tau) * (0.6 + ell * 8);
      P.push(c.clone().addScaledVector(Wc, -hw), c.clone().addScaledVector(Wc, hw));
    }
    emitGrid(LS, P, 1, nCs, { color: mul3(sp.rachis, 1.1), sway: swA, fallback: Nb });
  }
  const np = Math.max(3, Math.round(sp.np0 * Math.sqrt(ell / pn.ellMax)));
  const spacing = (0.9 * ell) / np;
  const p0 = Math.min(0.24 * ell, spacing / 0.42);
  const [nx, ny] = q.pin;
  for (const rho of [1, -1]) {
    for (let j = 0; j < np; j++) {
      const tau = ((j + (rho > 0 ? 0.3 : 0.8)) / (np + 0.6)) * 0.9;
      C(tau, c);
      dC(tau, dir);
      const Nc = Nb.clone().addScaledVector(dir, -Nb.dot(dir)).normalize();
      const Wc = v3().crossVectors(dir, Nc);
      const basi = Wc.dot(T) * rho < 0;
      let pl = p0 * (1 - 0.62 * tau) * (j === 0 ? 0.9 : 1);
      if (sp.basal && basi && tb < 0.3 && j < 2) pl *= j === 0 ? 1.35 : 1.12;
      pl *= rng.float(0.93, 1.07) * (1 - 0.15 * young);
      const beta = sp.beta + rng.float(-0.08, 0.08);
      const dP = dir.clone().multiplyScalar(Math.cos(beta)).addScaledVector(Wc, rho * Math.sin(beta)).addScaledVector(Nc, 0.14 + 0.2 * young).normalize();
      const nP = Nc.clone().addScaledVector(dP, -Nc.dot(dP)).normalize();
      const base = c.clone().addScaledVector(Wc, rho * 0.0003).addScaledVector(dP, -0.0007);
      const bite = rng.chance(0.035);
      const brown = !young && rng.chance(0.03);
      const k = rng.float(0.93, 1.06) * ao;
      const cb = mul3(tint, k);
      const cTip = mulv(cb, BROWN_TIP);
      const r = blade(LS, base, dP, nP, pl, pl * 0.4 * rng.float(0.92, 1.08), ATLAS[bite ? sp.bite : sp.pinnule].r, {
        nx,
        ny,
        fold: 0.16,
        arch: 0.18 + 0.4 * young,
        curl: young * 1.2,
        color: brown ? (s, t) => mix3(cb, cTip, smoothstep(0.45, 1, t)) : (s, t) => mul3(cb, 0.9 + 0.12 * t),
        sway: swA,
      });
      if (o.dew && rng.chance(0.08)) B.addDew(r.tip, r.tipN, LS, swA, 'fern');
    }
  }
  // pinnatifid pinna tip
  C(0.9, c);
  dC(0.9, dir);
  const Nc = Nb.clone().addScaledVector(dir, -Nb.dot(dir)).normalize();
  const r = blade(LS, c, dir, Nc, p0 * 0.95, p0 * 0.38, ATLAS[sp.pinnule].r, { nx, ny, fold: 0.16, arch: 0.2, color: mul3(tint, ao), sway: swA });
  if (o.dew) B.addDew(r.tip, r.tipN, LS, swA, 'fern');
}

// A young pinna still rolled up toward its tip (fiddleheads, the top of an unrolling frond).
function emitYoungPinna(B, sp, prm, pn, o, sw) {
  const { LS } = B;
  const e = pn.e;
  LS.sec = SEC_SHARED;
  const D = pn.D0.clone().addScaledVector(pn.T, 0.6 * (1 - e)).addScaledVector(pn.Nb, 0.3).normalize();
  const n = pn.Nb.clone().addScaledVector(D, -pn.Nb.dot(D)).normalize();
  const ell = pn.ell * (0.35 + 0.6 * e);
  blade(LS, pn.A, D, n, ell, ell * PINNA_ASPECT * (0.5 + 0.5 * e), ATLAS[sp.pinna].r, {
    nx: 1,
    ny: 5,
    fold: 0.9 * (1 - e) + 0.2,
    arch: 0.3,
    curl: 3.2 * (1 - e) + 0.4,
    color: mul3(sp.young, 1.05),
    sway: sw(pn.s),
  });
}

function emitFrond(B, sp, prm, plan, o) {
  const { LS, SS, q } = B;
  const L = plan.L;
  const rng = new RNG(prm.seed);
  const sw = (s) => Math.pow(clamp(s / L), 1.7) * (L / 0.45) * o.swayK;
  const elBase = { kind: o.kind, anchor: o.crown, rnd: prm.rnd, group: GROUP.fern, phase: prm.phase, flutter: o.flutter, spot: o.sid };
  // stipe and rachis
  SS.sec = SEC_SHARED;
  SS.el({ ...elBase, rough: 0.55, trans: 0.2 });
  const r0 = sp.r0 * (0.75 + 0.5 * L);
  const radii = plan.sArr.map((s) => Math.max(0.00032, r0 * (1 - 0.8 * Math.pow(Math.min(1, s / L), 0.8))));
  const colAt = (s) => {
    const f = s / L;
    if (f < 0.07) return mix3(sp.stipeBase, sp.stipeMid, f / 0.07);
    if (f < prm.sb) return mix3(sp.stipeMid, sp.rachis, smoothstep(0.07, prm.sb, f));
    return sp.rachis;
  };
  const yk = o.young ? 1.15 : 1;
  tube(SS, plan.pts, radii, { radial: q.radial, side: plan.lat3, color: (i) => mul3(colAt(plan.sArr[i]), yk), sway: (i) => sw(plan.sArr[i]) });
  // the scaly foot of the stipe
  const nFoot = Math.max(2, plan.sArr.findIndex((s) => s > 0.14 * L));
  const foot = plan.pts.slice(0, nFoot + 1);
  tube(SS, foot, foot.map((_, i) => radii[i] * lerp(1.35, 1.05, i / nFoot)), {
    radial: q.radial,
    side: plan.lat3,
    rect: ATLAS.scales.r,
    color: rgb(120, 84, 50),
    sway: (i) => sw(plan.sArr[i]),
  });
  // pinnae
  LS.el({ ...elBase, rough: 0.55, trans: 0.85 });
  for (const pn of plan.pinnae) {
    if (pn.e < 0.85) emitYoungPinna(B, sp, prm, pn, o, sw);
    else emitPinna(B, sp, prm, pn, o, sw, rng);
  }
  // the pinnatifid frond tip
  let tip = plan.apex;
  if (plan.termLen > 0) {
    LS.sec = SEC_SHARED;
    const r = blade(LS, plan.term.p, plan.term.T, plan.tipNb, plan.termLen, plan.termLen * PINNA_ASPECT * 0.85, ATLAS[sp.pinna].r, {
      nx: 1,
      ny: 2,
      arch: 0.15,
      color: prm.tint,
      sway: sw(L),
    });
    if (o.dew) B.addDew(r.tip, r.tipN, LS, sw(L), 'fern');
    tip = r.tip;
  }
  return tip;
}

// Fiddleheads: a stout scaly stalk ending in a coil (tight), or with the lowest pinnae already spreading (half).
// A logarithmic spiral sampled evenly in turning angle: radius R(φ) = Rs·e^(−kφ), heading θ0 − φ.
// q = how much the radius shrinks per turn (the band thickness that makes neighbouring turns touch).
function coilPhi(x, y, th0, Rs, Re, phi, dphi) {
  const k = Math.log(Rs / Re) / phi;
  const n = Math.max(6, Math.ceil(phi / dphi));
  const out = [];
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const f0 = ((i - 1) / n) * phi;
    const f1 = (i / n) * phi;
    for (let s = 0; s < 4; s++) {
      const f = f0 + ((f1 - f0) * (s + 0.5)) / 4;
      const dl = (Rs * Math.exp(-k * f) * (f1 - f0)) / 4;
      x += Math.cos(th0 - f) * dl;
      y += Math.sin(th0 - f) * dl;
      l += dl;
    }
    out.push({ l, x, y, phi: f1, R: Rs * Math.exp(-k * f1) });
  }
  return { pts: out, Lc: l, q: Math.exp(-k * TAU) };
}

// Fresh lady-fern crozier colours (linear albedo)
const CZ = {
  green: [0.16, 0.42, 0.05], // juicy young tissue
  outer: [0.24, 0.5, 0.06], // the sunlit outer curl: yellower, lighter
  deep: [0.1, 0.32, 0.035], // the tight centre
  stalk: [0.21, 0.45, 0.075], // a little paler yellow-green
  flush: [0.3, 0.17, 0.1], // pinkish-brown near the base
  scale: [0.42, 0.3, 0.17], // pale brown papery scales
};

// A fiddlehead. It stands nearly upright from the crown, bends over in a short shepherd's crook just below its
// head, and the head (a plump, tightly packed log-spiral roll, each turn pressed against the next, the rolled
// pinnae a row of beads along both flanks) turns its face toward `o.face`: the sky and the passing lens.
//   tight – the whole blade still rolled up;  half – the lowest pinnae spread, still rolled at their tips
// Ld = the horizontal direction it leans toward; o: { len, psi, hook, scale, face, hero, drop }.
function emitCrozier(B, sp, crown, Ld, stage, rng, sid, o = {}) {
  const { SS, GS, q } = B;
  const hero = !!o.hero;
  const tight = stage === 'tight';
  const sc = o.scale ?? 1;
  const psi = rng.float(...(o.psi ?? [0.05, 0.2]));
  const Y = UP.clone().multiplyScalar(Math.cos(psi)).addScaledVector(Ld, Math.sin(psi)).normalize();
  // the crook bends the head toward H: mostly along the glide (keeps the clump narrow across it)
  const H0 = o.hookDir ?? v3().crossVectors(UP, Ld).normalize();
  const H = H0.clone().multiplyScalar(rng.sign()).applyAxisAngle(Y, rng.float(-0.35, 0.35));
  H.addScaledVector(Y, -H.dot(Y)).normalize();
  const lat3 = v3().crossVectors(Y, H).normalize();
  const sA = rng.float(...(o.len ?? (tight ? [0.08, 0.12] : [0.13, 0.18])));
  const e0 = rng.float(84, 89) * DEG;
  const eA = rng.float(...(o.hook ?? [-6, 14])) * DEG;
  const Rs = (tight ? rng.float(0.0095, 0.012) : rng.float(0.0068, 0.0085)) * sc;
  const Re = 0.0011 * sc;
  const phi = (tight ? rng.float(3.0, 3.6) : rng.float(1.8, 2.2)) * TAU;
  const kind = tight ? KIND.CROZ_TIGHT : KIND.CROZ_HALF;
  const rnd = rng.next();
  const phase = rng.float(0, TAU);
  // the stalk: upright, its bend gathered into the top few centimetres (sampled densely there)
  const P2 = [{ x: 0, y: 0, s: 0, l: -1, phi: 0, R: 0 }];
  let x = 0;
  let y = 0;
  const nA = hero ? 22 : 16;
  const th = (s) => e0 - (e0 - eA) * Math.pow(s / sA, 7);
  let sPrev = 0;
  for (let i = 1; i <= nA; i++) {
    const s1 = sA * (1 - Math.pow(1 - i / nA, 1.8));
    for (let k = 0; k < 6; k++) {
      const a = th(sPrev + ((s1 - sPrev) * (k + 0.5)) / 6);
      x += (Math.cos(a) * (s1 - sPrev)) / 6;
      y += (Math.sin(a) * (s1 - sPrev)) / 6;
    }
    sPrev = s1;
    P2.push({ x, y, s: s1, l: -1, phi: 0, R: 0 });
  }
  const c = coilPhi(x, y, eA, Rs, Re, phi, q.coilStep * (hero ? 1 : 1.35));
  for (const p of c.pts) P2.push({ x: p.x, y: p.y, s: sA + p.l, l: p.l, phi: p.phi, R: p.R });
  const Lc = c.Lc;
  const pts = P2.map((p) => crown.clone().addScaledVector(H, p.x).addScaledVector(Y, p.y));
  // turn the head about the end of the crook so the face of its spiral looks toward o.face
  const T0 = v3().subVectors(pts[nA + 1], pts[nA - 1]).normalize();
  const pivot = pts[nA].clone();
  let tw = 0;
  if (o.face) {
    const nd = o.face.clone().add(v3(rng.float(-0.2, 0.2), 0, rng.float(-0.2, 0.2))).normalize();
    nd.addScaledVector(T0, -nd.dot(T0));
    if (nd.lengthSq() > 1e-6) {
      nd.normalize();
      tw = Math.atan2(v3().crossVectors(lat3, nd).dot(T0), lat3.dot(nd));
      if (Math.abs(tw) > Math.PI / 2) tw -= Math.sign(tw) * Math.PI;
    }
  }
  const sides = P2.map((p, i) => {
    const a = p.l < 0 ? 0 : tw * smoothstep(0, 0.06 * Lc, p.l);
    if (a) pts[i].sub(pivot).applyAxisAngle(T0, a).add(pivot);
    return lat3.clone().applyAxisAngle(T0, a);
  });
  // the inside of the curl, per ring (for the adaxial groove and the scaly back of the coil)
  const n = pts.length;
  const inner = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    return v3().addVectors(a, b).addScaledVector(p, -2);
  });
  for (let i = n - 2; i >= 0; i--) if (inner[i].lengthSq() < 1e-14) inner[i].copy(inner[i + 1]);
  for (const v of inner) v.normalize();
  const iG = nA - 1;
  const TG = v3().subVectors(pts[iG + 1], pts[iG - 1]).normalize();
  const NG = sides[iG].clone().addScaledVector(TG, -sides[iG].dot(TG)).normalize();
  const BG = v3().crossVectors(TG, NG);
  const aIn = BG.dot(inner[iG]) > 0 ? Math.PI / 2 : -Math.PI / 2;
  // radii: a 3–4 mm stalk; in the head the band is as thick as the gap to the next turn (no gaps), wider across
  const rS = (hero ? rng.float(0.0017, 0.002) : 0.0015) * sc;
  const band = (R) => 0.5 * R * (1 - c.q) * 1.08;
  const radii = P2.map((p) => {
    if (p.l < 0) return rS * (1.08 - 0.16 * (p.s / sA));
    return lerp(rS * 0.92, band(p.R), smoothstep(0, 0.07 * Lc, p.l));
  });
  const nz = rng.float(0, 50);
  const swayK = hero ? 0.1 : 0.25;
  const sw = (yy) => Math.pow(Math.max(0, yy) / 0.25, 1.5) * swayK;
  const scaleAt = (p, dens) => dens * smoothstep(0.42, 0.62, 0.5 + 0.5 * noise2(p.x * 760 + p.y * 330 + nz, p.z * 760 - p.y * 510));
  // dew: a drop resting on top of the roll (placed first: the coil darkens in a wet ring under it)
  let drop = null;
  if (o.drop) {
    let top = -1;
    for (let i = nA + 1; i < n; i++) {
      const p = P2[i];
      if (p.l < 0.15 * Lc || p.l > 0.55 * Lc) continue;
      if (top < 0 || pts[i].y > pts[top].y) top = i;
    }
    if (top >= 0) {
      const up = sides[top].y >= 0 ? sides[top] : sides[top].clone().negate();
      const Rd = rng.float(0.0014, 0.0019);
      drop = { i: top, Rd, at: pts[top].clone().addScaledVector(up, radii[top] * 1.3).addScaledVector(UP, Rd * 0.55) };
    }
  }
  SS.sec = SEC_SHARED;
  SS.el({ kind, anchor: crown, rnd, rough: 0.3, trans: 0.25, group: GROUP.none, phase, flutter: 0, spot: sid });
  tube(SS, pts, radii, {
    radial: q.coilRadial,
    side: sides,
    mod: (i, a) => {
      const p = P2[i];
      // the stalk: round, with a shallow groove along its inner (upper) side
      if (p.l < 0) return 1 - 0.2 * Math.exp(-((angAbs(a - aIn) / 0.5) ** 2));
      const w = smoothstep(0, 0.08 * Lc, p.l);
      const ca = Math.cos(a) * Math.cos(a);
      // the rolled pinnae: ~10 beads per turn along both flanks
      const bead = 0.24 * ca * ca * ca * (0.5 + 0.5 * Math.cos(p.phi * 10));
      return 1 + w * (0.42 * ca + bead);
    },
    color: (i, u, pv) => {
      const p = P2[i];
      let col;
      let dens;
      if (p.l < 0) {
        const f = p.s / sA;
        col = mix3(CZ.flush, CZ.stalk, smoothstep(0.02, 0.3, f));
        dens = 0.55 * (1 - smoothstep(0.05, 0.45, f)) + 0.06;
      } else {
        const t = p.l / Lc;
        col = mix3(CZ.outer, CZ.green, smoothstep(0.08, 0.45, t));
        col = mix3(col, CZ.deep, smoothstep(0.5, 0.95, t));
        // papery scales mostly on the back (the outside) of the roll
        const back = v3().subVectors(pv, pts[i]).dot(inner[i]) < 0;
        dens = back ? 0.32 : 0.05;
      }
      col = mix3(col, CZ.scale, scaleAt(pv, dens));
      // a darker, wet ring where the drop touches the roll
      if (drop) col = mul3(col, 1 - 0.32 * smoothstep(drop.Rd * 1.7, drop.Rd * 0.9, pv.distanceTo(drop.at)));
      // contact shadow at the crown
      return mul3(col, 0.45 + 0.55 * smoothstep(0, 0.045, pv.y - crown.y));
    },
    sway: (i) => sw(P2[i].y),
  });
  // the drop itself: a sessile lens; its colour is the coil beneath it (the shader looks through it)
  if (drop) {
    const { Rd, at } = drop;
    GS.el({ kind: KIND.DEW, anchor: crown, rnd, rough: 0.05, trans: 0, group: GROUP.none, phase, flutter: 0, spot: sid });
    revolve(GS, frameAxis(at.clone().addScaledVector(UP, Rd * 0.8), v3(0, -1, 0)), (v, out) => {
      const ph = v * Math.PI;
      out[0] = Rd * Math.sin(ph) * (1 + 0.12 * v);
      out[1] = Rd * (1 - Math.cos(ph)) * 0.8;
      return out;
    }, 14, 9, { color: mix3(CZ.outer, CZ.green, 0.4), sway: sw(P2[drop.i].y) });
  }
  // half-unrolled: the lowest pinnae are spreading, still rolled at their tips
  if (!tight) {
    const pairs = 8;
    const ring = (s) => {
      let i = 0;
      while (i < nA - 1 && P2[i + 1].s < s) i++;
      return { i, t: clamp((s - P2[i].s) / Math.max(1e-6, P2[i + 1].s - P2[i].s)) };
    };
    for (let k = 0; k < pairs; k++) {
      for (const sig of [1, -1]) {
        const f = 0.5 + (0.38 * (k + (sig < 0 ? 0.5 : 0))) / pairs;
        const { i, t } = ring(f * sA);
        const A = pts[i].clone().lerp(pts[i + 1], t);
        const T = v3().subVectors(pts[i + 1], pts[i]).normalize();
        const Sp = lat3.clone().addScaledVector(T, -lat3.dot(T)).normalize();
        const Nb = v3().crossVectors(Sp, T).normalize();
        if (Nb.dot(H) < 0) Nb.negate();
        const e = 0.72 - 0.5 * (k / pairs);
        const D0 = Sp.clone().multiplyScalar(sig * Math.cos(0.9)).addScaledVector(T, Math.sin(0.9)).normalize();
        B.LS.el({ kind, anchor: crown, rnd, rough: 0.4, trans: 0.4, group: GROUP.none, phase, flutter: 0.2, spot: sid });
        const ell = (hero ? lerp(0.045, 0.024, k / pairs) : lerp(0.04, 0.02, k / pairs)) * sc;
        emitYoungPinna(B, sp, null, { A, T, Nb, D0, e, ell, s: f * sA }, {}, () => sw(A.y - crown.y));
      }
    }
  }
}

// Last year's fronds, flattened and brown on the moss around the crown.
function emitDeadFrond(B, sp, crown, az, Lw, rng, sid) {
  const { LS, SS } = B;
  const n = 12;
  const pts = [];
  let a = az;
  const curv = rng.float(-0.8, 0.8);
  let x = crown.x;
  let z = crown.z;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    if (i > 0) {
      x += (Math.cos(a) * Lw) / n;
      z += (Math.sin(a) * Lw) / n;
      a += (curv * Lw) / n;
    }
    pts.push(v3(x, heroHeightAt(x, z) + 0.004 + 0.02 * Math.pow(1 - s, 3), z));
  }
  const rnd = rng.next();
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.DEAD, anchor: crown, rnd, rough: 0.8, trans: 0.1, spot: sid });
  tube(SS, pts, pts.map((_, i) => lerp(0.0016, 0.0004, i / n)), { radial: 4, color: rgb(78, 52, 30) });
  LS.sec = SEC_SHARED;
  LS.el({ kind: KIND.DEAD, anchor: crown, rnd, rough: 0.75, trans: 0.3, spot: sid });
  const pairs = 11;
  for (let k = 1; k < pairs; k++) {
    const t = k / pairs;
    for (const sig of [1, -1]) {
      if (rng.chance(0.3)) continue;
      const i = Math.min(n - 1, Math.floor(t * n));
      const A = pts[i].clone().lerp(pts[i + 1], t * n - i);
      const T = v3().subVectors(pts[i + 1], pts[i]).normalize();
      const side = v3().crossVectors(UP, T).normalize().multiplyScalar(sig);
      const D = side.clone().multiplyScalar(Math.cos(0.5)).addScaledVector(T, Math.sin(0.5)).normalize();
      const nrm = UP.clone().applyAxisAngle(D, rng.float(-0.4, 0.4)).addScaledVector(D, -0.15);
      const ell = sp.pinnaMax * Lw * 0.75 * sp.profile(t) * rng.float(0.7, 1.0);
      const col = [rng.float(0.6, 0.85), rng.float(0.16, 0.23), rng.float(0.45, 0.7)];
      blade(LS, A.clone().addScaledVector(UP, 0.002), D, nrm, ell, ell * PINNA_ASPECT * rng.float(0.6, 0.9), ATLAS[sp.pinna].r, {
        nx: 1,
        ny: 2,
        arch: rng.float(-0.3, 0.2),
        curl: rng.float(0, 1.4),
        fold: rng.float(0.2, 0.7),
        color: col,
      });
    }
  }
}

// The air above a spot, up to the camera's ceiling: fronds must not hide what grows there.
function airAbove(spot, extra) {
  const c = fromPatch(spot.u, spot.v);
  const g = heroHeightAt(c.x, c.z);
  return { a: v3(c.x, g - 0.05, c.z), b: v3(c.x, g + 0.6, c.z), r: spot.r + extra };
}

// The dew module's silk thread as a straight segment (its sag stays inside the radius).
function silkSegment() {
  const S = FLOOR_PLANTS.silk;
  const T = FLOOR_PLANTS.silkTo;
  const a = fromPatch(S.u, S.v);
  const b = fromPatch(T.u, T.v);
  return { a: v3(a.x, heroHeightAt(a.x, a.z) + S.h, a.z), b: v3(b.x, heroHeightAt(b.x, b.z) + T.h, b.z), r: 0.06 };
}

// Turn a frond a little at a time until it fits (fitFrond); returns the best { L, H }.
function fitTurning(sp, prm, crown, az, fit, Lwant, Lgood) {
  let best = { L: 0, H: null };
  for (let k = 0; k < 9; k++) {
    const a = az + (k ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.16 : 0);
    const H = v3(Math.cos(a), 0, Math.sin(a));
    const L = fitFrond(sp, prm, crown, H, fit, Lwant);
    if (L > best.L) best = { L, H };
    if (L >= Lgood) break;
  }
  return best;
}

function fernClump(B, spotName, species, seed) {
  const { q, SS } = B;
  const spot = SPOTS[spotName];
  const sid = SPOT_ID[spotName];
  const sp = FERN[species];
  const rng = new RNG(seed);
  const cXZ = fromPatch(spot.u, spot.v);
  const cen = v3(cXZ.x, 0, cXZ.z);
  // the crown sits toward the glide line, so its fronds reach in over it
  const cw = fromPatch(spot.u, spot.v - Math.sign(spot.v) * 0.05);
  const crown = v3(cw.x, heroHeightAt(cw.x, cw.z) - 0.008, cw.z);
  const R = spot.r - 0.012;
  const toward = fromPatch(spot.u, 0);
  const a0 = Math.atan2(toward.z - crown.z, toward.x - crown.x);
  const G = v3(Math.cos(a0), 0, Math.sin(a0));
  const crozCounts = q.croz[species === 'lady' ? 'lady' : 'buck'];
  const silk = spotName === 'fernRight';
  const avoid = ['fiddleheadsA', 'fiddleheadsB'].filter((n) => SPOTS[n]).map((n) => airAbove(SPOTS[n], 0.06));
  if (silk) avoid.push(silkSegment());
  const fit = { cen, R, reach: 0.42, hMax: 0.44, avoid };
  // the fronds fanning out behind collapse onto the moss in autumn: they must not lie over anyone else's spot
  const others = Object.entries(SPOTS).filter(([n, s]) => s.owner !== 'plants' && !(s.shares && s.shares.includes('plants')));
  const fitOut = { ...fit, avoid: [...avoid, ...others.map(([, s]) => airAbove(s, 0.03))] };

  // ── this year's open fronds: most arch in over the glide line (into the frame), the rest fan out behind ──
  const nOpen = species === 'lady' ? q.lady : q.buck;
  const nIn = Math.round(nOpen * 0.6);
  for (let f = 0; f < nOpen; f++) {
    const inward = f < nIn;
    const az = inward
      ? a0 + lerp(-1.15, 1.15, (f + 0.5) / nIn) + rng.float(-0.12, 0.12)
      : a0 + Math.PI + lerp(-1.5, 1.5, (f - nIn + 0.5) / (nOpen - nIn)) + rng.float(-0.15, 0.15);
    // inward fronds lean out further and hold their tips up, so they rise over the frame instead of into the moss
    const prm = frondParams(sp, rng, q.frondSeg, inward ? { e0: rng.float(48, 62) * DEG, eT: rng.float(-6, 10) * DEG, bend: rng.float(1.5, 2.0) } : {});
    const { L, H } = fitTurning(sp, prm, crown, az, inward ? fit : fitOut, rng.float(0.4, 0.55), 0.3);
    if (L < 0.2) continue;
    emitFrond(B, sp, prm, frondPlan(sp, prm, crown, H, L), { kind: inward ? KIND.FROND_IN : KIND.FROND, crown, sid, swayK: 1, flutter: 0.6 });
  }

  // ── the still frond that holds the silk thread (right clump) ──
  if (silk) {
    const S = FLOOR_PLANTS.silk;
    const t = fromPatch(S.u, S.v);
    const ty = heroHeightAt(t.x, t.z) + S.h;
    const dx = t.x - crown.x;
    const dz = t.z - crown.z;
    const D = Math.hypot(dx, dz);
    const H = v3(dx / D, 0, dz / D);
    const prm = frondParams(sp, rng, q.frondSeg, { lat: 0, eT: 6 * DEG, bend: 1.8, twist0: 0.05, twist1: 0.1, pinnaScale: 0.85 });
    // the apex height over its reach only depends on the starting angle: solve that, then scale to reach it
    const ratio = (ty - crown.y) / D;
    let lo = 30 * DEG;
    let hi = 89 * DEG;
    for (let i = 0; i < 30; i++) {
      prm.e0 = (lo + hi) / 2;
      const ap = frondPlan(sp, prm, v3(), H, 1).apex;
      if (ap.y / Math.hypot(ap.x, ap.z) < ratio) lo = prm.e0;
      else hi = prm.e0;
    }
    const ap = frondPlan(sp, prm, v3(), H, 1).apex;
    const L = D / Math.hypot(ap.x, ap.z);
    const plan = frondPlan(sp, prm, crown, H, L);
    B.silkAnchor = emitFrond(B, sp, prm, plan, { kind: KIND.FROND_STILL, crown, sid, swayK: 0.15, flutter: 0, dew: true }).clone();
  }

  // ── fiddleheads at the crown (late May – mid July) ──
  const near = () => {
    const a = rng.float(0, TAU);
    const r = rng.float(0.006, 0.035);
    const x = crown.x + Math.cos(a) * r;
    const z = crown.z + Math.sin(a) * r;
    return v3(x, heroHeightAt(x, z) - 0.006, z);
  };
  const away = G.clone().negate();
  const face = UP.clone().addScaledVector(G, 0.6).normalize();
  for (let i = 0; i < crozCounts[0]; i++) emitCrozier(B, sp, near(), away, 'tight', rng, sid, { psi: [0.05, 0.2], len: [0.09, 0.14], face });
  for (let i = 0; i < crozCounts[1]; i++) emitCrozier(B, sp, near(), away, 'half', rng, sid, { psi: [0.2, 0.38], len: [0.14, 0.19], face });
  for (let i = 0; i < crozCounts[2]; i++) {
    // nearly open: full length, still erect and pale, the tip in a small crook
    const base = near();
    const prm = frondParams(sp, rng, q.frondSeg, {
      e0: rng.float(76, 84) * DEG,
      eT: rng.float(18, 32) * DEG,
      bend: 2,
      asc: 0.35,
      crook: { Rs: 0.0036, Re: 0.0008, phi: 0.8 * TAU },
      tint: sp.young,
    });
    const { L, H } = fitTurning(sp, prm, base, a0 + rng.float(-0.9, 0.9), fit, rng.float(0.3, 0.4), 0.26);
    if (L < 0.18) continue;
    emitFrond(B, sp, prm, frondPlan(sp, prm, base, H, L), { kind: KIND.CROZ_LATE, crown: base, sid, swayK: 0.7, flutter: 0.3, young: 0.6 });
  }

  // ── last year's fronds lying flat, and the old stipe bases of the crown ──
  for (let i = 0; i < q.dead; i++) {
    const az = a0 + Math.PI * rng.float(0.45, 1.55);
    const H = v3(Math.cos(az), 0, Math.sin(az));
    // as long as the spot allows in that direction
    const c = v3().subVectors(crown, cen).setY(0);
    const b = c.dot(H);
    const reach = -b + Math.sqrt(Math.max(0, b * b - c.lengthSq() + R * R));
    emitDeadFrond(B, sp, crown, az, Math.min(reach - 0.03, rng.float(0.22, 0.32)), rng, sid);
  }
  crownStubs(B, rng, crown, rng.int(6, 10), sid);
}

// Old stipe bases around a crown: short, dark, scaly.
function crownStubs(B, rng, crown, n, sid, scale = 1) {
  const { SS } = B;
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.STATIC, anchor: crown, rnd: 0.5, rough: 0.85, trans: 0, spot: sid });
  for (let i = 0; i < n; i++) {
    const az = (i / n) * TAU + rng.float(-0.3, 0.3);
    const lean = rng.float(0.3, 0.9);
    const d = v3(Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean));
    const p0 = crown.clone().addScaledVector(d, 0.004);
    const len = rng.float(0.015, 0.04) * scale;
    const pts = [p0, p0.clone().addScaledVector(d, len * 0.5), p0.clone().addScaledVector(d, len).addScaledVector(UP, -len * 0.15)];
    tube(SS, pts, [0.0028, 0.0024, 0.0018].map((r) => r * scale), { radial: 5, rect: ATLAS.scales.r, color: rgb(70, 46, 28) });
  }
}

// Last year's papery brown scales and broken frond bases, tufted around a crown.
function crownTufts(B, rng, crown, n, sid, reach = 0.03) {
  const { SS } = B;
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.STATIC, anchor: crown, rnd: 0.5, rough: 0.75, trans: 0.2, spot: sid });
  for (let i = 0; i < n; i++) {
    const a = rng.float(0, TAU);
    const r = rng.float(0.004, reach);
    const x = crown.x + Math.cos(a) * r;
    const z = crown.z + Math.sin(a) * r;
    const p0 = v3(x, heroHeightAt(x, z) - 0.001, z);
    const d = v3(Math.cos(a + rng.float(-1, 1)), rng.float(0.2, 0.9), Math.sin(a + rng.float(-1, 1))).normalize();
    const len = rng.float(0.004, 0.009);
    const curl = v3().crossVectors(d, UP).normalize();
    const pts = [p0, p0.clone().addScaledVector(d, len * 0.5), p0.clone().addScaledVector(d, len).addScaledVector(curl, len * 0.25).addScaledVector(UP, -len * 0.2)];
    const col = mix3(rgb(150, 98, 52), rgb(96, 60, 32), rng.next());
    tube(SS, pts, [0.0011, 0.0008, 0.00025], { radial: 3, rect: ATLAS.scales.r, color: col });
  }
}

// A young fern crown: fiddleheads from late May through August, a couple of small fronds for the rest of the year.
// Like a shuttlecock: the croziers rise from one crown in a tight ring, at different heights and stages, their
// heads turned up to the sky and the passing lens; only the opening ones lean out.
// o.hero: the close-up's star beside the ant trail, in the sun pool, in view on phones (heads within |v| ≲ 0.12):
// tall (15–30 cm) so they rise toward the lens, dew on two of the coils.
function fiddleheadGroup(B, spotName, species, seed, o = {}) {
  const spot = SPOTS[spotName];
  if (!spot) return;
  const { q } = B;
  const hero = !!o.hero;
  const sid = SPOT_ID[spotName];
  const sp = FERN[species];
  const rng = new RNG(seed);
  const sc = hero ? 1 : 0.85;
  const c = fromPatch(spot.u, spot.v);
  const cen = v3(c.x, 0, c.z);
  const crown = v3(c.x, heroHeightAt(c.x, c.z) - 0.006, c.z);
  const toward = fromPatch(spot.u, 0);
  const a0 = Math.atan2(toward.z - crown.z, toward.x - crown.x);
  const G = v3(Math.cos(a0), 0, Math.sin(a0)); // toward the glide line
  const along = v3(PATCH.u.x, 0, PATCH.u.y); // along the glide
  const face = UP.clone().addScaledVector(G, 0.35).normalize();
  const [nTight, nHalf, nLate, nSmall] = hero ? q.hero : q.fidd;
  const n = nTight + nHalf + nLate;
  const ring = spot.r * 0.45;
  const az0 = rng.float(0, TAU);
  let k = 0;
  const base = () => {
    const a = az0 + (k++ / n) * TAU + rng.float(-0.3, 0.3);
    const r = rng.float(0.35, 1) * ring;
    const x = crown.x + Math.cos(a) * r;
    const z = crown.z + Math.sin(a) * r;
    return v3(x, heroHeightAt(x, z) - 0.006, z);
  };
  const tilt = (dir, spread) => dir.clone().applyAxisAngle(UP, rng.float(-spread, spread));
  // tight crooks: nearly upright, leaning a touch toward the glide line, crooks bent along it
  for (let i = 0; i < nTight; i++) {
    emitCrozier(B, sp, base(), tilt(G, 1.3), 'tight', rng, sid, {
      psi: [0.03, 0.16],
      len: hero ? [0.14, 0.22] : [0.08, 0.13],
      hook: [-6, 14],
      hookDir: along,
      scale: sc,
      face,
      hero,
      drop: hero && i < 2,
    });
  }
  // opening: taller, leaning out over the trail side, the lowest pinnae spreading
  for (let i = 0; i < nHalf; i++) {
    emitCrozier(B, sp, base(), tilt(G, 0.7), 'half', rng, sid, {
      psi: [0.22, 0.4],
      len: hero ? [0.16, 0.22] : [0.12, 0.16],
      hook: [0, 18],
      hookDir: along,
      scale: sc,
      face,
      hero,
    });
  }
  // uncurling: rising toward the lens, pale, the tip still in a crook and its upper pinnae still rolled
  const fit = { cen, R: spot.r - 0.006, reach: hero ? 0.2 : 0.22, hMax: 0.4, avoid: [] };
  for (let i = 0; i < nLate; i++) {
    const b = base();
    const prm = frondParams(sp, rng, q.frondSeg, {
      e0: rng.float(76, 84) * DEG,
      eT: rng.float(25, 38) * DEG,
      bend: 2,
      asc: 0.35,
      crook: { Rs: hero ? 0.0055 : 0.0042, Re: 0.0009, phi: (hero ? 2.2 : 1.6) * TAU },
      youngFrom: hero ? (i % 2 ? 0.62 : 0.45) : 0.6,
      tint: sp.young,
    });
    const az = Math.atan2(G.z, G.x) + (i % 2 ? 1 : -1) * rng.float(0.2, 0.9);
    const { L, H } = fitTurning(sp, prm, b, az, fit, hero ? rng.float(0.28, 0.34) : rng.float(0.24, 0.3), 0.22);
    if (L >= 0.16) emitFrond(B, sp, prm, frondPlan(sp, prm, b, H, L), { kind: KIND.CROZ_LATE, crown: b, sid, swayK: hero ? 0.4 : 0.7, flutter: 0.3, young: 0.6 });
  }
  // small fronds fanning out on the far side, away from the trail and the lens' centre line
  for (let i = 0; i < nSmall; i++) {
    const prm = frondParams(sp, rng, Math.max(12, q.frondSeg - 6), { e0: rng.float(50, 62) * DEG, eT: rng.float(0, 12) * DEG, pinnaScale: 0.85 });
    const { L, H } = fitTurning(sp, prm, crown, a0 + Math.PI + (i ? 1 : -1) * rng.float(0.3, 0.9), { ...fit, reach: 0.24 }, rng.float(0.17, 0.22), 0.15);
    if (L >= 0.12) emitFrond(B, sp, prm, frondPlan(sp, prm, crown, H, L), { kind: KIND.FROND, crown, sid, swayK: 1, flutter: 0.6 });
  }
  crownStubs(B, rng, crown, hero ? 7 : 4, sid, 0.7);
  crownTufts(B, rng, crown, hero ? 10 : 5, sid, ring * 1.2);
}

// ═══════════════════════════════════════════════════════════════
// Bilberry (Vaccinium myrtillus)
// ═══════════════════════════════════════════════════════════════
const bilSway = (plant, p) => Math.pow(Math.min(1.3, Math.max(0, p.y - plant.gy) / 0.25), 1.5) * 0.7;

function bilberry(B) {
  const { q } = B;
  const spot = SPOTS.bilberry;
  const sid = SPOT_ID.bilberry;
  const rng = new RNG(2207);
  const lim = spot.r - 0.115;
  const clumps = [[0, 0], [0.07, -0.06], [-0.06, 0.05], [0.04, 0.08], [-0.07, -0.06]];
  for (let i = 0; i < q.bil; i++) {
    const c = clumps[i % clumps.length];
    let du = c[0] + rng.gauss() * 0.04;
    let dv = c[1] + rng.gauss() * 0.04;
    const dd = Math.hypot(du, dv);
    if (dd > lim) {
      du *= lim / dd;
      dv *= lim / dd;
    }
    const { x, z } = fromPatch(spot.u + du, spot.v + dv);
    const gy = heroHeightAt(x, z);
    const ck = 1 - Math.hypot(du, dv) / spot.r;
    const H = rng.float(0.1, 0.16) + 0.1 * ck;
    const az = rng.float(0, TAU);
    const lean = rng.float(0.12, 0.42);
    const dir = v3(Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean));
    const plant = { base: v3(x, gy - 0.006, z), gy, phase: rng.float(0, TAU), rnd: rng.next(), sid };
    bilShoot(B, rng, plant, plant.base, dir, H, 0.00125, 0);
  }
}

// A broom-like shoot: zigzag green twigs branching from a third of the height up, leaves on the young twigs.
function bilShoot(B, rng, plant, p0, dir, len, r0, order) {
  const { LS, SS, q } = B;
  const nn = order === 0 ? rng.int(7, 9) : order === 1 ? rng.int(4, 6) : rng.int(3, 4);
  const seg = len / nn;
  const zig = rng.float(0.16, 0.28);
  const side = perpTo(dir).applyAxisAngle(dir.clone().normalize(), rng.float(0, TAU));
  const pts = [p0.clone()];
  const dirs = [dir.clone()];
  const d = dir.clone();
  const p = p0.clone();
  for (let k = 1; k <= nn; k++) {
    const ax = v3().crossVectors(d, side);
    if (ax.lengthSq() > 1e-8) d.applyAxisAngle(ax.normalize(), (k % 2 ? 1 : -1) * zig);
    d.lerp(UP, order === 0 ? 0.06 : 0.015).normalize();
    p.addScaledVector(d, seg * rng.float(0.85, 1.15));
    pts.push(p.clone());
    dirs.push(d.clone());
  }
  const radii = pts.map((_, k) => r0 * (1 - 0.55 * (k / nn)));
  const stemCol = rgb(74, 120, 42);
  const oldCol = rgb(92, 82, 46);
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.BIL_STEM, anchor: plant.base, rnd: plant.rnd, rough: 0.48, trans: 0.1, phase: plant.phase, spot: plant.sid });
  // angular, ridged green twigs
  tube(SS, pts, radii, {
    radial: 4,
    rot: Math.PI / 4,
    mod: (i, a) => 1 + 0.14 * Math.cos(4 * (a - Math.PI / 4)),
    color: (i) => (order === 0 && i < 2 ? mix3(oldCol, stemCol, i / 2) : stemCol),
    sway: (i) => bilSway(plant, pts[i]),
  });
  for (let k = 1; k <= nn; k++) {
    const node = pts[k];
    const dk = dirs[k];
    const tk = k / nn;
    if (order < 2 && k >= 1 && k < nn && rng.chance(order === 0 ? (k < 3 ? 0.45 : 0.6) : 0.42)) {
      const perp = side.clone().applyAxisAngle(dk, rng.float(0, TAU));
      perp.addScaledVector(dk, -perp.dot(dk)).normalize();
      const ba = rng.float(0.5, 0.9);
      const bd = dk.clone().multiplyScalar(Math.cos(ba)).addScaledVector(perp, Math.sin(ba)).normalize();
      bilShoot(B, rng, plant, node, bd, len * rng.float(0.35, 0.6) * (1 - 0.4 * tk), radii[k] * 0.75, order + 1);
    }
    if ((order === 0 && k < 3) || !rng.chance(0.95)) continue;
    // an alternate leaf: thin, finely serrated, held near-horizontal
    const sgn = k % 2 ? 1 : -1;
    const perp = side.clone().multiplyScalar(sgn).applyAxisAngle(dk, rng.float(-0.5, 0.5));
    perp.addScaledVector(dk, -perp.dot(dk)).normalize();
    const la = rng.float(0.85, 1.2);
    const ld = dk.clone().multiplyScalar(Math.cos(la)).addScaledVector(perp, Math.sin(la));
    ld.y *= 0.55;
    ld.normalize();
    const ln = UP.clone().addScaledVector(ld, -ld.y).normalize().applyAxisAngle(ld, rng.float(-0.35, 0.35));
    const llen = rng.float(0.014, 0.024) * (1 - 0.25 * tk) * (order ? 0.9 : 1);
    const leafR = rng.next();
    LS.sec = SEC_SHARED;
    LS.el({ kind: KIND.BIL_LEAF, anchor: node, rnd: leafR, rough: 0.55, trans: 1, group: GROUP.berry, phase: plant.phase, flutter: 0.6, spot: plant.sid });
    const tint = mul3([0.62, 0.64, 0.55], rng.float(0.88, 1.08) * (0.9 + 0.15 * tk));
    const r = blade(LS, node.clone().addScaledVector(ld, 0.0012), ld, ln, llen, llen * 0.6, ATLAS[rng.chance(0.07) ? 'bilLeafBite' : 'bilLeaf'].r, {
      nx: 2,
      ny: q.leafNy,
      fold: 0.14,
      arch: 0.18,
      twist: rng.float(-0.25, 0.25),
      color: (s, t) => mul3(tint, 0.9 + 0.12 * t),
      sway: (s, t, P) => bilSway(plant, P),
    });
    if (rng.chance(0.5)) B.addDew(r.tip, r.tipN, LS, bilSway(plant, r.tip), 'bilberry');
    // flowers and berries are solitary in the leaf axils, and not many
    if (B.bilFruit < q.bilFruit && tk > 0.25 && rng.chance(0.13)) {
      B.bilFruit++;
      bilFruit(B, rng, plant, node, ld);
    }
  }
}

// A flower and, at the same axil, the berry that follows it.
function bilFruit(B, rng, plant, node, ld) {
  const { SS, q } = B;
  const hz = v3(ld.x, 0, ld.z).normalize();
  const a = node.clone().addScaledVector(hz, 0.0015).addScaledVector(UP, -0.0008);
  const rnd = rng.next();
  const sway = (u, v, p) => bilSway(plant, p);
  // flower: a rosy, globular urn on a short nodding pedicel
  SS.el({ kind: KIND.BIL_FLOWER, anchor: a, rnd, rough: 0.5, trans: 0.45, phase: plant.phase, flutter: 0.4, spot: plant.sid });
  const pf = [a, a.clone().addScaledVector(hz, 0.0018).addScaledVector(UP, -0.0012), a.clone().addScaledVector(hz, 0.0024).addScaledVector(UP, -0.0036)];
  tube(SS, pf, [0.0003, 0.00027, 0.00025], { radial: 3, color: rgb(120, 110, 52), sway: (i) => bilSway(plant, pf[i]) });
  const urn = polyProfile([[0.0004, 0], [0.0013, 0.0005], [0.0021, 0.0016], [0.0024, 0.003], [0.0021, 0.0042], [0.0012, 0.005], [0.0011, 0.0052], [0.0014, 0.0055]]);
  const cB = mul3(rgb(178, 70, 86), 0.82);
  const cM = mul3(rgb(226, 158, 162), 0.82);
  const cT = mul3(rgb(232, 214, 188), 0.82);
  revolve(SS, frameAxis(pf[2], v3(0, -1, 0).addScaledVector(hz, 0.3)), urn, q.berryNu, 7, {
    disp: (th, v) => [v > 0.85 ? 0.00025 * Math.cos(5 * th) * smoothstep(0.85, 1, v) : 0, 0],
    color: (u, v) => (v < 0.4 ? mix3(cB, cM, v / 0.4) : mix3(cM, cT, smoothstep(0.55, 1, v))),
    sway,
  });
  // berry: blue-black under a dusty bloom, with the ringed crown at its lower end
  SS.el({ kind: KIND.BIL_BERRY, anchor: a, rnd, rough: 0.55, trans: 0.05, phase: plant.phase, flutter: 0.3, spot: plant.sid });
  const pb = [a.clone(), a.clone().addScaledVector(hz, 0.0022).addScaledVector(UP, -0.0016), a.clone().addScaledVector(hz, 0.003).addScaledVector(UP, -0.0048)];
  tube(SS, pb, [0.00036, 0.0003, 0.0003], { radial: 3, color: rgb(96, 82, 48), sway: (i) => bilSway(plant, pb[i]) });
  const R = rng.float(0.0031, 0.0041);
  const bloom = rgb(74, 86, 124);
  const dark = rgb(30, 32, 58);
  const crown = rgb(40, 30, 46);
  const nz = rng.float(0, 50);
  const prof = (v, out) => {
    const ph = v * Math.PI;
    out[0] = R * Math.sin(ph);
    out[1] = R * (1 - Math.cos(ph)) * 0.92;
    return out;
  };
  revolve(SS, frameAxis(pb[2], v3(0, -1, 0).addScaledVector(hz, 0.25)), prof, q.berryNu, q.berryNv, {
    disp: (th, v) => {
      const rim = smoothstep(0.76, 0.84, v) * (1 - smoothstep(0.86, 0.93, v));
      return [rim * 0.00025 * (1 + 0.5 * Math.cos(5 * th)), -smoothstep(0.86, 1, v) * R * 0.32];
    },
    color: (u, v) => {
      const n = noise2(Math.cos(u * TAU) * 1.5 + nz, Math.sin(u * TAU) * 1.5 + v * 3);
      let c = mix3(bloom, dark, smoothstep(0.3, 0.7, n) * 0.7);
      if (v > 0.82) c = mix3(c, crown, smoothstep(0.82, 0.9, v));
      if (v < 0.1) c = mix3(c, rgb(84, 56, 76), 1 - v / 0.1);
      return c;
    },
    sway,
  });
}

// ═══════════════════════════════════════════════════════════════
// Lingonberry (Vaccinium vitis-idaea)
// ═══════════════════════════════════════════════════════════════
const linProfile = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.03 + 0.95 * t)), 0.62) * (0.92 + 0.16 * t);

function lingon(B) {
  const { q, GS } = B;
  const spot = SPOTS.lingon;
  const sid = SPOT_ID.lingon;
  const rng = new RNG(3307);
  const lb = SPOTS.ladybird;
  const lim = spot.r - 0.045;
  const groups = [[lb.u - spot.u, lb.v - spot.v], [-0.08, 0.05], [0.06, -0.09], [-0.05, -0.08], [0.1, 0.05], [-0.11, -0.01]];
  const ladyXZ = fromPatch(lb.u, lb.v);
  for (let i = 0; i < q.lin; i++) {
    const gp = groups[i % groups.length];
    let du = gp[0] + (i === 0 ? 0 : rng.gauss() * 0.032);
    let dv = gp[1] + (i === 0 ? 0 : rng.gauss() * 0.032);
    const dd = Math.hypot(du, dv);
    if (dd > lim) {
      du *= lim / dd;
      dv *= lim / dd;
    }
    const { x, z } = fromPatch(spot.u + du, spot.v + dv);
    const gy = heroHeightAt(x, z);
    const base = v3(x, gy - 0.004, z);
    const H = rng.float(0.05, 0.09) + 0.05 * (1 - Math.hypot(du, dv) / spot.r);
    // the stem: decumbent at the foot, then ascending
    const az = rng.float(0, TAU);
    const lean = rng.float(0.2, 0.65);
    const d0 = v3(Math.cos(az) * Math.sin(lean), Math.cos(lean), Math.sin(az) * Math.sin(lean));
    const nS = 6;
    const pts = [base.clone()];
    for (let k = 1; k <= nS; k++) pts.push(pts[k - 1].clone().addScaledVector(d0.clone().addScaledVector(UP, 0.16 * k).normalize(), H / nS));
    const acc = [0];
    for (let k = 1; k <= nS; k++) acc.push(acc[k - 1] + pts[k].distanceTo(pts[k - 1]));
    const Ls = acc[nS];
    const rnd = rng.next();
    GS.sec = SEC_SHARED;
    GS.el({ kind: KIND.LIN_STEM, anchor: base, rnd, rough: 0.6, trans: 0.05, spot: sid });
    tube(GS, pts, pts.map((_, k) => lerp(0.00095, 0.0006, k / nS)), {
      radial: 4,
      color: (k) => mix3(rgb(92, 52, 34), rgb(96, 104, 48), k / nS),
    });
    const along = (s) => {
      let k = 0;
      while (k < nS - 1 && acc[k + 1] < s) k++;
      const t = clamp((s - acc[k]) / (acc[k + 1] - acc[k]));
      return { p: pts[k].clone().lerp(pts[k + 1], t), d: v3().subVectors(pts[k + 1], pts[k]).normalize() };
    };
    // leaves: a dense spiral, larger and more spreading low down, small and fresh at the top
    let s = rng.float(0.012, 0.024);
    let phy = rng.float(0, TAU);
    while (s < Ls - 0.0015) {
      const t = s / Ls;
      const { p, d } = along(s);
      phy += 137.5 * DEG;
      const perp = perpTo(d).applyAxisAngle(d, phy);
      const la = lerp(1.25, 0.7, t) + rng.float(-0.15, 0.15);
      const ld = d.clone().multiplyScalar(Math.cos(la)).addScaledVector(perp, Math.sin(la));
      ld.y *= 0.75;
      ld.normalize();
      const ln = UP.clone().addScaledVector(ld, -ld.y).normalize().applyAxisAngle(ld, rng.float(-0.3, 0.3));
      const top = Ls - s < 0.008;
      const len = (top ? rng.float(0.007, 0.01) : lerp(0.019, 0.011, t)) * rng.float(0.88, 1.12);
      const lr = rng.next();
      GS.el({ kind: KIND.LIN_LEAF, anchor: base, rnd: lr, rough: 0.3, trans: 0.12, group: GROUP.lingon, spot: sid });
      const k = rng.float(0.88, 1.1);
      const tint = top ? [1.25, 1.22, 0.9] : t < 0.3 ? [0.82 * k, 0.84 * k, 0.8 * k] : [k, k, k];
      const blotch = !top && t < 0.45 && rng.chance(0.1);
      const r = blade(GS, p.clone().addScaledVector(ld, 0.0007), ld, ln, len, len * 0.52, ATLAS.linLeaf.r, {
        nx: q.linLeaf[0],
        ny: q.linLeaf[1],
        profile: linProfile,
        cup: -0.32,
        roll: 0.6,
        arch: 0.1,
        twist: rng.float(-0.15, 0.15),
        color: blotch ? (sx, tt) => mix3(tint, [2.0, 0.55, 0.55], smoothstep(0.55, 0.95, tt) * 0.8) : tint,
      });
      if (r.midN.y > 0.72) {
        const pp = r.mid.clone().addScaledVector(r.midN, 0.0005);
        B.perchCands.push({ p: pp, n: r.midN.clone(), d: Math.hypot(pp.x - ladyXZ.x, pp.z - ladyXZ.z) });
      }
      if (rng.chance(0.3)) B.addDew(r.tip, r.tipN, GS, 0, 'lingon');
      s += lerp(0.0055, 0.003, t) * rng.float(0.8, 1.2);
    }
    const tip = pts[nS];
    const dTip = v3().subVectors(pts[nS], pts[nS - 1]).normalize();
    const ha = rng.float(0, TAU);
    const hz = v3(Math.cos(ha), 0, Math.sin(ha));
    if (rng.chance(0.55)) lingonFlowers(B, rng, tip, dTip, hz, sid);
    if (rng.chance(0.62)) lingonBerries(B, rng, tip, hz, sid);
  }
}

function lingonFlowers(B, rng, tip, dTip, hz, sid) {
  const { GS, q } = B;
  const rnd = rng.next();
  GS.el({ kind: KIND.LIN_FLOWER, anchor: tip, rnd, rough: 0.45, trans: 0.45, flutter: 0.3, spot: sid });
  const rach = [
    tip.clone(),
    tip.clone().addScaledVector(dTip, 0.002).addScaledVector(hz, 0.002),
    tip.clone().addScaledVector(hz, 0.005).addScaledVector(UP, -0.0012),
    tip.clone().addScaledVector(hz, 0.007).addScaledVector(UP, -0.0036),
  ];
  tube(GS, rach, [0.0003, 0.00028, 0.00025, 0.00022], { radial: 3, color: rgb(120, 40, 34) });
  const bell = polyProfile([[0.0003, 0], [0.0011, 0.0004], [0.0019, 0.0015], [0.0023, 0.003], [0.0025, 0.0043], [0.0029, 0.0051], [0.0034, 0.005]]);
  const cBase = mul3(rgb(222, 138, 156), 0.8);
  const cBody = mul3(rgb(236, 208, 212), 0.8);
  const cLobe = mul3(rgb(230, 166, 182), 0.8);
  const nb = rng.int(2, 5);
  for (let b = 0; b < nb; b++) {
    const f = 0.25 + (0.75 * b) / Math.max(1, nb - 1);
    const i = Math.min(2, Math.floor(f * 3));
    const at = rach[i].clone().lerp(rach[i + 1], f * 3 - i);
    const out = hz.clone().applyAxisAngle(UP, rng.float(-1.2, 1.2));
    const pe = at.clone().addScaledVector(out, 0.0012).addScaledVector(UP, -0.0022);
    tube(GS, [at, pe], [0.00022, 0.0002], { radial: 3, color: rgb(150, 50, 44) });
    revolve(GS, frameAxis(pe, v3(0, -1, 0).addScaledVector(out, rng.float(0.1, 0.4))), bell, q.bellNu > 12 ? 12 : 8, q.bellNv, {
      disp: (th, v) => [v > 0.7 ? 0.0003 * Math.cos(4 * th) * smoothstep(0.7, 1, v) : 0, v > 0.85 ? -0.0003 * Math.max(0, Math.cos(4 * th)) : 0],
      color: (u, v) => (v < 0.25 ? mix3(cBase, cBody, v / 0.25) : mix3(cBody, cLobe, smoothstep(0.7, 1, v))),
      uv: rectUV(ATLAS.bell.r),
    });
  }
}

// 2–5 berries (5–7 mm) hanging on their own short pedicels from a little raceme that curves down from the shoot
// tip. Unripe they are pale green-white with a pink blush on top (the colour shift + uKBlush), ripe glossy red.
function lingonBerries(B, rng, tip, hz, sid) {
  const { GS, q } = B;
  const rnd = rng.next();
  GS.el({ kind: KIND.LIN_BERRY, anchor: tip, rnd, rough: 0.16, trans: 0.1, flutter: 0, spot: sid });
  const n = rng.int(2, 5);
  const rach = [
    tip.clone(),
    tip.clone().addScaledVector(hz, 0.002).addScaledVector(UP, 0.0008),
    tip.clone().addScaledVector(hz, 0.0045).addScaledVector(UP, -0.001),
    tip.clone().addScaledVector(hz, 0.0062).addScaledVector(UP, -0.0036),
  ];
  tube(GS, rach, [0.00028, 0.00026, 0.00023, 0.0002], { radial: 3, color: rgb(110, 40, 30) });
  const red = rgb(178, 18, 24);
  const deep = rgb(128, 10, 16);
  const calyx = rgb(60, 26, 16);
  const side = v3().crossVectors(UP, hz).normalize();
  for (let b = 0; b < n; b++) {
    const R = rng.float(0.0026, 0.0034);
    const f = n > 1 ? 0.3 + (0.7 * b) / (n - 1) : 0.7;
    const i = Math.min(2, Math.floor(f * 3));
    const att = rach[i].clone().lerp(rach[i + 1], f * 3 - i);
    // alternate sides of the raceme, so neighbours just touch instead of melting into a ball
    const out = side.clone().multiplyScalar(b % 2 ? 1 : -1).multiplyScalar(rng.float(0.7, 1)).addScaledVector(hz, rng.float(0.1, 0.5)).normalize();
    const top = att.clone().addScaledVector(out, 0.0016 + R * 0.6).addScaledVector(UP, -0.0018);
    const c = top.clone().addScaledVector(UP, -R).addScaledVector(out, R * 0.25);
    const gy = heroHeightAt(c.x, c.z);
    const lift = Math.max(0, gy + R - 0.001 - c.y);
    top.y += lift;
    c.y += lift;
    tube(GS, [att, att.clone().lerp(top, 0.5).addScaledVector(UP, 0.0006), top], [0.0002, 0.00018, 0.00016], { radial: 3, color: rgb(120, 44, 32) });
    const axis = v3().subVectors(c, top).normalize();
    const nz = rng.float(0, 40);
    revolve(GS, frameAxis(top, axis), (v, o) => {
      const ph = v * Math.PI;
      o[0] = R * Math.sin(ph) * (1 + 0.04 * Math.sin(ph * 2));
      o[1] = R * (1 - Math.cos(ph)) * 0.96;
      return o;
    }, q.berryNu, q.berryNv, {
      disp: (th, v) => [0, -smoothstep(0.9, 1, v) * R * 0.12],
      color: (u, v) => {
        let col = mix3(red, deep, 0.5 + 0.5 * noise2(Math.cos(u * TAU) + nz, Math.sin(u * TAU) + v * 2.5));
        // the shaded underside of a hanging berry, and the dark remains of the calyx at its tip
        col = mul3(col, lerp(1, 0.62, smoothstep(0.4, 1, v)));
        if (v > 0.9) col = mix3(col, calyx, smoothstep(0.9, 0.97, v));
        return col;
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Twinflower (Linnaea borealis)
// ═══════════════════════════════════════════════════════════════
function twinflower(B) {
  const { q, GS, LL } = B;
  const spot = SPOTS.twinflower;
  const sid = SPOT_ID.twinflower;
  const rng = new RNG(4409);
  const c0 = fromPatch(spot.u, spot.v);
  const R = spot.r - 0.035;
  const stalkSites = [];
  const leafPair = (node, fwd, size, k) => {
    const side = v3().crossVectors(UP, fwd).normalize();
    for (const sg of [1, -1]) {
      const dir = side.clone().multiplyScalar(sg).addScaledVector(fwd, rng.float(0.1, 0.5)).addScaledVector(UP, rng.float(0.1, 0.35)).normalize();
      const n = UP.clone().addScaledVector(dir, -dir.y).normalize().applyAxisAngle(dir, rng.float(-0.25, 0.25));
      const lb = node.clone().addScaledVector(dir, 0.0025).addScaledVector(UP, 0.0015);
      GS.el({ kind: KIND.TWIN_RUNNER, anchor: node, rnd: 0.5, rough: 0.6, trans: 0.1, spot: sid });
      tube(GS, [node.clone(), lb], [0.00035, 0.0003], { radial: 3, color: rgb(96, 70, 40) });
      const lr = rng.next();
      LL.sec = SEC_SHARED;
      LL.el({ kind: KIND.TWIN_LEAF, anchor: node, rnd: lr, rough: 0.42, trans: 0.55, group: GROUP.lingon, flutter: 0.15, spot: sid });
      const len = size * rng.float(0.85, 1.15);
      const r = blade(LL, lb, dir, n, len, len * (96 / 112), ATLAS.twinLeaf.r, {
        nx: 2,
        ny: 2,
        fold: 0.08,
        cup: 0.12,
        arch: -0.1,
        twist: rng.float(-0.2, 0.2),
        color: mul3([0.9, 0.9, 0.86], rng.float(0.85, 1.1) * (k ? 1 : 0.9)),
      });
      if (rng.chance(0.35)) B.addDew(r.tip, r.tipN, LL, 0, 'twinflower');
    }
  };
  // a runner meandering through the moss, now and then forking into a side runner
  const runner = (x0, z0, head0, steps, depth, rI) => {
    let px = x0;
    let pz = z0;
    let head = head0;
    const pts = [];
    const forks = [];
    for (let k = 0; k <= steps; k++) {
      if (k > 0) {
        head += rng.float(-0.45, 0.45) + Math.sin(k * 0.7 + rI) * 0.12;
        const dx = px - c0.x;
        const dz = pz - c0.z;
        const dist = Math.hypot(dx, dz);
        if (dist > R * 0.7) {
          const back = Math.atan2(-dz, -dx);
          head += Math.atan2(Math.sin(back - head), Math.cos(back - head)) * smoothstep(R * 0.7, R, dist) * 0.9;
        }
        px += Math.cos(head) * 0.017;
        pz += Math.sin(head) * 0.017;
      }
      pts.push(v3(px, heroHeightAt(px, pz) + 0.002 + 0.003 * Math.abs(Math.sin(k * 1.3 + rI)), pz));
      if (depth < 2 && k > 1 && k < steps - 3 && rng.chance(0.13)) forks.push([px, pz, head + rng.sign() * rng.float(0.6, 1.1), Math.round(steps * rng.float(0.35, 0.6)), depth + 1, rI + k]);
    }
    GS.sec = SEC_SHARED;
    GS.el({ kind: KIND.TWIN_RUNNER, anchor: pts[0], rnd: 0.5, rough: 0.6, trans: 0.1, spot: sid });
    tube(GS, pts, pts.map((_, k) => lerp(0.00075, 0.0005, k / steps)), { radial: 4, color: (k) => mix3(rgb(104, 58, 40), rgb(96, 96, 48), k / steps) });
    for (let k = 1; k <= steps; k++) {
      const node = pts[k];
      const fwd = v3().subVectors(pts[k], pts[k - 1]).setY(0).normalize();
      leafPair(node, fwd, rng.float(0.008, 0.012), 1);
      if (rng.chance(0.28)) {
        // a short ascending shoot with two decussate leaf pairs
        const h = rng.float(0.02, 0.04);
        const lean = fwd.clone().multiplyScalar(rng.float(0.15, 0.4)).add(UP).normalize();
        const s = [node.clone(), node.clone().addScaledVector(lean, h * 0.5), node.clone().addScaledVector(lean, h)];
        GS.el({ kind: KIND.TWIN_RUNNER, anchor: node, rnd: 0.5, rough: 0.6, trans: 0.1, spot: sid });
        tube(GS, s, [0.0005, 0.00045, 0.0004], { radial: 3, color: rgb(98, 78, 44) });
        leafPair(s[1], v3().crossVectors(UP, fwd).normalize(), rng.float(0.007, 0.01), 1);
        leafPair(s[2], fwd, rng.float(0.006, 0.009), 1);
        stalkSites.push(s[2]);
      } else if (k % 3 === 0) stalkSites.push(node);
    }
    for (const f of forks) runner(...f);
  };
  for (let rI = 0; rI < q.twinRun; rI++) {
    const a0 = (rI / q.twinRun) * TAU + rng.float(-0.4, 0.4);
    const rr = R * rng.float(0.45, 0.75);
    runner(c0.x + Math.cos(a0) * rr, c0.z + Math.sin(a0) * rr, a0 + Math.PI + rng.float(-0.9, 0.9), rng.int(13, 18), 0, rI * 7);
  }
  // flower stalks: thin, upright, forked at the top into a pair of nodding pink bells
  const nFl = Math.min(q.twinFl, stalkSites.length);
  const bell = polyProfile([[0.0006, 0], [0.0009, 0.0015], [0.0014, 0.0035], [0.0024, 0.006], [0.0034, 0.0082], [0.0041, 0.0093], [0.0045, 0.0091]]);
  const cWhite = mul3(rgb(246, 226, 234), 0.78);
  const cPink = mul3(rgb(236, 168, 196), 0.78);
  const cLobe = mul3(rgb(248, 214, 226), 0.78);
  for (let f = 0; f < nFl; f++) {
    const base = stalkSites[Math.floor(((f + 0.5) / nFl) * stalkSites.length)];
    const h = rng.float(0.05, 0.075);
    const la = rng.float(0, TAU);
    const leanV = v3(Math.cos(la), 0, Math.sin(la)).multiplyScalar(rng.float(0.05, 0.2));
    const stalk = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      stalk.push(base.clone().addScaledVector(UP, h * t).addScaledVector(leanV, h * t * t).add(v3(Math.sin(t * 5 + f) * 0.001, 0, Math.cos(t * 4 + f) * 0.001)));
    }
    const rnd = rng.next();
    const phase = rng.float(0, TAU);
    const sw = (p) => Math.pow(clamp((p.y - base.y) / 0.07), 1.4) * 0.9;
    GS.el({ kind: KIND.TWIN_FLOWER, anchor: base, rnd, rough: 0.5, trans: 0.3, phase, flutter: 0.4, spot: sid });
    tube(GS, stalk, stalk.map((_, k) => lerp(0.0004, 0.00032, k / 6)), { radial: 3, color: rgb(110, 92, 50), sway: (k) => sw(stalk[k]) });
    const top = stalk[6];
    const pa = rng.float(0, TAU);
    for (const sg of [1, -1]) {
      const hd = v3(Math.cos(pa), 0, Math.sin(pa)).multiplyScalar(sg);
      const p1 = top.clone().addScaledVector(UP, 0.004).addScaledVector(hd, 0.0045);
      const p2 = p1.clone().addScaledVector(hd, 0.005).addScaledVector(UP, 0.001);
      const p3 = p2.clone().addScaledVector(hd, 0.002).addScaledVector(UP, -0.003);
      const ped = [top, p1, p2, p3];
      GS.mat(0.5, 0.3);
      tube(GS, ped, [0.0003, 0.00027, 0.00025, 0.00024], { radial: 3, color: rgb(118, 90, 52), sway: (k) => sw(ped[k]) });
      // a tiny bract at the fork
      LL.el({ kind: KIND.TWIN_FLOWER, anchor: base, rnd, rough: 0.5, trans: 0.5, phase, flutter: 0.4, spot: sid });
      blade(LL, top.clone().addScaledVector(UP, 0.001), hd.clone().addScaledVector(UP, 0.8).normalize(), UP.clone().addScaledVector(hd, -1).normalize(), 0.0022, 0.0012, ATLAS.twinLeaf.r, {
        nx: 1,
        ny: 1,
        color: [0.8, 0.85, 0.7],
        sway: sw(top),
      });
      const axis = v3(0, -1, 0).addScaledVector(hd, rng.float(0.45, 0.7));
      GS.mat(0.5, 0.6);
      revolve(GS, frameAxis(p3, axis), bell, q.bellNu, q.bellNv, {
        disp: (th, v) => [v > 0.75 ? 0.0005 * Math.cos(5 * th + pa) * smoothstep(0.75, 1, v) : 0, v > 0.85 ? -0.0004 * smoothstep(0.85, 1, v) : 0],
        color: (u, v) => (v < 0.35 ? mix3(cWhite, cPink, v / 0.35) : mix3(cPink, cLobe, smoothstep(0.6, 1, v))),
        uv: rectUV(ATLAS.bell.r),
        sway: (u, v, p) => sw(top),
      });
      // the five slender green sepals at the base of the bell
      revolve(GS, frameAxis(p3.clone().addScaledVector(axis.clone().normalize(), -0.0003), axis), polyProfile([[0.0003, 0], [0.0009, 0.0006], [0.0012, 0.0014]]), 10, 2, {
        disp: (th, v) => [v > 0.4 ? 0.0004 * Math.cos(5 * th) * v : 0, 0],
        color: rgb(96, 120, 50),
        sway: sw(top),
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Wood sorrel (Oxalis acetosella)
// ═══════════════════════════════════════════════════════════════
function woodSorrel(B) {
  const { q, GS, LL } = B;
  const spot = SPOTS.woodSorrel;
  const sid = SPOT_ID.woodSorrel;
  const rng = new RNG(5507);
  // clump layout and leaf reach scale with the spot (the sorrel lives in a small shady spot)
  const ks = Math.min(1, spot.r / 0.16);
  const clumps = [[0.03, 0.025], [-0.045, 0.03], [0.005, -0.05], [-0.025, -0.01]].slice(0, q.sorClumps).map(([a, b]) => [a * ks, b * ks]);
  let flowersLeft = q.sorFl;
  clumps.forEach(([cu, cv], ci) => {
    const c = fromPatch(spot.u + cu, spot.v + cv);
    const nLeaves = q.sorLeaves - (ci % 2);
    for (let i = 0; i < nLeaves; i++) {
      const a = rng.float(0, TAU);
      const r0 = rng.float(0, 0.018);
      const bx = c.x + Math.cos(a) * r0;
      const bz = c.z + Math.sin(a) * r0;
      const base = v3(bx, heroHeightAt(bx, bz) - 0.003, bz);
      const az = (i / nLeaves) * TAU + rng.float(-0.4, 0.4);
      const hz = v3(Math.cos(az), 0, Math.sin(az));
      const lean = rng.float(0.15, 0.5) * (0.4 + 0.6 * ks);
      const len = rng.float(0.05, 0.085);
      const pts = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        const ang = lean * (0.3 + 0.9 * t);
        pts.push(k === 0 ? base.clone() : pts[k - 1].clone().addScaledVector(UP, Math.cos(ang) * (len / 5)).addScaledVector(hz, Math.sin(ang) * (len / 5)));
      }
      const rnd = rng.next();
      const phase = rng.float(0, TAU);
      const sw = (p) => clamp((p.y - base.y) / 0.09) * 0.15;
      GS.sec = SEC_SHARED;
      GS.el({ kind: KIND.SOR_LEAF, anchor: base, rnd, rough: 0.55, trans: 0.4, phase, flutter: 0.4, spot: sid });
      tube(GS, pts, pts.map((_, k) => lerp(0.00055, 0.0004, k / 5)), { radial: 3, color: (k) => mix3(rgb(130, 64, 58), rgb(140, 160, 84), smoothstep(0, 0.6, k / 5)), sway: (k) => sw(pts[k]) });
      // three heart-shaped leaflets, folded a little along the midrib, tips drooping
      const top = pts[5];
      const ps = rng.float(0, TAU);
      LL.sec = SEC_SHARED;
      LL.el({ kind: KIND.SOR_LEAF, anchor: base, rnd, rough: 0.6, trans: 0.95, phase, flutter: 0.4, spot: sid });
      const k = rng.float(0.88, 1.1);
      for (let l = 0; l < 3; l++) {
        const la = ps + (l / 3) * TAU + rng.float(-0.12, 0.12);
        const droop = rng.float(0.12, 0.45);
        const dir = v3(Math.cos(la) * Math.cos(droop), -Math.sin(droop), Math.sin(la) * Math.cos(droop));
        const n = UP.clone().addScaledVector(dir, -dir.y).normalize();
        const wdt = rng.float(0.012, 0.018);
        const r = blade(LL, top.clone().addScaledVector(dir, 0.0008), dir, n, wdt * (112 / 128), wdt, ATLAS.sorLeaflet.r, {
          nx: 2,
          ny: 2,
          fold: 0.2,
          arch: 0.16,
          color: mul3([0.62, 0.62, 0.58], k),
          sway: (s, t, p) => sw(p),
        });
        if (rng.chance(0.4)) B.addDew(r.tip, r.tipN, LL, sw(r.tip), 'woodSorrel');
      }
    }
    // flowers: a white cup veined with lilac on a stalk as tall as the leaves
    const nF = ci === clumps.length - 1 ? flowersLeft : Math.min(flowersLeft, Math.ceil(q.sorFl / clumps.length));
    flowersLeft -= nF;
    for (let f = 0; f < nF; f++) {
      const a = rng.float(0, TAU);
      const bx = c.x + Math.cos(a) * 0.01;
      const bz = c.z + Math.sin(a) * 0.01;
      const base = v3(bx, heroHeightAt(bx, bz) - 0.003, bz);
      const h = rng.float(0.065, 0.095);
      const hz = v3(Math.cos(a), 0, Math.sin(a));
      const pts = [];
      for (let k = 0; k <= 5; k++) pts.push(base.clone().addScaledVector(UP, (h * k) / 5).addScaledVector(hz, 0.012 * Math.pow(k / 5, 2)));
      const rnd = rng.next();
      const phase = rng.float(0, TAU);
      const sw = (p) => clamp((p.y - base.y) / 0.09) * 0.4;
      GS.el({ kind: KIND.SOR_FLOWER, anchor: base, rnd, rough: 0.5, trans: 0.4, phase, flutter: 0.3, spot: sid });
      tube(GS, pts, pts.map((_, k) => lerp(0.0005, 0.0004, k / 5)), { radial: 3, color: rgb(150, 132, 104), sway: (k) => sw(pts[k]) });
      const top = pts[5];
      const axis = UP.clone().addScaledVector(hz, rng.float(0.3, 0.6)).normalize();
      const fr = frameAxis(top, axis);
      // stamens and styles
      for (let k = 0; k < 5; k++) {
        const ka = (k / 5) * TAU;
        const sd = fr.x.clone().multiplyScalar(Math.cos(ka)).addScaledVector(fr.z, Math.sin(ka));
        tube(GS, [top.clone(), top.clone().addScaledVector(axis, 0.0026).addScaledVector(sd, 0.0006)], [0.00022, 0.00015], { radial: 3, color: rgb(236, 226, 170), sway: sw(top) });
      }
      LL.el({ kind: KIND.SOR_FLOWER, anchor: base, rnd, rough: 0.5, trans: 0.55, phase, flutter: 0.3, spot: sid });
      const cup = rng.float(0.5, 0.75);
      const pa = rng.float(0, TAU);
      for (let k = 0; k < 5; k++) {
        const ka = pa + (k / 5) * TAU;
        const radial = fr.x.clone().multiplyScalar(Math.cos(ka)).addScaledVector(fr.z, Math.sin(ka));
        const dir = radial.clone().multiplyScalar(Math.cos(cup)).addScaledVector(axis, Math.sin(cup)).normalize();
        const n = axis.clone().addScaledVector(dir, -axis.dot(dir)).normalize();
        const len = rng.float(0.011, 0.014);
        blade(LL, top.clone().addScaledVector(radial, 0.0008), dir, n, len, len * 0.75, ATLAS.sorPetal.r, {
          nx: 2,
          ny: 2,
          fold: 0.1,
          cup: 0.25,
          arch: 0.3,
          twist: rng.float(-0.15, 0.15),
          color: mul3([0.68, 0.66, 0.68], rng.float(0.94, 1.04)),
          sway: sw(top),
        });
        // green sepals under the petals
        blade(LL, top.clone(), radial.clone().multiplyScalar(Math.cos(cup * 0.6)).addScaledVector(axis, Math.sin(cup * 0.6)).normalize(), n, 0.004, 0.0016, ATLAS.twinLeaf.r, {
          nx: 1,
          ny: 1,
          color: [0.9, 1.0, 0.75],
          sway: sw(top),
        });
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Chanterelles (Cantharellus cibarius)
// ═══════════════════════════════════════════════════════════════
function makeRidges(rng, n0) {
  const base = [];
  const fork = [];
  for (let k = 0; k < n0; k++) {
    base.push(((k + 0.5 + rng.float(-0.25, 0.25)) / n0) * TAU);
    fork.push(rng.float(0.3, 0.75));
  }
  const half = Math.PI / n0;
  // forked, blunt, vein-like ridges: 0 … 1 crest height
  return (th, rr, Rloc, width) => {
    let best = 1e9;
    for (let k = 0; k < n0; k++) {
      let d = angAbs(th - base[k]);
      if (rr > fork[k]) {
        const spread = ((rr - fork[k]) / (1 - fork[k])) * half * 0.5;
        d = Math.min(angAbs(th - base[k] - spread), angAbs(th - base[k] + spread));
      }
      if (d < best) best = d;
    }
    const arc = (best * Rloc) / width;
    return Math.exp(-arc * arc);
  };
}

function chanterelle(B, rng, base, axis, R, H, young, bite, rnd, sid, fallen) {
  const { SS, q } = B;
  const ctrl = young
    ? [[0, 0], [0.24, 0], [0.26, 0.15], [0.3, 0.35], [0.4, 0.55], [0.62, 0.72], [0.84, 0.83], [0.95, 0.9], [0.97, 0.97], [0.88, 1.0], [0.62, 1.02], [0.3, 1.0], [0, 0.98]]
    : [[0, 0], [0.2, 0], [0.22, 0.14], [0.25, 0.32], [0.32, 0.5], [0.48, 0.67], [0.7, 0.81], [0.9, 0.9], [1.0, 0.96], [1.02, 1.01], [0.95, 1.04], [0.75, 1.02], [0.5, 0.95], [0.25, 0.89], [0, 0.87]];
  const iM = young ? 8 : 9; // the margin
  const prof = polyProfile(ctrl.map(([r, y]) => [r * R, y * H]));
  const vR0 = prof.vAt(3);
  const vM = prof.vAt(iM);
  const rStart = ctrl[3][0] * R;
  // the knocked-over one shows its ridges to the camera: give it more resolution
  const nu = Math.round(q.chantRes[0] * (fallen ? 1.35 : 1));
  const nv = Math.round(q.chantRes[1] * (fallen ? 1.2 : 1));
  const ridge = makeRidges(rng, Math.max(8, Math.round(nu / 6)));
  const ph = [rng.float(0, TAU), rng.float(0, TAU), rng.float(0, TAU), rng.float(0, TAU)];
  const wavy = young ? 0.4 : 1;
  const A = [0.07 * wavy, 0.05 * wavy, 0.03 * wavy];
  const biteA = rng.float(0, TAU);
  const ridgeH = 0.00072 * (R / 0.03);
  const ridgeW = 0.0006 * (R / 0.03) + 0.0002;
  const pr = [0, 0];
  const pr2 = [0, 0];
  const disp = (th, v, r) => {
    const rho = clamp(r / R);
    const wav = Math.pow(rho, 2.5) * (A[0] * Math.sin(3 * th + ph[0]) + A[1] * Math.sin(5 * th + ph[1]) + A[2] * Math.sin(8 * th + ph[2]));
    let dr = wav * R;
    let dy = Math.pow(rho, 3) * H * wavy * (0.05 * Math.sin(3 * th + ph[0] + 1.1) + 0.03 * Math.sin(6 * th + ph[3]));
    const wR = smoothstep(vR0, vR0 + 0.06, v) * (1 - smoothstep(vM - 0.05, vM + 0.005, v));
    if (wR > 0) {
      const rr = clamp((r - rStart) / Math.max(1e-6, R - rStart));
      const h = ridgeH * wR * ridge(th, rr, Math.max(r, 0.002), ridgeW) * (0.5 + 0.5 * smoothstep(0, 0.3, rr));
      prof(v - 0.003, pr);
      prof(v + 0.003, pr2);
      const tr = pr2[0] - pr[0];
      const ty = pr2[1] - pr[1];
      const tl = Math.hypot(tr, ty) || 1;
      dr += (h * ty) / tl;
      dy -= (h * tr) / tl;
    }
    if (bite && rho > 0.6) {
      const da = angAbs(th - biteA);
      const k = Math.max(0, 1 - (da / 0.32) ** 2) * smoothstep(0.6, 1, rho);
      dr -= k * 0.28 * R * (0.85 + 0.15 * Math.sin(th * 40));
    }
    return [dr, dy];
  };
  const yolk = rgb(240, 172, 40);
  const topC = rgb(226, 152, 30);
  const under = rgb(242, 188, 66);
  const stem = rgb(236, 194, 96);
  const foot = rgb(212, 190, 142);
  const dirt = rgb(104, 88, 60);
  const flesh = rgb(246, 232, 182);
  const nz = rng.float(0, 60);
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.CHANT, anchor: base, rnd, rough: 0.72, trans: 0, spot: sid });
  revolve(SS, frameAxis(base, axis), prof, nu, nv, {
    disp,
    color: (u, v) => {
      const th = u * TAU;
      let c;
      if (v < vR0) {
        const f = v / vR0;
        c = mix3(foot, stem, smoothstep(0.1, 0.8, f));
        if (f < 0.12) c = mix3(dirt, c, f / 0.12);
      } else if (v < vM) c = mix3(stem, under, smoothstep(vR0, vR0 + 0.1, v));
      else c = mix3(yolk, topC, smoothstep(vM, 1, v));
      const n = noise2(Math.cos(th) * 2 + nz, Math.sin(th) * 2 + v * 5);
      c = mul3(c, 0.93 + 0.1 * n);
      if (bite && v > vM - 0.06 && angAbs(th - biteA) < 0.3) c = mix3(c, flesh, 0.6);
      return c;
    },
  });
}

function chanterelles(B) {
  const { q } = B;
  const spot = SPOTS.chanterelles;
  const sid = SPOT_ID.chanterelles;
  const rng = new RNG(6607);
  // du, dv, cap radius, height, lean, young, bitten, fallen
  const specs = [
    [0.0, 0.0, 0.03, 0.052, 0.12, false, false, false],
    [0.045, 0.02, 0.024, 0.046, 0.2, false, true, false],
    [-0.035, 0.032, 0.02, 0.04, 0.14, false, false, false],
    [0.022, -0.045, 0.013, 0.028, 0.08, true, false, false],
    [-0.03, -0.045, 0.024, 0.042, 2.05, false, false, true], // knocked over, ridges to the sky
    [0.06, -0.022, 0.016, 0.034, 0.22, true, false, false],
    [-0.066, 0.0, 0.02, 0.036, 0.25, false, false, false],
  ].slice(0, q.chant);
  const cen = fromPatch(spot.u, spot.v);
  let order = 0;
  for (const [du, dv, R, H, lean, young, bite, fallen] of specs) {
    // the element random decides when each fruit body appears and when it goes: the big one first and last
    const stay = 0.97 - order * 0.11;
    const rnd = (stay - 0.137 + order) / 7.31; // fract(rnd * 7.31 + 0.137) = stay (the shader's drop-out order)
    order++;
    const { x, z } = fromPatch(spot.u + du, spot.v + dv);
    const gy = heroHeightAt(x, z);
    // lean away from the cluster centre (the fallen one toward it)
    let ox = x - cen.x;
    let oz = z - cen.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    if (fallen) {
      ox = -ox;
      oz = -oz;
    }
    const axis = v3(ox * Math.sin(lean), Math.cos(lean), oz * Math.sin(lean)).normalize();
    const base = v3(x, gy - 0.006, z);
    if (fallen) {
      // lying upside-down-ish: the lowest point of the cap margin rests in the moss, the stem sticks up
      const cy = axis.y * 0.96 * H;
      base.y = gy - 0.003 - cy + R * Math.sqrt(1 - axis.y * axis.y);
    }
    chanterelle(B, rng, base, axis, R, H, young, bite, rnd, sid, fallen);
  }
}

// ═══════════════════════════════════════════════════════════════
// Fly agaric (Amanita muscaria): the lucky mushroom, seen as the camera tips down
// ═══════════════════════════════════════════════════════════════
// Wart sites on a cap surface F(u, v): denser toward the centre (v → 1); keep(p) may refuse some (washed-off patches).
function sampleCapWarts(rng, F, vTop, count, minSize, maxSize, minGap, keep = null) {
  const out = [];
  const p = v3();
  const pa = v3();
  const pb = v3();
  let tries = 0;
  while (out.length < count && tries++ < count * 30) {
    const u = rng.next();
    const v = lerp(vTop, 0.995, Math.pow(rng.next(), 0.7));
    F(u, v, p);
    if (keep && !keep(p)) continue;
    const k = 1 - (v - vTop) / (1 - vTop);
    const size = lerp(maxSize, minSize, k) * rng.float(0.75, 1.2);
    if (out.some((w) => w.p.distanceTo(p) < (w.size + size) * minGap)) continue;
    F(u + 0.002, v, pa).sub(F(u - 0.002, v, pb));
    const dv = F(u, Math.min(1, v + 0.004), v3()).sub(F(u, Math.max(0, v - 0.004), v3()));
    const n = v3().crossVectors(pa, dv).normalize();
    out.push({ p: p.clone(), n, size });
  }
  return out;
}

const AM = {
  scarlet: [0.55, 0.04, 0.02],
  margin: [0.62, 0.12, 0.03], // orange-tinged toward the edge
  centre: [0.38, 0.02, 0.012], // deeper red in the middle
  rim: rgb(232, 204, 150), // the pale, faintly striate margin line
  gill: rgb(238, 236, 222),
  stem: rgb(232, 228, 214),
  veil: rgb(238, 232, 214),
  cream: rgb(224, 212, 182),
  dirt: rgb(120, 104, 80),
  flesh: rgb(246, 236, 210),
};

// One fruit body standing at `base` (on the ground). stage: 'mature' (flattening cap, gills showing under the
// margin), 'medium' (convex), 'young' (domed, densely warted, the veil still hiding the gills).
function amanitaFruit(B, rng, base, o) {
  const { q, SS } = B;
  const { R, H, stage, sid, kind = KIND.AGARIC, rnd } = o;
  const mature = stage === 'mature';
  const young = stage === 'young';
  const res = o.res ?? 1;
  const nu = Math.max(24, Math.round(q.agRes[0] * res));
  const nv = Math.max(12, Math.round(q.agRes[1] * res));
  const [snu, snv] = q.stemRes;
  const axis = v3(rng.float(-0.06, 0.06), 1, rng.float(-0.06, 0.06)).normalize();
  const fr = frameAxis(base, axis);
  const gy = base.y;
  SS.sec = SEC_SHARED;
  // ── stem: a bulb ringed with ragged veil remnants (volva), a white fibrillose stalk ──
  SS.el({ kind, anchor: base, rnd, rough: 0.65, trans: 0, spot: sid });
  const rs = R * (young ? 0.26 : 0.16);
  const rb = rs * (young ? 1.6 : 2.0);
  const Hs = H;
  const stemProf = polyProfile([
    [0, -0.012], [rb * 0.6, -0.01], [rb * 0.95, -0.004], [rb, 0.004], [rb * 0.88, 0.012], [rb * 0.66, 0.019],
    [rs * 1.12, 0.027], [rs * 1.04, Hs * 0.4], [rs * 0.97, Hs * 0.7], [rs * 0.9, Hs * 0.9], [rs * 0.86, Hs], [0, Hs],
  ]);
  const nzS = rng.float(0, 40);
  revolve(SS, fr, stemProf, snu, snv, {
    disp: (th, v, r, y) => {
      // ragged concentric rings of the universal veil on the bulb, fine fibrils along the stalk
      let bands = 0;
      for (const yc of [0.007, 0.0125, 0.018]) bands = Math.max(bands, Math.exp(-(((y - yc) / 0.0012) ** 2)));
      const n = noise2(Math.cos(th) * 2 + nzS, Math.sin(th) * 2 + y * 40);
      const torn = 0.5 + 0.5 * noise2(Math.cos(th) * 4 - nzS, Math.sin(th) * 4 + y * 90);
      return [bands * rb * 0.09 * (0.4 + 0.8 * torn) + 0.00012 * n, 0];
    },
    color: (u, v, p) => {
      const y = stemProf(v)[1];
      let c = y < 0.005 ? mix3(AM.dirt, AM.stem, smoothstep(-0.006, 0.005, y)) : AM.stem;
      if (y > 0.005 && y < 0.022) c = mix3(c, AM.cream, 0.55);
      // contact shadow where it stands in the moss
      return mul3(c, 0.5 + 0.5 * smoothstep(0, 0.03, p.y - gy));
    },
  });
  // ── the skirt: a hanging, finely striate ring (young: high up, just torn from the cap) ──
  {
    const yr = Hs * (young ? 0.86 : 0.8);
    const ph = rng.float(0, TAU);
    const drop = R * (young ? 0.12 : 0.2);
    const wide = rs * (young ? 1.5 : 1.95);
    revolve(SS, fr, polyProfile([[rs * 0.97, yr], [rs * 1.35, yr - drop * 0.2], [wide * 0.92, yr - drop * 0.65], [wide, yr - drop]]), young ? 24 : 32, 4, {
      disp: (th, v) => [0.0002 * Math.cos(th * 48) * v, (0.0015 * Math.sin(7 * th + ph) + 0.0007 * Math.sin(13 * th + ph * 2)) * v * v * (R / 0.055)],
      color: (u, v) => mix3(AM.veil, rgb(236, 226, 186), smoothstep(0.6, 1, v)),
    });
  }
  // ── the cap ──
  SS.mat(0.3, 0);
  const capPts = young
    ? [[0.2, -0.04], [0.5, -0.09], [0.8, -0.15], [0.94, -0.2], [1.0, -0.13], [0.99, 0.1], [0.9, 0.38], [0.72, 0.6], [0.46, 0.75], [0.2, 0.81], [0, 0.83]]
    : mature
      ? [[0.16, -0.055], [0.4, -0.04], [0.7, -0.075], [0.93, -0.1], [1.0, -0.075], [1.01, -0.035], [0.99, 0.005], [0.9, 0.04], [0.7, 0.11], [0.45, 0.19], [0.2, 0.24], [0, 0.25]]
      : [[0.17, -0.05], [0.42, -0.05], [0.72, -0.09], [0.94, -0.13], [1.0, -0.09], [1.0, -0.03], [0.96, 0.08], [0.82, 0.22], [0.58, 0.34], [0.3, 0.41], [0, 0.43]];
  const iM = young ? 4 : mature ? 5 : 4; // the margin
  const capProf = polyProfile(capPts.map(([r, y]) => [r * R, Hs + y * R]));
  const vM = capProf.vAt(iM);
  const vTop = capProf.vAt(iM + 2);
  const nG = Math.round(nu / 2);
  const ph2 = [rng.float(0, TAU), rng.float(0, TAU)];
  // a slug's nibble out of the mature cap's margin
  const biteA = rng.float(0, TAU);
  const bitten = mature && o.nibble;
  const capDisp = (th, v, r) => {
    const rho = clamp(r / R);
    let dr = 0.03 * R * Math.sin(th + ph2[0]) * rho;
    let dy = 0.028 * R * Math.sin(2 * th + ph2[1]) * rho * rho;
    if (!young && v < vM - 0.02) {
      // gills: between the lamellae the surface steps up into the cap flesh
      const g = Math.sin(Math.PI * clamp((v - 0.04) / (vM - 0.08)));
      dy += 0.058 * R * g * (0.5 - 0.5 * Math.cos(th * nG));
    } else if (v > vM - 0.02 && v < vTop + 0.12) {
      dr += 0.004 * R * Math.cos(th * nG) * smoothstep(vM, vM + 0.04, v); // the striate margin
    }
    if (bitten && rho > 0.7) {
      const k = Math.max(0, 1 - (angAbs(th - biteA) / 0.28) ** 2) * smoothstep(0.7, 1, rho);
      dr -= k * 0.16 * R * (0.85 + 0.15 * Math.sin(th * 50));
      dy -= k * 0.04 * R;
    }
    return [dr, dy];
  };
  const nzC = rng.float(0, 60);
  const capF = revolve(SS, fr, capProf, nu, nv, {
    disp: capDisp,
    color: (u, v) => {
      const th = u * TAU;
      if (v < vM - 0.02) return young ? AM.veil : AM.gill;
      if (v < vM + 0.01) return mix3(young ? AM.veil : AM.gill, AM.rim, smoothstep(vM - 0.02, vM + 0.005, v));
      // scarlet nearly to the edge: a thin pale line, a narrow orange-tinged band, a deeper red centre
      const t = (v - vM) / (1 - vM);
      let c = t < 0.12 ? mix3(AM.rim, AM.margin, smoothstep(0, 0.05, t)) : mix3(AM.margin, AM.scarlet, smoothstep(0.1, 0.3, t));
      c = mix3(c, AM.centre, smoothstep(0.72, 1, t));
      c = mul3(c, 0.93 + 0.09 * noise2(Math.cos(th) * 3 + nzC, Math.sin(th) * 3 + v * 6));
      if (bitten && t < 0.25 && angAbs(th - biteA) < 0.3) c = mix3(c, AM.flesh, 0.7);
      return c;
    },
  }).F;
  // ── the warts: raised, pyramidal flakes of the veil, denser toward the centre; washed off in patches on the
  // mature cap, crowded on the young one ──
  SS.mat(0.85, 0);
  const nzW = rng.float(0, 30);
  const keep = mature || stage === 'medium' ? (p) => noise2((p.x - base.x) * 60 + nzW, (p.z - base.z) * 60) > (mature ? -0.25 : -0.45) : null;
  // the young cap is crusted with veil patches (the veil has only just cracked), the old one has lost many
  const count = Math.round(q.warts * (young ? 1 : mature ? 0.85 : 0.6));
  const sz = young ? 1 : R / 0.055;
  for (const w of sampleCapWarts(rng, capF, young ? vTop - 0.04 : vTop + 0.02, count, (young ? 0.0022 : 0.002) * sz, (young ? 0.0038 : 0.0052) * sz, young ? 0.68 : 0.88, keep)) {
    wart(SS, w.p, w.n, w.size, w.size * rng.float(0.3, young ? 0.65 : 0.5), rng, mix3(AM.veil, rgb(214, 204, 170), rng.float(0, 0.6)));
  }
  // a few pine needles fallen onto the big cap
  if (o.needles) {
    SS.mat(0.7, 0);
    for (let i = 0; i < o.needles; i++) {
      const u0 = rng.next();
      const a = capF(u0, lerp(vTop + 0.1, 0.85, rng.next()), v3());
      const b = capF(u0 + rng.float(0.08, 0.2), lerp(vTop + 0.05, 0.6, rng.next()), v3());
      const m = a.clone().lerp(b, 0.5).addScaledVector(UP, 0.0015);
      tube(SS, [a.addScaledVector(UP, 0.0007), m, b.addScaledVector(UP, 0.0007)], [0.00045, 0.0004, 0.0003], { radial: 3, color: mix3(rgb(150, 82, 40), rgb(110, 70, 40), rng.next()) });
    }
  }
}

// Moss cushions hugging a mushroom's foot, and a few needles: it sits in the forest floor, not on it.
function seatInMoss(B, rng, centre, reach, sid) {
  const { SS } = B;
  SS.sec = SEC_SHARED;
  SS.el({ kind: KIND.STATIC, anchor: centre, rnd: 0.5, rough: 0.9, trans: 0.15, spot: sid });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + rng.float(-0.5, 0.5);
    const rr = Math.min(rng.float(0.012, 0.02), reach * 0.4);
    const d = rng.float(0.35, 1) * (reach - rr);
    const x = centre.x + Math.cos(a) * d;
    const z = centre.z + Math.sin(a) * d;
    const g = heroHeightAt(x, z);
    const hh = rng.float(0.008, 0.014);
    const nz = rng.float(0, 50);
    const fr = frameAxis(v3(x, g - 0.004, z), UP);
    revolve(SS, fr, (v, out) => {
      out[0] = rr * Math.cos(v * Math.PI * 0.5);
      out[1] = hh * Math.sin(v * Math.PI * 0.5);
      return out;
    }, 16, 5, {
      // soft, lumpy cushions (a fine tufty surface would cost more than it shows from the tipping camera)
      disp: (th, v) => [rr * 0.1 * noise2(Math.cos(th) * 1.6 + nz, Math.sin(th) * 1.6), hh * 0.16 * noise2(Math.cos(th) * 2.2 - nz, Math.sin(th) * 2.2 + v * 1.5)],
      color: (u, v) => mix3(rgb(70, 92, 30), rgb(110, 130, 44), 0.5 + 0.5 * noise2(Math.cos(u * TAU) * 3 + nz, v * 4)),
    });
  }
  for (let i = 0; i < 8; i++) {
    // a needle lying across the moss, both ends inside the spot
    const a = rng.float(0, TAU);
    const d = rng.float(0.3, 0.9) * reach;
    const x = centre.x + Math.cos(a) * d;
    const z = centre.z + Math.sin(a) * d;
    const dir = a + Math.PI + rng.float(-0.9, 0.9);
    const len = Math.min(rng.float(0.03, 0.05), d * 1.6);
    const x1 = x + Math.cos(dir) * len;
    const z1 = z + Math.sin(dir) * len;
    const pts = [v3(x, heroHeightAt(x, z) + 0.002, z), v3((x + x1) / 2, heroHeightAt((x + x1) / 2, (z + z1) / 2) + 0.004, (z + z1) / 2), v3(x1, heroHeightAt(x1, z1) + 0.002, z1)];
    tube(SS, pts, [0.0005, 0.00045, 0.0003], { radial: 3, color: mix3(rgb(156, 86, 42), rgb(96, 64, 36), rng.next()) });
  }
}

// The young button, still wrapped in its universal veil, pushing up through the moss.
function amanitaButton(B, rng, base, sid, rnd) {
  const { q, SS } = B;
  const [nu, nv] = q.agRes;
  const fr = frameAxis(base, v3(-0.08, 1, 0.05));
  SS.el({ kind: KIND.BUTTON, anchor: base, rnd, rough: 0.4, trans: 0, spot: sid });
  const prof = polyProfile([[0, -0.01], [0.012, -0.0085], [0.019, -0.002], [0.0215, 0.007], [0.0205, 0.016], [0.016, 0.025], [0.009, 0.031], [0, 0.0335]]);
  const red = rgb(186, 22, 14);
  const F = revolve(SS, fr, prof, Math.round(nu * 0.6), Math.round(nv * 0.8), {
    color: (u, v, p) => mul3(v < 0.42 ? mix3(AM.veil, rgb(218, 206, 180), 1 - v / 0.42) : mix3(AM.veil, red, smoothstep(0.42, 0.55, v)), 0.5 + 0.5 * smoothstep(0, 0.02, p.y - base.y)),
  }).F;
  SS.mat(0.85, 0);
  for (const w of sampleCapWarts(rng, F, 0.44, Math.round(q.btWarts * 0.8), 0.0018, 0.0032, 0.72)) {
    wart(SS, w.p, w.n, w.size, w.size * rng.float(0.45, 0.7), rng, mix3(AM.veil, AM.cream, rng.float(0, 0.5)));
  }
}

function flyAgaric(B) {
  const rng = new RNG(7707);
  const at = (spot, du, dv, sink = 0.004) => {
    const { x, z } = fromPatch(spot.u + du, spot.v + dv);
    return v3(x, heroHeightAt(x, z) - sink, z);
  };
  // the lucky group: a mature, flattening cap (12–14 cm), a younger domed one (6–8 cm), and a button
  const A = SPOTS.flyAgaric;
  if (A) {
    const sid = SPOT_ID.flyAgaric;
    amanitaFruit(B, rng, at(A, -0.012, 0.012), { stage: 'mature', R: rng.float(0.062, 0.068), H: 0.135, sid, rnd: 0.12, nibble: true, needles: 3 });
    amanitaFruit(B, rng, at(A, 0.03, -0.012), { stage: 'young', R: rng.float(0.032, 0.037), H: 0.075, sid, rnd: 0.3, res: 0.75 });
    amanitaButton(B, rng, at(A, -0.022, -0.032, 0.009), sid, 0.05);
    seatInMoss(B, rng, at(A, 0, 0, 0), A.r * 0.9, sid);
  }
  // a single fine specimen, the first thing the camera finds as it tips down
  const Bs = SPOTS.flyAgaricB;
  if (Bs) {
    const sid = SPOT_ID.flyAgaricB;
    amanitaFruit(B, rng, at(Bs, 0, 0), { stage: 'medium', R: rng.float(0.044, 0.05), H: 0.11, sid, rnd: 0.2, res: 0.8 });
    seatInMoss(B, rng, at(Bs, 0, 0, 0), Bs.r * 0.9, sid);
  }
}

// ═══════════════════════════════════════════════════════════════
// Build all geometry (pure: runs in Node too)
// ═══════════════════════════════════════════════════════════════
export function buildFloorPlantGeometry({ tier = 'medium' } = {}) {
  const q = QT[tier] ?? (tier === 'ultra' ? QT.ultra : QT.medium);
  const c = fromPatch(0, 0);
  const origin = v3(c.x, heroHeightAt(c.x, c.z), c.z);
  const B = {
    q,
    tier,
    origin,
    LS: new Soup(origin), // leaves, tall (casts shadows)
    LL: new Soup(origin), // leaves, low
    SS: new Soup(origin), // solid, tall (casts shadows)
    GS: new Soup(origin), // glossy, low
    perchCands: [],
    dewSites: [],
    silkAnchor: null,
    bilFruit: 0,
  };
  // dew only where a drop would stay put on a swaying leaf; `c` = the leaf colour under the drop (linear)
  const DEW_TINT = { crozier: [0.26, 0.4, 0.06], fern: [0.12, 0.25, 0.03], bilberry: [0.12, 0.24, 0.025], lingon: [0.035, 0.1, 0.018], twinflower: [0.055, 0.135, 0.02], woodSorrel: [0.18, 0.3, 0.05] };
  B.addDew = (p, n, soup, swayW, plant) => {
    const e = soup.e;
    const maxSway = 1.3 * swayW * FLOOR_PLANTS.windSway + 1.1 * e.flutter * FLOOR_PLANTS.windFlutter;
    if (maxSway > FLOOR_PLANTS.dewMaxSway) return;
    const nn = n.clone().normalize();
    B.dewSites.push({
      p: p.clone(),
      n: nn,
      plant,
      c: DEW_TINT[plant] ?? [0.1, 0.2, 0.03],
      maxSway,
      k: e.kind,
      rnd: e.rnd,
      anchor: v3(e.ax, e.ay, e.az),
      wind: [swayW, e.phase, e.flutter],
      cur: p.clone(),
      vis: 1,
    });
  };
  fernClump(B, 'fernLeft', 'lady', 1101);
  fernClump(B, 'fernRight', 'buckler', 1202);
  fiddleheadGroup(B, 'fiddleheadsA', 'lady', 1303, { hero: true });
  fiddleheadGroup(B, 'fiddleheadsB', 'buckler', 1404);
  bilberry(B);
  lingon(B);
  twinflower(B);
  woodSorrel(B);
  chanterelles(B);
  flyAgaric(B);
  B.perches = B.perchCands
    .sort((a, b) => a.d - b.d)
    .filter((p, i, arr) => arr.slice(0, i).every((o) => o.p.distanceTo(p.p) > 0.006))
    .slice(0, 8)
    .map(({ p, n }) => ({ p, n }));
  return B;
}

// ═══════════════════════════════════════════════════════════════
// Atlas painting (browser only)
// ═══════════════════════════════════════════════════════════════
const css = (c, k = 1, a = 1) => `rgba(${Math.round(clamp(c[0] * k, 0, 255))},${Math.round(clamp(c[1] * k, 0, 255))},${Math.round(clamp(c[2] * k, 0, 255))},${a})`;

function pinnuleW(kind, t, ph) {
  if (kind === 'lady') {
    const p = Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * t)), 0.62) * (1 - 0.22 * t);
    const lob = Math.pow(1 - Math.abs(Math.sin(Math.PI * (5.2 * t + ph))), 2.4) * smoothstep(0.03, 0.15, t) * (1 - smoothstep(0.72, 0.95, t));
    const tooth = Math.pow(1 - Math.abs(Math.sin(Math.PI * (16 * t + ph * 2))), 3);
    return p * (1 - 0.34 * lob) * (1 - 0.07 * tooth);
  }
  const p = Math.pow(Math.sin(Math.PI * (0.05 + 0.95 * t)), 0.5) * (1 - 0.3 * t);
  const lob = Math.pow(1 - Math.abs(Math.sin(Math.PI * (4.2 * t + ph))), 2.2) * smoothstep(0.03, 0.2, t) * (1 - smoothstep(0.7, 0.95, t));
  const f = fract(t * 15 + ph * 3);
  const saw = f < 0.78 ? f / 0.78 : (1 - f) / 0.22; // spiny teeth
  return p * (1 - 0.2 * lob) * (1 - 0.1 * saw);
}

function drawPinnule(g, cx, by, len, hw, kind, ph, col, veins = true) {
  const N = 96;
  g.beginPath();
  g.moveTo(cx, by);
  for (let i = 0; i <= N; i++) g.lineTo(cx + hw * pinnuleW(kind, i / N, ph), by - (i / N) * len);
  for (let i = N; i >= 0; i--) g.lineTo(cx - hw * pinnuleW(kind, i / N, ph + 0.17), by - (i / N) * len);
  g.closePath();
  const gr = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
  gr.addColorStop(0, css(col, 0.78));
  gr.addColorStop(0.5, css(col, 1.06));
  gr.addColorStop(1, css(col, 0.8));
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = css(col, 0.6, 0.45);
  g.lineWidth = Math.max(0.4, hw * 0.03);
  g.stroke();
  if (!veins) return;
  g.strokeStyle = css(col, 1.32, 0.7);
  g.lineWidth = Math.max(0.5, hw * 0.07);
  g.beginPath();
  g.moveTo(cx, by);
  g.lineTo(cx, by - len * 0.9);
  g.stroke();
  g.strokeStyle = css(col, 1.25, 0.42);
  g.lineWidth = Math.max(0.35, hw * 0.035);
  const nL = kind === 'lady' ? 5 : 4;
  for (let k = 0; k < nL; k++) {
    for (const sd of [1, -1]) {
      const t0 = (k + 0.25) / (nL + 0.5);
      const t1 = t0 + 0.1;
      const wx = hw * pinnuleW(kind, Math.min(1, t1), ph) * 0.78 * sd;
      g.beginPath();
      g.moveTo(cx, by - t0 * len);
      g.quadraticCurveTo(cx + wx * 0.4, by - (t0 + 0.05) * len, cx + wx, by - t1 * len);
      g.stroke();
    }
  }
}

function leafBite(g, x, y, r, rng) {
  g.save();
  g.beginPath();
  for (let k = 0; k < 3; k++) {
    const cx = x + rng.float(-0.3, 0.3) * r;
    const cy = y + rng.float(-0.45, 0.45) * r;
    const rr = r * rng.float(0.55, 0.9);
    g.moveTo(cx + rr, cy);
    g.arc(cx, cy, rr, 0, TAU);
  }
  g.globalCompositeOperation = 'destination-out';
  g.fill();
  // a browned, dried rim where the leaf was eaten
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(118, 90, 40, 0.85)';
  g.lineWidth = r * 0.4;
  g.stroke();
  g.restore();
}

function clipCell(g, c) {
  g.save();
  g.beginPath();
  g.rect(c.x, c.y, c.w, c.h);
  g.clip();
}

function paintPinnule(g, rng, c, kind, bite) {
  clipCell(g, c);
  const pad = 2;
  const cx = c.x + c.w / 2;
  const by = c.y + c.h - pad;
  const len = c.h - pad * 2;
  const hw = c.w / 2 - pad;
  drawPinnule(g, cx, by, len, hw, kind, rng.float(0, 0.3), kind === 'lady' ? [120, 166, 60] : [92, 140, 50]);
  if (bite) leafBite(g, cx + hw * 0.7, by - len * rng.float(0.45, 0.6), hw * 0.6, rng);
  g.restore();
}

function paintPinna(g, rng, c, kind) {
  clipCell(g, c);
  const pad = 3;
  const cx = c.x + c.w / 2;
  const by = c.y + c.h - pad;
  const len = c.h - pad * 2;
  const col = kind === 'lady' ? [120, 166, 60] : [92, 140, 50];
  const np = 13;
  const beta = kind === 'lady' ? 62 * DEG : 58 * DEG;
  const P0 = 0.19 * len;
  for (const side of [1, -1]) {
    for (let j = 0; j < np; j++) {
      const tau = ((j + (side > 0 ? 0.3 : 0.8)) / (np + 0.6)) * 0.9;
      let pl = P0 * (1 - 0.62 * tau);
      if (kind !== 'lady' && side < 0 && j === 0) pl *= 1.2;
      g.save();
      g.translate(cx + Math.sin(tau * 2) * 2, by - tau * len);
      g.rotate(side * beta);
      drawPinnule(g, 0, 0, pl, pl * 0.2, kind, rng.float(0, 0.3), col.map((x) => x * rng.float(0.92, 1.06)), true);
      g.restore();
    }
  }
  drawPinnule(g, cx + Math.sin(1.8) * 2, by - 0.88 * len, 0.12 * len, 0.03 * len, kind, 0.1, col, true);
  g.strokeStyle = css(col, 1.25);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx, by);
  for (let i = 1; i <= 20; i++) g.lineTo(cx + Math.sin((i / 20) * 0.92 * 2) * 2, by - (i / 20) * 0.92 * len);
  g.stroke();
  g.restore();
}

// Generic leaf from a half-width profile w(t) (0 base … 1 tip), with midrib and pinnate veins.
function paintLeaf(g, rng, c, w, col, veinPairs, o = {}) {
  clipCell(g, c);
  const pad = 2;
  const cx = c.x + c.w / 2;
  const by = c.y + c.h - pad;
  const len = c.h - pad * 2;
  const hw = c.w / 2 - pad;
  const N = 120;
  g.beginPath();
  g.moveTo(cx, by);
  for (let i = 0; i <= N; i++) g.lineTo(cx + hw * w(i / N), by - (i / N) * len);
  for (let i = N; i >= 0; i--) g.lineTo(cx - hw * w(i / N), by - (i / N) * len);
  g.closePath();
  const gr = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
  gr.addColorStop(0, css(col, 0.82));
  gr.addColorStop(0.5, css(col, 1.05));
  gr.addColorStop(1, css(col, 0.84));
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = css(col, 0.62, 0.5);
  g.lineWidth = 0.8;
  g.stroke();
  // fine reticulate veins
  g.save();
  g.clip();
  g.strokeStyle = css(col, 1.2, 0.12);
  g.lineWidth = 0.5;
  for (let k = 0; k < 140; k++) {
    const x = cx + rng.float(-hw, hw);
    const y = by - rng.float(0, len);
    const a = rng.float(0, TAU);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = css(col, 1.35, 0.75);
  g.lineWidth = o.midrib ?? 1.6;
  g.beginPath();
  g.moveTo(cx, by);
  g.lineTo(cx, by - len * 0.94);
  g.stroke();
  g.strokeStyle = css(col, 1.28, 0.5);
  g.lineWidth = 0.9;
  for (let k = 0; k < veinPairs; k++) {
    const t0 = 0.08 + (0.78 * k) / veinPairs;
    for (const sd of [1, -1]) {
      const t1 = Math.min(0.98, t0 + 0.16);
      const wx = hw * w(t1) * 0.85 * sd;
      g.beginPath();
      g.moveTo(cx, by - t0 * len);
      g.quadraticCurveTo(cx + wx * 0.6, by - (t0 + 0.04) * len, cx + wx, by - t1 * len);
      g.stroke();
    }
  }
  if (o.bite) leafBite(g, cx + hw * 0.8, by - len * 0.55, hw * 0.45, rng);
  g.restore();
}

const bilW = (t) => Math.pow(Math.sin(Math.PI * (0.03 + 0.97 * t)), 0.78) * (1 - 0.12 * t) * (t > 0.12 ? 1 - 0.05 * Math.pow(1 - Math.abs(Math.sin(Math.PI * 21 * t)), 4) : 1);
const twinW = (t) => {
  const p = (Math.pow(Math.sin(Math.PI * t), 0.5) * (0.62 + 0.45 * t)) / 0.9;
  const neck = t < 0.15 ? 0.4 + 0.6 * smoothstep(0, 0.15, t) : 1;
  const cren = 1 - 0.09 * Math.pow(Math.abs(Math.sin(Math.PI * (t - 0.5) * 6)), 2) * smoothstep(0.45, 0.6, t) * (1 - smoothstep(0.93, 1, t));
  return Math.min(1, p * neck * cren);
};

function paintSorrelLeaflet(g, rng, c) {
  clipCell(g, c);
  const pad = 2;
  const cx = c.x + c.w / 2;
  const by = c.y + c.h - pad;
  const L = c.h - pad * 2;
  const hw = c.w / 2 - pad;
  const col = [150, 190, 84];
  // obcordate: narrow at the base, two rounded lobes and a notch at the apex
  g.beginPath();
  g.moveTo(cx, by);
  g.bezierCurveTo(cx + hw * 0.35, by - L * 0.25, cx + hw * 1.0, by - L * 0.55, cx + hw * 0.98, by - L * 0.8);
  g.bezierCurveTo(cx + hw * 0.96, by - L * 1.0, cx + hw * 0.2, by - L * 1.02, cx, by - L * 0.86);
  g.bezierCurveTo(cx - hw * 0.2, by - L * 1.02, cx - hw * 0.96, by - L * 1.0, cx - hw * 0.98, by - L * 0.8);
  g.bezierCurveTo(cx - hw * 1.0, by - L * 0.55, cx - hw * 0.35, by - L * 0.25, cx, by);
  g.closePath();
  const gr = g.createRadialGradient(cx, by - L * 0.5, 2, cx, by - L * 0.5, hw);
  gr.addColorStop(0, css(col, 1.08));
  gr.addColorStop(1, css(col, 0.84));
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = css(col, 0.65, 0.5);
  g.lineWidth = 0.8;
  g.stroke();
  g.strokeStyle = css(col, 1.3, 0.7);
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(cx, by);
  g.lineTo(cx, by - L * 0.85);
  g.stroke();
  // dichotomous veins fanning toward the margin
  g.strokeStyle = css(col, 1.22, 0.32);
  g.lineWidth = 0.7;
  for (let k = 0; k < 5; k++) {
    for (const sd of [1, -1]) {
      const y0 = by - L * (0.12 + 0.13 * k);
      g.beginPath();
      g.moveTo(cx, y0);
      g.quadraticCurveTo(cx + sd * hw * 0.4, y0 - L * 0.12, cx + sd * hw * (0.55 + 0.08 * k), y0 - L * (0.2 + 0.02 * k));
      g.stroke();
    }
  }
  g.restore();
}

function paintSorrelPetal(g, rng, c) {
  clipCell(g, c);
  const pad = 2;
  const cx = c.x + c.w / 2;
  const by = c.y + c.h - pad;
  const L = c.h - pad * 2;
  const hw = c.w / 2 - pad;
  const path = () => {
    g.beginPath();
    g.moveTo(cx - hw * 0.12, by);
    g.bezierCurveTo(cx - hw * 0.2, by - L * 0.4, cx - hw * 1.0, by - L * 0.55, cx - hw * 0.95, by - L * 0.85);
    g.bezierCurveTo(cx - hw * 0.85, by - L * 1.02, cx + hw * 0.85, by - L * 1.02, cx + hw * 0.95, by - L * 0.85);
    g.bezierCurveTo(cx + hw * 1.0, by - L * 0.55, cx + hw * 0.2, by - L * 0.4, cx + hw * 0.12, by);
    g.closePath();
  };
  path();
  const gr = g.createLinearGradient(0, by, 0, by - L);
  gr.addColorStop(0, 'rgb(240,214,120)');
  gr.addColorStop(0.15, 'rgb(246,242,232)');
  gr.addColorStop(0.85, 'rgb(250,248,244)');
  gr.addColorStop(1, 'rgb(244,232,244)');
  g.fillStyle = gr;
  g.fill();
  g.save();
  path();
  g.clip();
  // lilac veins from the base, forking toward the rim
  g.strokeStyle = 'rgba(150,96,178,0.7)';
  for (let k = 0; k < 7; k++) {
    const f = (k - 3) / 3;
    const x1 = cx + f * hw * 0.85;
    g.lineWidth = 1.1 - Math.abs(f) * 0.3;
    g.beginPath();
    g.moveTo(cx + f * hw * 0.08, by - L * 0.05);
    g.quadraticCurveTo(cx + f * hw * 0.45, by - L * 0.5, x1, by - L * 0.86);
    g.stroke();
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(cx + f * hw * 0.55, by - L * 0.6);
    g.lineTo(x1 + hw * 0.08 * (f >= 0 ? 1 : -1), by - L * 0.93);
    g.stroke();
  }
  g.restore();
  g.restore();
}

function paintLingonLeaf(g, rng, c) {
  clipCell(g, c);
  const col = [50, 92, 42];
  g.fillStyle = css(col);
  g.fillRect(c.x, c.y, c.w, c.h);
  const cx = c.x + c.w / 2;
  const by = c.y + c.h;
  const len = c.h;
  const hw = c.w / 2;
  // darker rolled margin along the leaf outline (same profile as the geometry)
  g.strokeStyle = css(col, 0.65, 0.9);
  g.lineWidth = 5;
  for (const sd of [1, -1]) {
    g.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const x = cx + sd * hw * linProfile(t) * 0.93;
      if (i) g.lineTo(x, by - t * len);
      else g.moveTo(x, by);
    }
    g.stroke();
  }
  // impressed, paler midrib and faint laterals
  g.strokeStyle = css(col, 1.45, 0.85);
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(cx, by);
  g.lineTo(cx, by - len * 0.96);
  g.stroke();
  g.strokeStyle = css(col, 1.25, 0.3);
  g.lineWidth = 0.9;
  for (let k = 0; k < 6; k++) {
    for (const sd of [1, -1]) {
      const t0 = 0.12 + k * 0.13;
      g.beginPath();
      g.moveTo(cx, by - t0 * len);
      g.quadraticCurveTo(cx + sd * hw * 0.35, by - (t0 + 0.05) * len, cx + sd * hw * 0.75, by - (t0 + 0.12) * len);
      g.stroke();
    }
  }
  // a fine glossy mottling
  for (let k = 0; k < 90; k++) {
    g.fillStyle = css(col, rng.float(0.85, 1.2), 0.25);
    g.beginPath();
    g.arc(c.x + rng.float(0, c.w), c.y + rng.float(0, c.h), rng.float(0.6, 1.6), 0, TAU);
    g.fill();
  }
  g.restore();
}

function paintScales(g, rng, c) {
  clipCell(g, c);
  g.fillStyle = 'rgb(222,212,192)';
  g.fillRect(c.x, c.y, c.w, c.h);
  // overlapping chaffy scales, pointing up the stalk, pale with tan edges
  for (let k = 0; k < 220; k++) {
    const x = c.x + rng.float(-4, c.w + 4);
    const y = c.y + rng.float(-6, c.h + 6);
    const l = rng.float(8, 18);
    const w = l * rng.float(0.35, 0.6);
    g.save();
    g.translate(x, y);
    g.rotate(rng.float(-0.5, 0.5));
    g.beginPath();
    g.ellipse(0, -l * 0.5, w * 0.5, l * 0.5, 0, 0, TAU);
    const tone = rng.float(0.75, 1.05);
    g.fillStyle = css([236, 224, 200], tone, 0.85);
    g.fill();
    g.strokeStyle = css([150, 108, 66], tone, 0.8);
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }
  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.lineWidth = 0.6;
  for (let k = 0; k < 120; k++) {
    const x = c.x + rng.float(0, c.w);
    const y = c.y + rng.float(0, c.h);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + rng.float(-2, 2), y - rng.float(4, 9));
    g.stroke();
  }
  g.restore();
}

function paintBell(g, rng, c) {
  clipCell(g, c);
  g.fillStyle = 'rgb(252,247,247)';
  g.fillRect(c.x, c.y, c.w, c.h);
  // u = around the bell, v = base (bottom) → mouth (top): five lobes, pink nectar guides
  for (let k = 0; k < 10; k++) {
    const x = c.x + ((k + 0.5) / 10) * c.w;
    const strong = k % 2 === 0;
    const gr = g.createLinearGradient(0, c.y + c.h, 0, c.y);
    gr.addColorStop(0, 'rgba(222,140,170,0.15)');
    gr.addColorStop(0.45, `rgba(214,110,150,${strong ? 0.75 : 0.35})`);
    gr.addColorStop(1, 'rgba(230,160,186,0.1)');
    g.strokeStyle = gr;
    g.lineWidth = strong ? 3 : 1.5;
    g.beginPath();
    g.moveTo(x, c.y + c.h);
    g.lineTo(x + rng.float(-2, 2), c.y);
    g.stroke();
  }
  g.restore();
}

// Canvas → DataTexture with colour bled into transparent texels (no dark fringes once mipmapped).
function atlasTexture(cv, res, anisotropy) {
  const w = cv.width;
  const h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const img = new Uint8Array(src);
  for (const c of Object.values(ATLAS)) {
    const x0 = Math.round(c.x * res);
    const y0 = Math.round(c.y * res);
    const x1 = Math.min(w, Math.round((c.x + c.w) * res));
    const y1 = Math.min(h, Math.round((c.y + c.h) * res));
    let r = 0;
    let gg = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (img[i + 3] > 128) {
          r += img[i];
          gg += img[i + 1];
          b += img[i + 2];
          n++;
        }
      }
    }
    if (!n) continue;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (img[i + 3] < 8) {
          img[i] = r / n;
          img[i + 1] = gg / n;
          img[i + 2] = b / n;
        }
      }
    }
  }
  // two passes of edge dilation so the bleed matches the leaf right at its outline
  for (let pass = 0; pass < 2; pass++) {
    const prev = new Uint8Array(img);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (prev[i + 3] > 128) continue;
        let r = 0;
        let gg = 0;
        let b = 0;
        let n = 0;
        for (const o of [-4, 4, -w * 4, w * 4]) {
          if (prev[i + o + 3] > 128) {
            r += prev[i + o];
            gg += prev[i + o + 1];
            b += prev[i + o + 2];
            n++;
          }
        }
        if (n) {
          img[i] = r / n;
          img[i + 1] = gg / n;
          img[i + 2] = b / n;
          if (pass === 0) img[i + 3] = Math.min(img[i + 3], 8);
        }
      }
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function paintFloorAtlas({ res = 1, anisotropy = 8 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = AW * res;
  cv.height = AH * res;
  const g = cv.getContext('2d');
  g.scale(res, res);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const rng = new RNG(9157);
  g.fillStyle = '#fff';
  g.fillRect(ATLAS.white.x, ATLAS.white.y, ATLAS.white.w, ATLAS.white.h);
  paintPinnule(g, rng, ATLAS.ladyPinnule, 'lady', false);
  paintPinnule(g, rng, ATLAS.ladyPinnuleBite, 'lady', true);
  paintPinnule(g, rng, ATLAS.buckPinnule, 'buckler', false);
  paintPinnule(g, rng, ATLAS.buckPinnuleBite, 'buckler', true);
  paintPinna(g, rng, ATLAS.ladyPinna, 'lady');
  paintPinna(g, rng, ATLAS.buckPinna, 'buckler');
  paintLeaf(g, rng, ATLAS.bilLeaf, bilW, [120, 168, 56], 6);
  paintLeaf(g, rng, ATLAS.bilLeafBite, bilW, [120, 168, 56], 6, { bite: true });
  paintLeaf(g, rng, ATLAS.twinLeaf, twinW, [72, 110, 42], 3, { midrib: 1.2 });
  paintSorrelLeaflet(g, rng, ATLAS.sorLeaflet);
  paintSorrelPetal(g, rng, ATLAS.sorPetal);
  paintLingonLeaf(g, rng, ATLAS.linLeaf);
  paintScales(g, rng, ATLAS.scales);
  paintBell(g, rng, ATLAS.bell);
  return atlasTexture(cv, res, anisotropy);
}

// ═══════════════════════════════════════════════════════════════
// Materials: three's standard/physical shading + growth, wind, seasons, translucency, bloom, sky gloss
// ═══════════════════════════════════════════════════════════════
const VERT_ANIM = /* glsl */ `
#define FLOOR_NK ${NK}
attribute vec3 aWind;   // sway weight, phase, flutter
attribute vec4 aGrow;   // element anchor (object space), element random
attribute vec4 aInfo;   // kind, roughness, translucency, season group (normalised bytes)
uniform float uTime;
uniform float uWind;
uniform vec4 uFWind;    // sway (m), flutter (m)
uniform vec4 uFSnow;    // sink (m), snow cover, dew
uniform vec4 uKind[FLOOR_NK]; // grow, flatten, colour shift, loss
vec3 floorWind(vec3 p, vec3 w) {
  float t = uTime;
  float gust = 0.55 + 0.45 * sin(t * 0.37 + w.y * 0.5);
  float s = sin(t * 1.13 + w.y) * 0.62 + sin(t * 2.31 + w.y * 1.7) * 0.38;
  float c = sin(t * 0.83 + w.y * 2.1);
  vec3 off = vec3(0.82 * s + 0.2 * c, 0.0, 0.57 * s - 0.25 * c) * (w.x * uFWind.x * gust);
  float fl = sin(t * 5.7 + dot(p, vec3(9.1, 7.3, 8.3)) + w.y * 3.0) * 0.7 + sin(t * 9.3 + dot(p, vec3(-6.7, 11.0, 5.3))) * 0.3;
  off += vec3(0.35, 1.0, 0.3) * (fl * w.z * uFWind.y * (0.5 + 0.5 * gust));
  return off * uWind;
}
void floorAnimate(inout vec3 p, inout vec3 n, out vec4 K, out float r) {
  K = uKind[int(aInfo.x * 255.0 + 0.5)];
  r = aGrow.w;
  float r2 = fract(r * 7.31 + 0.137);
  // grow out of the anchor, staggered per element; lost elements collapse to nothing
  float g = clamp((K.x - r * 0.4) / 0.6, 0.0, 1.0);
  g = g * g * (3.0 - 2.0 * g) * step(K.w, r2);
  // flatten: squash toward the anchor's height, as fronds collapse onto the moss
  float fl = clamp(K.y * (0.8 + 0.4 * r2), 0.0, 1.0);
  vec3 d = p - aGrow.xyz;
  d.y *= 1.0 - 0.93 * fl;
  n = normalize(mix(n, vec3(0.0, n.y < 0.0 ? -1.0 : 1.0, 0.0), fl * 0.85));
  p = aGrow.xyz + d * g;
  p += floorWind(p, aWind) * ((1.0 - fl) * g);
  p.y -= uFSnow.x;
}
`;

const VERT_LOOK = /* glsl */ `
uniform vec4 uKFx[FLOOR_NK];
uniform vec4 uKCol[FLOOR_NK];
uniform float uKBlush[FLOOR_NK];
uniform vec4 uKFuzz[FLOOR_NK];
uniform vec3 uSColF;
uniform float uSAmtF;
uniform vec3 uSColB;
uniform float uSAmtB;
uniform vec3 uSColL;
uniform float uSAmtL;
varying vec4 vFTint;
varying vec4 vFShift;
varying vec4 vFFx;
varying vec4 vFFuzz;
varying vec3 vFMat;
varying float vFRnd;
varying float vFDrop;
void floorLook(vec4 K, float r, vec3 n) {
  int k = int(aInfo.x * 255.0 + 0.5);
  float grp = aInfo.w * 255.0;
  vec4 tint = vec4(0.0);
  if (grp > 2.5) tint = vec4(uSColL, uSAmtL);
  else if (grp > 1.5) tint = vec4(uSColB, uSAmtB);
  else if (grp > 0.5) tint = vec4(uSColF, uSAmtF);
  tint.a = clamp(tint.a * (0.6 + 0.8 * r), 0.0, 1.0);
  vFTint = tint;
  vec4 kc = uKCol[k];
  float r3 = fract(r * 3.71 + 0.53);
  vFShift = vec4(kc.rgb, clamp((K.z - r3 * 0.45) / 0.55, 0.0, 1.0) * (1.0 - uKBlush[k] * smoothstep(0.0, 0.9, n.y)));
  vFFx = uKFx[k];
  vFFuzz = uKFuzz[k];
  vFDrop = k == ${KIND.DEW} ? 1.0 : 0.0;
  vFMat = vec3(aInfo.y, aInfo.z, kc.w);
  vFRnd = r;
}
`;

const FRAG_PARS = /* glsl */ `
uniform vec4 uFSnow;
uniform vec3 uFTrans;
uniform vec2 uFEnv;
varying vec4 vFTint;
varying vec4 vFShift;
varying vec4 vFFx;
varying vec4 vFFuzz;
varying vec3 vFMat;
varying float vFRnd;
varying float vFDrop;
float fSnowMask = 0.0;
`;

const FRAG_MAP = /* glsl */ `#include <map_fragment>
#if defined( FLOOR_ALPHA ) && defined( USE_MAP )
{
  // keep thin alpha-tested edges from thinning out in the smaller mips
  vec2 fMt = vMapUv * vec2(textureSize(map, 0));
  vec2 fDx = dFdx(fMt);
  vec2 fDy = dFdy(fMt);
  float fMip = max(0.0, 0.5 * log2(max(dot(fDx, fDx), dot(fDy, fDy))));
  diffuseColor.a *= 1.0 + fMip * 0.2;
}
#endif`;

const FRAG_COLOR = /* glsl */ `#include <color_fragment>
{
  const vec3 fLum = vec3(0.299, 0.587, 0.114);
  // season tint of the shared plant groups (same formula as the rest of the forest)
  diffuseColor.rgb = mix(diffuseColor.rgb, dot(diffuseColor.rgb, fLum) / 0.32 * vFTint.rgb, vFTint.a);
  // per-kind shift: unripe berries, dead fronds, winter bronze — keeps the light and shade of the base colour
  float fL = dot(diffuseColor.rgb, fLum);
  diffuseColor.rgb = mix(diffuseColor.rgb, vFShift.rgb * clamp(fL / max(vFMat.z, 1e-3), 0.35, 1.25), vFShift.a);
  if (!gl_FrontFacing) {
    float fB = dot(diffuseColor.rgb, fLum);
    // the underside of a leaf: paler and a touch yellower, not grey
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(fB), 0.15) * vec3(1.55, 1.5, 1.25) + vec3(0.008, 0.01, 0.003), vFFx.w * 0.6);
  }
  vec3 fWn = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
  fSnowMask = smoothstep(0.15, 0.6, fWn.y + (vFRnd - 0.5) * 0.4) * uFSnow.y;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.75, 0.8), fSnowMask * 0.85);
}`;

const FRAG_ROUGH = /* glsl */ `float roughnessFactor = mix(vFMat.x * (1.0 - 0.3 * uFSnow.z * step(0.05, vFMat.y)), 0.6, fSnowMask);`;

const FRAG_COAT = /* glsl */ `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= vFFx.z * (1.0 - fSnowMask);
#endif`;

const FRAG_LIGHT = /* glsl */ `#include <lights_fragment_begin>
#if NUM_DIR_LIGHTS > 0
{
  vec3 fLd = directLight.direction;
  float fNL = dot(geometryNormal, fLd);
  // light through thin leaves and petals: forward scatter toward the sun + what lights the far side
  float fV = max(dot(-geometryViewDir, fLd), 0.0);
  float fScatter = pow(fV, 3.0) * 1.3 + 0.18 * fV;
  float fBack = max(-fNL, 0.0) * 0.6;
  reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * uFTrans * (fScatter + fBack) * vFMat.y * (1.0 - fSnowMask);
  // soft subsurface wrap in mushroom flesh
  float fWrap = max(0.0, (fNL + 0.55) / 1.55) - max(0.0, fNL);
  reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * vec3(1.0, 0.8, 0.55) * fWrap * vFFx.y * uFEnv.y;
}
#endif
#if defined( RE_IndirectDiffuse )
if (vFFuzz.a != 0.0) {
  // fuzz toward the silhouette. Positive: a waxy bloom lit by sky and sun all round (bilberries).
  // Negative: fine hairs, a thin bright rim on the sunlit side only (fiddleheads).
  float fNV = 1.0 - saturate(dot(geometryNormal, geometryViewDir));
  vec3 fFuzz = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
    float fNL = dot(geometryNormal, directLight.direction);
  #else
    float fNL = 0.0;
  #endif
  if (vFFuzz.a > 0.0) {
    fFuzz = irradiance * RECIPROCAL_PI * 0.7;
    #if NUM_DIR_LIGHTS > 0
      fFuzz += directLight.color * 0.3 * (0.25 + 0.75 * saturate(fNL * 0.5 + 0.5));
    #endif
    fFuzz *= pow(fNV, 2.5);
  } else {
    #if NUM_DIR_LIGHTS > 0
      fFuzz = directLight.color * saturate(fNL) * pow(fNV, 4.0);
    #endif
  }
  reflectedLight.indirectDiffuse += fFuzz * vFFuzz.rgb * (abs(vFFuzz.a) * (1.0 - fSnowMask));
}
#endif`;

const FRAG_ENV = /* glsl */ `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && ( NUM_HEMI_LIGHTS > 0 )
{
  // no environment map in this scene: reflect the hemisphere instead, tinted toward the green canopy overhead
  vec3 fR = reflect(-geometryViewDir, geometryNormal);
  float fK = dot(fR, hemisphereLights[0].direction) * 0.5 + 0.5;
  vec3 fEnv = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor * vec3(0.55, 0.72, 0.48), fK * fK) * uFEnv.x;
  radiance += fEnv;
  #ifdef USE_CLEARCOAT
    clearcoatRadiance += fEnv;
  #endif
}
#endif`;

// A dew drop is a tiny lens: the coil beneath it shows through brighter than the surface around it, the sun is
// focused into a crescent on its far side, the rim refracts the dark canopy, and one tiny glint burns hot (HDR).
const FRAG_DROP = /* glsl */ `#include <lights_fragment_end>
if (vFDrop > 0.5) {
  vec3 dN = geometryNormal;
  vec3 dV = geometryViewDir;
  float dNV = clamp(dot(dN, dV), 1e-3, 1.0);
  float dF = 0.02 + 0.98 * pow(1.0 - dNV, 5.0);
  vec3 dSun = vec3(0.0);
  vec3 dL = vec3(0.0, 1.0, 0.0);
  #if NUM_DIR_LIGHTS > 0
    dSun = directLight.color;
    dL = directLight.direction;
  #endif
  vec3 dAmb = vec3(0.04);
  #if defined( RE_IndirectDiffuse )
    dAmb = irradiance * RECIPROCAL_PI;
  #endif
  // the coil seen through the lens, magnified and brighter, darkening to a crisp rim
  vec3 dBody = diffuseColor.rgb * (dAmb * 1.4 + dSun * RECIPROCAL_PI * 1.05);
  dBody *= mix(1.0, 0.1, pow(1.0 - dNV, 2.0));
  // the caustic crescent: sunlight focused onto the inner side away from the sun
  vec3 dLp = dL - dV * dot(dL, dV);
  vec3 dLs = dLp / max(length(dLp), 1e-4);
  vec3 dNc = normalize(dV - dLs * 0.75);
  float dSpot = exp(-2.0 * (1.0 - dot(dN, dNc)) / 0.1);
  vec3 dCaus = diffuseColor.rgb * dSun * RECIPROCAL_PI * 2.2 * dSpot * (1.0 - dF);
  // one tiny, very hot glint of the sun, and a soft reflection of the canopy
  vec3 dH = normalize(dL + dV);
  float dLobe = exp(-2.0 * (1.0 - dot(dN, dH)) / 0.0064);
  vec3 dGlint = dSun * 9.0 * dLobe;
  vec3 dSky = vec3(0.1, 0.13, 0.1);
  #if NUM_HEMI_LIGHTS > 0
    dSky = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor * vec3(0.55, 0.72, 0.48), 0.5 + 0.5 * dot(reflect(-dV, dN), hemisphereLights[0].direction)) * 0.35;
  #endif
  reflectedLight.directDiffuse = dBody + dCaus;
  reflectedLight.indirectDiffuse = vec3(0.0);
  reflectedLight.directSpecular = dGlint + dSky * dF;
  reflectedLight.indirectSpecular = vec3(0.0);
}`;

const seasonRefs = () => ({
  uTime: shared.uTime,
  uWind: shared.uWind,
  uSColF: seasonUniforms.fern.uSColor,
  uSAmtF: seasonUniforms.fern.uSAmount,
  uSColB: seasonUniforms.berry.uSColor,
  uSAmtB: seasonUniforms.berry.uSAmount,
  uSColL: seasonUniforms.lingon.uSColor,
  uSAmtL: seasonUniforms.lingon.uSAmount,
});

// Patch a MeshStandard/MeshPhysical material; returns the replaced chunk count (for tests).
export function patchFloorShader(sh, U) {
  Object.assign(sh.uniforms, U, seasonRefs());
  let hits = 0;
  const rep = (src, a, b) => {
    if (src.includes(a)) hits++;
    return src.replace(a, b);
  };
  let vs = sh.vertexShader;
  vs = rep(vs, '#include <common>', `#include <common>\n${VERT_ANIM}\n${VERT_LOOK}`);
  vs = rep(vs, '#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec3 fPos = position;\n{\n  vec4 fK;\n  float fR;\n  floorAnimate(fPos, objectNormal, fK, fR);\n  floorLook(fK, fR, objectNormal);\n}');
  vs = rep(vs, '#include <begin_vertex>', '#include <begin_vertex>\ntransformed = fPos;');
  let fs = sh.fragmentShader;
  fs = rep(fs, '#include <common>', `#include <common>\n${FRAG_PARS}`);
  fs = rep(fs, '#include <map_fragment>', FRAG_MAP);
  fs = rep(fs, '#include <color_fragment>', FRAG_COLOR);
  fs = rep(fs, '#include <roughnessmap_fragment>', FRAG_ROUGH);
  fs = rep(fs, '#include <lights_physical_fragment>', FRAG_COAT);
  fs = rep(fs, '#include <lights_fragment_begin>', FRAG_LIGHT);
  fs = rep(fs, '#include <lights_fragment_maps>', FRAG_ENV);
  fs = rep(fs, '#include <lights_fragment_end>', FRAG_DROP);
  sh.vertexShader = vs;
  sh.fragmentShader = fs;
  return hits;
}

export function patchFloorDepth(sh, U) {
  Object.assign(sh.uniforms, { uTime: shared.uTime, uWind: shared.uWind, uFWind: U.uFWind, uFSnow: U.uFSnow, uKind: U.uKind });
  let hits = 0;
  let vs = sh.vertexShader;
  if (vs.includes('#include <common>')) hits++;
  vs = vs.replace('#include <common>', `#include <common>\n${VERT_ANIM}`);
  if (vs.includes('#include <begin_vertex>')) hits++;
  vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n{\n  vec3 fN = vec3(0.0, 1.0, 0.0);\n  vec4 fK;\n  float fR;\n  floorAnimate(transformed, fN, fK, fR);\n}');
  sh.vertexShader = vs;
  return hits;
}

function floorUniforms() {
  return {
    uFWind: { value: new THREE.Vector4(FLOOR_PLANTS.windSway, FLOOR_PLANTS.windFlutter, 0, 0) },
    uFSnow: { value: new THREE.Vector4(0, 0, 1, 0) },
    uKind: { value: Array.from({ length: NK }, () => new THREE.Vector4(1, 0, 0, 0)) },
    uKFx: { value: KFX.map((a) => new THREE.Vector4(a[0], a[1], a[2], a[3])) },
    uKCol: { value: KCOL.map((a) => new THREE.Vector4(a[0], a[1], a[2], a[3])) },
    uKBlush: { value: KBLUSH.slice() },
    uKFuzz: { value: KFUZZ.map((a) => new THREE.Vector4(a[0], a[1], a[2], a[3])) },
    uFTrans: { value: new THREE.Vector3(...FLOOR_PLANTS.translucency) },
    uFEnv: { value: new THREE.Vector2(FLOOR_PLANTS.envSpecular, FLOOR_PLANTS.subsurface) },
  };
}

function createMaterials(atlas, quality, U) {
  const a2c = (quality.msaa ?? 0) > 0;
  const hi = quality.tier === 'high' || quality.tier === 'ultra';
  const base = { map: atlas, vertexColors: true, side: THREE.DoubleSide, roughness: 1, metalness: 0 };
  const main = (mat, key) => {
    mat.onBeforeCompile = (sh) => patchFloorShader(sh, U);
    mat.customProgramCacheKey = () => `floor-plants-${key}`;
    return mat;
  };
  const leaf = main(new THREE.MeshStandardMaterial({ ...base, alphaTest: 0.42, alphaToCoverage: a2c }), 'leaf');
  leaf.defines = { ...leaf.defines, FLOOR_ALPHA: '' };
  const solid = main(new THREE.MeshStandardMaterial(base), 'solid');
  // glossy, leathery lingon leaves and berries: a real clearcoat lobe on high/ultra
  const gloss = hi
    ? main(new THREE.MeshPhysicalMaterial({ ...base, clearcoat: 1, clearcoatRoughness: 0.12 }), 'gloss-cc')
    : main(new THREE.MeshStandardMaterial(base), 'gloss');
  const depth = (map, key) => {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map ?? null, alphaTest: map ? 0.42 : 0, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => patchFloorDepth(sh, U);
    m.customProgramCacheKey = () => `floor-plants-depth-${key}`;
    return m;
  };
  return { leaf, solid, gloss, leafDepth: depth(atlas, atlas ? 'alpha' : 'plain'), solidDepth: depth(null, 'plain') };
}

// ── CPU twin of floorAnimate, for the dew sites (same numbers as the shader) ──
function windOffset(p, w, t, out) {
  const A = FLOOR_PLANTS.windSway;
  const Af = FLOOR_PLANTS.windFlutter;
  const gust = 0.55 + 0.45 * Math.sin(t * 0.37 + w[1] * 0.5);
  const s = Math.sin(t * 1.13 + w[1]) * 0.62 + Math.sin(t * 2.31 + w[1] * 1.7) * 0.38;
  const c = Math.sin(t * 0.83 + w[1] * 2.1);
  const k = w[0] * A * gust;
  const fl = Math.sin(t * 5.7 + (p.x * 9.1 + p.y * 7.3 + p.z * 8.3) + w[1] * 3) * 0.7 + Math.sin(t * 9.3 + (-6.7 * p.x + 11 * p.y + 5.3 * p.z)) * 0.3;
  const f = fl * w[2] * Af * (0.5 + 0.5 * gust);
  return out.set((0.82 * s + 0.2 * c) * k + 0.35 * f, f, (0.57 * s - 0.25 * c) * k + 0.3 * f).multiplyScalar(shared.uWind.value);
}

// ═══════════════════════════════════════════════════════════════
// The module
// ═══════════════════════════════════════════════════════════════
const winM = (m, a, b, ramp = 0.35) => {
  const f = (x) => smoothstep(a - ramp, a + ramp, x) * (1 - smoothstep(b - ramp, b + ramp, x));
  return Math.max(f(m), f(m + 12), f(m - 12));
};

/**
 * Hero plants and fungi of the flyover patch.
 * buildFloorPlants(ctx) → {
 *   group,                      // add to the scene (positioned at the patch centre)
 *   update(dt, time, state),    // state.near switches fern pinnules ↔ painted pinna cards; moves dewSites[i].cur
 *   applySeason(sp, v),         // cheap to call every frame (recomputes only when the season moved)
 *   stats,                      // { drawCalls, shadowCalls, triangles, trianglesFar, vertices, instances }
 *   perches,                    // [{ p, n }] lingon leaf tops, nearest SPOTS.ladybird first
 *   dewSites,                   // [{ p, n, c, plant, maxSway, wind, cur, vis, … }] leaf and pinna tips that sway < 1.5 mm
 *   silkAnchor,                 // THREE.Vector3: tip of the still buckler frond at patch (0.70, 0.42), 0.30 m up
 *   silk,                       // { anchor, presence }: presence 0 … 1 (the frond is up from June until the snow)
 *   meshes, uniforms,
 * }
 */
export function buildFloorPlants(ctx = {}) {
  const quality = ctx.quality ?? { tier: 'medium', plants: 0.7, msaa: 4, shadows: true };
  const tier = QT[quality.tier] ? quality.tier : 'medium';
  const built = buildFloorPlantGeometry({ tier });
  const U = floorUniforms();
  const hasDOM = typeof document !== 'undefined';
  const atlas = hasDOM ? paintFloorAtlas({ res: (quality.foliageRes ?? 1) >= 1.5 ? 2 : 1, anisotropy: quality.anisotropy ?? 8 }) : null;
  const mats = createMaterials(atlas, quality, U);
  const shadows = quality.shadows !== false;

  const group = new THREE.Group();
  group.name = 'floor-plants';
  group.position.copy(built.origin);
  const meshes = {};
  const add = (name, soup, mat, depth, cast) => {
    const geo = soup.build();
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.name = `floor-plants-${name}`;
    m.castShadow = shadows && cast;
    m.receiveShadow = shadows;
    m.customDepthMaterial = depth;
    group.add(m);
    meshes[name] = m;
    return m;
  };
  add('leavesTall', built.LS, mats.leaf, mats.leafDepth, true);
  add('leavesLow', built.LL, mats.leaf, mats.leafDepth, false);
  add('solid', built.SS, mats.solid, mats.solidDepth, true);
  add('gloss', built.GS, mats.gloss, mats.solidDepth, false);

  // near: real pinnules; far: painted pinna cards (one index buffer, two draw ranges)
  const lt = meshes.leavesTall?.geometry;
  const R = lt?.userData.ranges ?? { fine: 0, shared: 0, coarse: 0 };
  let fine = true;
  const setLod = () => {
    if (!lt) return;
    if (fine) lt.setDrawRange(0, R.fine + R.shared);
    else lt.setDrawRange(R.fine, R.shared + R.coarse);
  };
  setLod();

  const tri = (m, near = true) => {
    if (!m) return 0;
    const r = m.geometry.userData.ranges;
    return (near ? r.fine + r.shared : r.shared + r.coarse) / 3;
  };
  const all = Object.values(meshes);
  const stats = {
    drawCalls: all.length,
    shadowCalls: all.filter((m) => m.castShadow).length,
    triangles: all.reduce((s, m) => s + tri(m, true), 0),
    trianglesFar: all.reduce((s, m) => s + tri(m, false), 0),
    vertices: all.reduce((s, m) => s + m.geometry.attributes.position.count, 0),
    instances: 0,
  };

  // ── seasons ──
  const K = U.uKind.value;
  const set = (k, grow, flat = 0, shift = 0, loss = 0) => K[k].set(clamp(grow), clamp(flat), clamp(shift), clamp(loss));
  const silk = { anchor: built.silkAnchor, presence: 1 };
  const last = [NaN, NaN, NaN, NaN, NaN];
  function applySeason(sp = {}, v = 1.5) {
    const snow = clamp(sp.snow ?? 0);
    const dew = clamp(sp.dew ?? 1);
    const lf = sp.fern?.loss ?? 0;
    const lb = sp.berry?.loss ?? 0;
    // called every frame: only recompute when the season actually moved
    if (Math.abs(v - last[0]) < 1e-5 && snow === last[1] && dew === last[2] && lf === last[3] && lb === last[4]) return;
    last[0] = v;
    last[1] = snow;
    last[2] = dew;
    last[3] = lf;
    last[4] = lb;
    const ph = phenology(v);
    const m = ph.month;
    const rising = m > 3 && m < 8.6; // the first half of the growing year
    const fr = ph.fernFronds;
    set(KIND.STATIC, 1);
    // this year's fronds rise from the crown in early summer; in autumn they brown and collapse
    if (rising) set(KIND.FROND, fr);
    else set(KIND.FROND, 1, (1 - fr) * 0.9 + snow * 0.1, 1 - fr, lf);
    // the fronds over the glide line only sag a little as they brown, then drop out one by one
    if (rising) set(KIND.FROND_IN, fr);
    else set(KIND.FROND_IN, 1, (1 - fr) * 0.2, 1 - fr, Math.max(lf, smoothstep(0.8, 0.25, fr)));
    // the silk frond stands until the snow presses it down
    if (rising) set(KIND.FROND_STILL, fr);
    else set(KIND.FROND_STILL, 1, snow * 0.9, (1 - fr) * 0.8, snow > 0.6 ? 1 : 0);
    // last year's fronds lie flat from November until they rot away in July
    set(KIND.DEAD, 1, 0, 0, 1 - winM(m, 10.6, 19.0, 0.4));
    // Seasonal parts grow in while their window opens (each at its own moment), and as it closes they drop
    // out one by one (petals fall, berries are eaten, mushrooms rot) instead of shrinking.
    const opening = (mid) => m < mid || m > mid + 6;
    const life = (k, w, mid) => {
      if (opening(mid)) set(k, w);
      else set(k, w > 1e-3 ? 1 : 0, 0, 0, 1 - w);
    };
    const cz = smoothstep(0, 0.3, ph.croziers);
    life(KIND.CROZ_TIGHT, cz, 6.85);
    life(KIND.CROZ_HALF, cz, 6.85);
    life(KIND.CROZ_LATE, cz, 6.85);
    {
      const kt = K[KIND.CROZ_TIGHT];
      set(KIND.DEW, kt.x, 0, 0, Math.max(kt.w, 1 - smoothstep(0.2, 0.6, dew)));
    }
    // bilberry: leaves out in May, red in autumn (season group), dropped for winter; green twigs stay
    set(KIND.BIL_STEM, 1);
    set(KIND.BIL_LEAF, rising ? smoothstep(4.4, 5.4, m) : 1, 0, 0, lb);
    life(KIND.BIL_FLOWER, ph.bilberryFlowers, 5.65);
    // berries swell green, then ripen blue-black (colour shift = how unripe)
    const bu = winM(m, 6.1, 7.6, 0.3);
    const br = ph.bilberries;
    const bt = Math.max(bu, br);
    const unripe = bt > 1e-3 ? 1 - br / bt : 0;
    if (opening(8.3)) set(KIND.BIL_BERRY, bt, 0, unripe);
    else set(KIND.BIL_BERRY, bt > 1e-3 ? 1 : 0, 0, unripe, 1 - bt);
    // lingon: evergreen, bronzed by the winter sun; berries ripen white → red and a few hang on under snow
    set(KIND.LIN_STEM, 1);
    set(KIND.LIN_LEAF, 1, 0, snow * 0.6);
    life(KIND.LIN_FLOWER, ph.lingonFlowers, 6.5);
    const lu = ph.lingonUnripe;
    const lr = ph.lingonberries;
    const hold = winM(m, 11.0, 15.2, 0.4);
    const lt2 = Math.max(lu, lr, hold);
    const linUnripe = lt2 > 1e-3 ? lu / Math.max(1e-3, lu + lr + hold) : 0;
    if (m > 5 && m < 9.8) set(KIND.LIN_BERRY, lt2, 0, linUnripe);
    else set(KIND.LIN_BERRY, lt2 > 1e-3 ? 1 : 0, 0, linUnripe, Math.max(1 - lt2, hold * 0.75));
    // twinflower: evergreen mat, bells in July
    set(KIND.TWIN_RUNNER, 1);
    set(KIND.TWIN_LEAF, 1, snow * 0.5);
    life(KIND.TWIN_FLOWER, ph.twinflowers, 7.15);
    // wood sorrel: leaves lie down under the snow, flowers in May–June
    set(KIND.SOR_LEAF, 1, snow * 0.85);
    life(KIND.SOR_FLOWER, ph.woodSorrelFlowers, 5.65);
    // fungi: chanterelles come and go one by one; the fly agarics sag and collapse at the end of their season
    life(KIND.CHANT, ph.chanterelles, 8.9);
    const fa = ph.flyAgaric;
    // fly agarics stand from July; at the end of October they sag and collapse
    if (opening(9.6)) {
      set(KIND.AGARIC, smoothstep(0.05, 0.75, fa));
      set(KIND.BUTTON, smoothstep(0, 0.45, fa));
    } else {
      for (const k of [KIND.AGARIC, KIND.BUTTON]) set(k, fa > 1e-3 ? 1 : 0, smoothstep(0.5, 0.05, fa) * 0.75, 0, smoothstep(0.12, 0, fa));
    }
    U.uFSnow.value.set(FLOOR_PLANTS.snowDepth * smoothstep(0.08, 1, snow), snow, dew, 0);
    const ks = K[KIND.FROND_STILL];
    silk.presence = (ks.x >= 0.999 ? 1 : ks.x) * (1 - ks.y) * (1 - ks.w);
    for (const s of built.dewSites) s.vis = siteVis(s);
  }
  const siteVis = (s) => {
    const k = K[s.k];
    const r2 = fract(s.rnd * 7.31 + 0.137);
    let g = clamp((k.x - s.rnd * 0.4) / 0.6);
    g = g * g * (3 - 2 * g) * (r2 >= k.w ? 1 : 0);
    return g * (1 - clamp(k.y * (0.8 + 0.4 * r2)));
  };
  applySeason({ snow: 0, dew: 1 }, 1.5);

  // ── per frame: LOD and the live positions of the dew sites ──
  const O = built.origin;
  const lp = v3();
  const wo = v3();
  function update(dt, time, state = {}) {
    const near = state.near ?? 1;
    const want = fine ? near > FLOOR_PLANTS.lodNear[0] : near > FLOOR_PLANTS.lodNear[1];
    if (want !== fine) {
      fine = want;
      setLod();
    }
    if (near <= 0.01) return;
    const t = shared.uTime.value;
    const sink = U.uFSnow.value.x;
    for (const s of built.dewSites) {
      if (s.vis <= 0) continue;
      lp.copy(s.p).sub(O);
      windOffset(lp, s.wind, t, wo);
      s.cur.copy(s.p).add(wo);
      s.cur.y -= sink;
    }
  }

  return {
    group,
    update,
    applySeason,
    stats,
    perches: built.perches,
    dewSites: built.dewSites,
    silkAnchor: built.silkAnchor,
    silk,
    meshes,
    uniforms: U,
  };
}

// Patch-frame helper for tests and integration.
export function floorPlantSpotOf(p) {
  const { u, v } = toPatch(p.x, p.z);
  let best = null;
  for (const n of SPOT_NAMES) {
    const s = SPOTS[n];
    if (!s) continue;
    const d = Math.hypot(u - s.u, v - s.v);
    if (d <= s.r && (!best || d < best.d)) best = { name: n, d };
  }
  return best?.name ?? null;
}

export const FLOOR_PLANT_INTERNALS = { KIND, NK, ATLAS, QT, SPOT_NAMES, Soup, pinnuleW, bilW, twinW, linProfile };
