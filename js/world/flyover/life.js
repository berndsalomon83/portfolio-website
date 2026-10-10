import * as THREE from 'three';
import { RNG, noise2, smoothstep, clamp } from '../../lib/random.js';
import { PATCH, SPOTS, ANT_TRAIL, fromPatch, inPatch, heroHeightAt, phenology } from './config.js';
import { SUN_DIR } from '../layout.js';
import { shared } from '../../gl/patches.js';
import { shadowUniforms } from '../details.js';
import { buildTracks } from './tracks.js';

// Microscopic life on the forest floor, seen from 0.85 m at about half a millimetre per pixel:
//   • red wood ants (Formica rufa) streaming along ANT_TRAIL in both directions, some hauling a needle or a seed,
//     and swarming over the edge of their mound
//   • a dor beetle (Anoplotrupes stercorosus) ploughing slowly around its spot, blue-violet where the light grazes it
//   • a seven-spot ladybird (Coccinella septempunctata) on a lingon leaf
//   • a wolf spider (Pardosa) that now and then darts across the moss and freezes
// Everything is procedural and at true size. Legs and antennae are posed in the vertex shader from one gait phase
// per creature; the CPU only moves bodies along the ground. Each creature also throws a crisp sun shadow, flattened
// onto the ground under it (see shadowMaterial), because the sun's shadow map is centimetres per texel.
//
// Draw calls: ants, ant shadows, solo creatures (beetle + ladybird + spider in one mesh), their shadows, the mound.

// ── tuning knobs ────────────────────────────────────────────
export const LIFE = {
  ants: { ultra: 182, high: 140, medium: 90, low: 40 }, // workers in total (trail + mound)
  trailShare: 0.72, // the rest swarm over the mound
  shadowCap: { ultra: 64, high: 56, medium: 40, low: 16 }, // ants that get a flattened sun shadow (nearest first)
  needles: { ultra: 2000, high: 1500, medium: 1000, low: 450 }, // loose 3D needles on the mound
  twigs: { ultra: 70, high: 60, medium: 45, low: 20 },
  antSpeed: [0.032, 0.058], // m/s, before the temperature factor
  antSize: [0.76, 1.24], // × the 7 mm model → 5.3 … 8.7 mm workers
  carry: { needle: 0.24, seed: 0.1 }, // share of homebound ants hauling something
  beetleSpeed: 0.011, // m/s
  spiderSpeed: [0.16, 0.22], // m/s during a dart
  minPx: { ultra: 1.0, high: 1.0, medium: 1.0, low: 1.25 }, // thinnest limb on screen (px)
  shadowK: 1, // strength multiplier of the flattened sun shadows
  shadowFade: 1.4, // shadows fade out toward this camera distance (m); the glide frame's corners are 1.06 m away
  hideBeyond: 4.5, // creatures farther than this from the camera are not drawn (m)
  env: 1, // strength of the sky reflection on glossy chitin
  mound: { u: -2.02, v: -1.08, R: 0.52, H: 0.24 }, // dome centre (patch frame), base radius, height (m)
  spider: { u: 0.35, v: -0.42, r: 0.1 }, // the wolf spider's hunting ground (open moss, clear of every spot)
};

// ── patch frame without allocations ─────────────────────────
const PU = PATCH.u;
const PV = PATCH.v;
const PC = PATCH.center;
const wX = (u, v) => PC.x + PU.x * u + PV.x * v;
const wZ = (u, v) => PC.y + PU.y * u + PV.y * v;
const TAU = Math.PI * 2;
const wrapAngle = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

// ── the mound ───────────────────────────────────────────────
const MC = fromPatch(LIFE.mound.u, LIFE.mound.v);

/** Height of the ant mound above the forest floor at world (x, z); 0 outside it. */
export function moundAt(x, z) {
  const { R, H } = LIFE.mound;
  const dx = x - MC.x;
  const dz = z - MC.z;
  const q = Math.sqrt(dx * dx + dz * dz) / R;
  if (q >= 1) return 0;
  const base = H * Math.pow(1 - q * q, 1.25);
  const lumps = (0.009 * noise2(x * 9.0 + 3.3, z * 9.0 - 1.1) + 0.002 * noise2(x * 22.0 - 7.7, z * 22.0 + 5.1)) * smoothstep(1.0, 0.55, q);
  return base + lumps;
}

/** The surface the creatures walk on: the hero floor plus the mound. */
export function lifeSurfaceAt(x, z) {
  return heroHeightAt(x, z) + moundAt(x, z);
}

// ── height grids (creatures never call the noise functions per frame) ──
// A rectangle in the patch frame sampled every `h` metres; bilinear lookups stay well under 0.3 mm of the truth.
class PatchGrid {
  constructor(u0, v0, du, dv, h, fn) {
    this.u0 = u0;
    this.v0 = v0;
    this.h = h;
    this.nu = Math.ceil(du / h) + 1;
    this.nv = Math.ceil(dv / h) + 1;
    this.d = new Float64Array(this.nu * this.nv);
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const u = u0 + i * h;
        const v = v0 + j * h;
        this.d[j * this.nu + i] = fn(wX(u, v), wZ(u, v));
      }
    }
  }

  height(u, v) {
    let fu = clamp((u - this.u0) / this.h, 0, this.nu - 1.0001);
    let fv = clamp((v - this.v0) / this.h, 0, this.nv - 1.0001);
    const i = Math.floor(fu);
    const j = Math.floor(fv);
    fu -= i;
    fv -= j;
    const k = j * this.nu + i;
    const D = this.d;
    return (D[k] * (1 - fu) + D[k + 1] * fu) * (1 - fv) + (D[k + this.nu] * (1 - fu) + D[k + this.nu + 1] * fu) * fv;
  }

  // world-space surface normal, from central differences `e` metres apart
  normal(u, v, out, e = this.h) {
    const du = (this.height(u + e, v) - this.height(u - e, v)) / (2 * e);
    const dv = (this.height(u, v + e) - this.height(u, v - e)) / (2 * e);
    return out.set(-(du * PU.x + dv * PV.x), 1, -(du * PU.y + dv * PV.y)).normalize();
  }
}

// The trail as a strip: a smooth, gently meandering centre line through ANT_TRAIL (arc length s) and a few
// lateral columns (w, + toward +v), with the walking surface sampled on that grid.
export function buildTrail() {
  const curve = new THREE.SplineCurve(ANT_TRAIL.map(([u, v]) => new THREE.Vector2(u, v)));
  curve.arcLengthDivisions = 4000;
  const L0 = curve.getLength();
  const ds = 0.005;
  const n = Math.ceil(L0 / ds) + 1;
  const cu = new Float64Array(n);
  const cv = new Float64Array(n);
  const tu = new Float64Array(n);
  const tv = new Float64Array(n);
  const p = new THREE.Vector2();
  const t = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const f = Math.min(1, s / L0);
    curve.getPointAt(f, p);
    curve.getTangentAt(f, t);
    // real trails snake a little around crumbs and moss tufts
    const m = (0.006 * Math.sin(s * 7.3 + 0.4) + 0.0035 * Math.sin(s * 17.9 + 2.1)) * smoothstep(0, 0.25, s);
    cu[i] = p.x - t.y * m;
    cv[i] = p.y + t.x * m;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const du = cu[b] - cu[a];
    const dv = cv[b] - cv[a];
    const l = Math.hypot(du, dv) || 1;
    tu[i] = du / l;
    tv[i] = dv / l;
  }
  const nw = 9;
  const W = 0.024;
  const dw = (2 * W) / (nw - 1);
  const H = new Float64Array(n * nw);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < nw; j++) {
      const w = -W + j * dw;
      const u = cu[i] - tv[i] * w;
      const v = cv[i] + tu[i] * w;
      H[i * nw + j] = lifeSurfaceAt(wX(u, v), wZ(u, v));
    }
  }
  return { n, ds, L: (n - 1) * ds, cu, cv, tu, tv, H, nw, W, dw };
}

// Patch-frame position of (s, w) → TUV.
const TUV = { u: 0, v: 0 };
function trailUV(T, s, w) {
  let f = clamp(s / T.ds, 0, T.n - 1.0001);
  const i = Math.floor(f);
  f -= i;
  const tu = T.tu[i] + (T.tu[i + 1] - T.tu[i]) * f;
  const tv = T.tv[i] + (T.tv[i + 1] - T.tv[i]) * f;
  TUV.u = T.cu[i] + (T.cu[i + 1] - T.cu[i]) * f - tv * w;
  TUV.v = T.cv[i] + (T.cv[i + 1] - T.cv[i]) * f + tu * w;
}

function trailHeight(T, s, w) {
  let fs = clamp(s / T.ds, 0, T.n - 1.0001);
  let fw = clamp((w + T.W) / T.dw, 0, T.nw - 1.0001);
  const i = Math.floor(fs);
  const j = Math.floor(fw);
  fs -= i;
  fw -= j;
  const k = i * T.nw + j;
  const H = T.H;
  return (H[k] * (1 - fw) + H[k + 1] * fw) * (1 - fs) + (H[k + T.nw] * (1 - fw) + H[k + T.nw + 1] * fw) * fs;
}

// Frame of the trail at (s, w): world position, surface normal, tangent and lateral (world, horizontal) → `F`.
const F = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, tx: 0, tz: 0, lx: 0, lz: 0 };
const _n = new THREE.Vector3();
function trailFrame(T, s, w) {
  let f = clamp(s / T.ds, 0, T.n - 1.0001);
  const i = Math.floor(f);
  f -= i;
  const cu = T.cu[i] + (T.cu[i + 1] - T.cu[i]) * f;
  const cv = T.cv[i] + (T.cv[i + 1] - T.cv[i]) * f;
  let tu = T.tu[i] + (T.tu[i + 1] - T.tu[i]) * f;
  let tv = T.tv[i] + (T.tv[i + 1] - T.tv[i]) * f;
  const l = Math.hypot(tu, tv) || 1;
  tu /= l;
  tv /= l;
  const u = cu - tv * w;
  const v = cv + tu * w;
  F.x = wX(u, v);
  F.z = wZ(u, v);
  F.y = trailHeight(T, s, w);
  F.tx = PU.x * tu + PV.x * tv;
  F.tz = PU.y * tu + PV.y * tv;
  F.lx = -PU.x * tv + PV.x * tu;
  F.lz = -PU.y * tv + PV.y * tu;
  // normal = lateral × tangent, both lifted onto the surface
  const hs = (trailHeight(T, s + T.ds, w) - trailHeight(T, s - T.ds, w)) / (2 * T.ds);
  const hw = (trailHeight(T, s, w + T.dw * 0.5) - trailHeight(T, s, w - T.dw * 0.5)) / T.dw;
  _n.set(hw * F.tz - F.lz * hs, F.lz * F.tx - F.lx * F.tz, F.lx * hs - hw * F.tx).normalize();
  F.nx = _n.x;
  F.ny = _n.y;
  F.nz = _n.z;
}

// Column-major instance matrix: local +x = forward, +y = up (surface normal), +z = right.
function writeMatrix(a, o, px, py, pz, fx, fy, fz, nx, ny, nz, s) {
  const d = fx * nx + fy * ny + fz * nz;
  fx -= nx * d;
  fy -= ny * d;
  fz -= nz * d;
  const l = Math.hypot(fx, fy, fz) || 1;
  fx /= l;
  fy /= l;
  fz /= l;
  const rx = fy * nz - fz * ny;
  const ry = fz * nx - fx * nz;
  const rz = fx * ny - fy * nx;
  a[o] = fx * s;
  a[o + 1] = fy * s;
  a[o + 2] = fz * s;
  a[o + 3] = 0;
  a[o + 4] = nx * s;
  a[o + 5] = ny * s;
  a[o + 6] = nz * s;
  a[o + 7] = 0;
  a[o + 8] = rx * s;
  a[o + 9] = ry * s;
  a[o + 10] = rz * s;
  a[o + 11] = 0;
  a[o + 12] = px;
  a[o + 13] = py;
  a[o + 14] = pz;
  a[o + 15] = 1;
}

// ── rigged geometry ─────────────────────────────────────────
// Built in millimetres (x forward, y up, z right, origin on the ground under the body), stored in metres.
// Per vertex: aRig = (part, phase offset, signed swing, t along the limb), aPivot = (hip or socket, lift m | rad/s),
// aAxis = (nearest point on the limb axis, creature id), aMat = (roughness, metalness, clearcoat, pattern).
// Parts: 0 body, 1 leg, 2 antenna/palp, 3 carried needle, 4 carried seed.
const ZERO3 = [0, 0, 0];

class RigMesh {
  constructor() {
    this.pos = [];
    this.col = [];
    this.rig = [];
    this.piv = [];
    this.axis = [];
    this.mat = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(x, y, z, c, tag, t, ax, ay, az) {
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    this.rig.push(tag.part ?? 0, tag.phase ?? 0, tag.swing ?? 0, t);
    const pv = tag.pivot ?? ZERO3;
    this.piv.push(pv[0], pv[1], pv[2], tag.lift ?? 0);
    this.axis.push(ax, ay, az, tag.creature ?? 0);
    const m = tag.mat ?? [0.5, 0, 0, 0];
    this.mat.push(m[0], m[1], m[2], m[3]);
    return this.count - 1;
  }

  build() {
    const S = 0.001;
    const sc3 = (arr, stride) => arr.map((v, i) => (i % stride < 3 ? v * S : v));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos.map((v) => v * S), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, 4));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(sc3(this.piv, 4), 4));
    g.setAttribute('aAxis', new THREE.Float32BufferAttribute(sc3(this.axis, 4), 4));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const bump = (t, c, s) => Math.exp(-(((t - c) / s) ** 2));
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// A closed body segment along local x: superellipse rings between two poles.
// prof(t) → [centre y, half-height above, half-height below, half-width]; color(t, cos, sin) → linear RGB.
function loft(m, { x0, x1, rings, sides, prof, color, tag, exp = 2 }) {
  const ex = 2 / exp;
  const p0 = prof(0);
  const p1 = prof(1);
  const first = m.vert(x0, p0[0], 0, color(0, 0, 0), tag, 0, x0, p0[0], 0);
  const start = m.count;
  for (let i = 1; i <= rings; i++) {
    const t = i / (rings + 1);
    const x = x0 + (x1 - x0) * t;
    const [y, top, bot, w] = prof(t);
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      m.vert(x, y + (sa >= 0 ? top : bot) * spow(sa, ex), w * spow(ca, ex), color(t, ca, sa), tag, t, x, y, 0);
    }
  }
  const last = m.vert(x1, p1[0], 0, color(1, 0, 0), tag, 1, x1, p1[0], 0);
  for (let j = 0; j < sides; j++) m.idx.push(first, start + j, start + ((j + 1) % sides));
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = start + i * sides + j;
      const b = start + i * sides + ((j + 1) % sides);
      m.idx.push(a, a + sides, b, b, a + sides, b + sides);
    }
  }
  const lr = start + (rings - 1) * sides;
  for (let j = 0; j < sides; j++) m.idx.push(last, lr + ((j + 1) % sides), lr + j);
}

// A limb: a thin tube through `pts` (mm) with per-point radius, colour and t (0 at the hip … 1 at the tip).
const _T = new THREE.Vector3();
const _N = new THREE.Vector3();
const _B = new THREE.Vector3();
const _P = new THREE.Vector3();
const _Q = new THREE.Vector3();
function limb(m, pts, radii, ts, colors, tag, sides = 3) {
  const n = pts.length;
  const base = m.count;
  for (let i = 0; i < n; i++) {
    _P.fromArray(pts[Math.max(0, i - 1)]);
    _Q.fromArray(pts[Math.min(n - 1, i + 1)]);
    _T.subVectors(_Q, _P).normalize();
    if (i === 0) {
      _N.set(0, 1, 0);
      if (Math.abs(_T.y) > 0.9) _N.set(1, 0, 0);
      _N.cross(_T).normalize();
    } else {
      _N.addScaledVector(_T, -_N.dot(_T)).normalize();
    }
    _B.crossVectors(_T, _N);
    const [px, py, pz] = pts[i];
    const c = colors[Math.min(i, colors.length - 1)];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU + 0.35;
      const ca = Math.cos(a) * radii[i];
      const sa = Math.sin(a) * radii[i];
      m.vert(px + _N.x * ca + _B.x * sa, py + _N.y * ca + _B.y * sa, pz + _N.z * ca + _B.z * sa, c, tag, ts[i], px, py, pz);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * sides + j;
      const b = base + i * sides + ((j + 1) % sides);
      m.idx.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
}

const mirror = (p, side) => [p[0], p[1], p[2] * side];
// tripod (6 legs) / alternating tetrapod (8 legs): pair k on the left steps with pair k+1 on the right
const gaitPhase = (pair, side) => ((pair + (side > 0 ? 1 : 0)) % 2) * Math.PI + pair * 0.15;

// colours are linear RGB
const ANT = {
  thorax: [0.2, 0.045, 0.013],
  thoraxDark: [0.05, 0.016, 0.008],
  head: [0.14, 0.033, 0.011],
  headDark: [0.03, 0.011, 0.006],
  petiole: [0.16, 0.038, 0.012],
  gaster: [0.014, 0.009, 0.006],
  gasterRed: [0.1, 0.024, 0.009],
  legs: [[0.11, 0.028, 0.01], [0.075, 0.022, 0.009], [0.045, 0.016, 0.008], [0.03, 0.012, 0.007]],
  antenna: [[0.06, 0.02, 0.009], [0.045, 0.016, 0.008], [0.035, 0.014, 0.008], [0.03, 0.013, 0.008]],
  mandible: [0.07, 0.02, 0.008],
  needle: [0.16, 0.075, 0.026],
  seed: [0.42, 0.3, 0.14],
  elaiosome: [0.62, 0.55, 0.4],
};

// femur root (inside the body), knee (high), end of tibia, tarsus tip on the ground; swing amplitude (rad)
const ANT_LEGS = [
  [[0.95, 1.0, 0.3], [1.75, 1.7, 1.15], [2.45, 0.35, 1.75], [3.15, 0, 2.05], 0.33],
  [[0.15, 0.95, 0.33], [0.35, 1.8, 1.7], [0.55, 0.3, 2.85], [0.25, 0, 3.75], 0.38],
  [[-0.5, 0.95, 0.3], [-1.05, 1.85, 1.75], [-2.3, 0.3, 2.8], [-3.35, 0, 3.25], 0.33],
];
const ANT_STRIDE = 0.0048; // body travel per gait cycle at scale 1 (m) — keeps the feet from sliding

/** A 7 mm Formica rufa worker. `lo` = the low-poly proxy that casts the flattened shadow. */
export function antGeometry(lo = false) {
  const m = new RigMesh();
  const mat = (r, c = 0) => ({ part: 0, mat: [r, 0, c, 0] });
  // mesosoma + neck: low propodeum, humped pronotum, the dark dorsal patch of F. rufa
  loft(m, {
    x0: -1.15, x1: 1.4, rings: lo ? 2 : 4, sides: lo ? 4 : 6, exp: 2.2, tag: mat(0.4, 0.1),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * t), 0.55);
      return [1.25 + 0.22 * smoothstep(0.25, 0.8, t), e * (0.36 + 0.13 * bump(t, 0.72, 0.17) + 0.06 * bump(t, 0.3, 0.12)), e * 0.3, e * (0.3 + 0.13 * bump(t, 0.7, 0.2))];
    },
    color: (t, ca, sa) => lerp3(ANT.thorax, ANT.thoraxDark, smoothstep(0.35, 0.85, sa) * smoothstep(0.4, 0.65, t)),
  });
  if (!lo) {
    // petiole: the upright scale between thorax and gaster
    loft(m, {
      x0: -1.42, x1: -1.1, rings: 1, sides: 4, tag: mat(0.35),
      prof: () => [1.38, 0.48, 0.2, 0.28],
      color: () => ANT.petiole,
    });
  }
  // gaster: glossy, almost black, a reddish band at its base
  loft(m, {
    x0: -4.25, x1: -1.3, rings: lo ? 2 : 4, sides: lo ? 5 : 7, tag: mat(0.27, 0.6),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.55);
      return [1.05 + 0.4 * t, e * 0.9, e * 0.8, e * 0.98];
    },
    color: (t) => lerp3(ANT.gaster, ANT.gasterRed, smoothstep(0.78, 1.0, t)),
  });
  // head: broad, flattened, dark on top
  loft(m, {
    x0: 1.3, x1: 2.8, rings: lo ? 1 : 3, sides: lo ? 4 : 6, exp: 2.6, tag: mat(0.36, 0.15),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * (0.15 + 0.85 * t)), 0.45);
      return [1.5 - 0.15 * t, e * 0.48, e * 0.4, e * 0.68];
    },
    color: (t, ca, sa) => lerp3(ANT.head, ANT.headDark, smoothstep(0.2, 0.7, sa)),
  });
  if (!lo) {
    for (const side of [-1, 1]) {
      limb(m, [[2.65, 1.25, 0.35 * side], [3.2, 1.1, 0.06 * side]], [0.14, 0.06], [0, 1], [ANT.mandible], mat(0.3));
    }
  }
  // six legs, tripod gait
  ANT_LEGS.forEach(([hip, knee, ankle, tip, amp], pair) => {
    for (const side of [-1, 1]) {
      const h = mirror(hip, side);
      const tag = { part: 1, phase: gaitPhase(pair, side), swing: side * amp, pivot: h, lift: 0.0006, mat: [0.42, 0, 0, 0] };
      limb(m, [h, mirror(knee, side), mirror(ankle, side), mirror(tip, side)], [0.24, 0.19, 0.14, 0.08], [0, 0.45, 0.8, 1], ANT.legs, tag);
    }
  });
  // elbowed antennae: long scape up and out, funiculus forward and down to the ground
  for (const side of [-1, 1]) {
    const sock = [2.45, 1.75, 0.28 * side];
    const tag = { part: 2, phase: side * 1.3, swing: side * 0.3, pivot: sock, lift: 14, mat: [0.45, 0, 0, 0] };
    const pts = lo
      ? [sock, [3.0, 2.45, 1.0 * side], [4.6, 1.1, 1.6 * side]]
      : [sock, [3.0, 2.45, 1.0 * side], [3.75, 2.1, 1.38 * side], [4.6, 1.1, 1.6 * side]];
    const radii = lo ? [0.08, 0.075, 0.08] : [0.08, 0.075, 0.075, 0.09];
    const ts = lo ? [0, 0.4, 1] : [0, 0.4, 0.7, 1];
    limb(m, pts, radii, ts, ANT.antenna, tag);
  }
  // cargo, shown per ant: a spruce needle fragment held crosswise, or a cow-wheat seed with its pale elaiosome
  const grip = [3.2, 1.15, 0];
  limb(m, [[3.2, 1.05, -2.6], [3.45, 1.35, 2.7]], [0.36, 0.3], [0, 1], [ANT.needle], { part: 3, pivot: grip, mat: [0.6, 0, 0, 0] });
  loft(m, {
    x0: 3.05, x1: 5.5, rings: lo ? 1 : 2, sides: 4, tag: { part: 4, pivot: grip, mat: [0.45, 0, 0.2, 0] },
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * t), 0.6);
      return [1.15, e * 0.55, e * 0.55, e * 0.6];
    },
    color: (t) => lerp3(ANT.seed, ANT.elaiosome, smoothstep(0.55, 0.8, t)),
  });
  return m.build();
}

// ── the solo creatures ──────────────────────────────────────
const BEETLE_LEGS = [
  [[4.2, 2.0, 2.0], [5.6, 3.2, 5.0], [7.9, 0.9, 6.6], [9.0, 0, 7.3], [0.9, 0.85, 0.95, 0.3], 0.25],
  [[0.9, 1.9, 2.6], [0.6, 3.4, 6.4], [-0.9, 0.8, 8.6], [-1.7, 0, 9.8], [0.85, 0.75, 0.6, 0.22], 0.3],
  [[-1.2, 1.9, 2.6], [-3.0, 3.4, 6.2], [-6.6, 0.8, 8.3], [-8.2, 0, 9.0], [0.85, 0.75, 0.6, 0.22], 0.28],
];
const BEETLE_STRIDE = 0.0084;

// Anoplotrupes stercorosus, 17.5 mm: domed, black with a blue-violet structural sheen, brilliant underneath.
function beetle(m, lo, creature) {
  const T = (r, metal, pattern, part = 0) => ({ part, creature, mat: [r, metal, 0, pattern] });
  const refl = (k) => () => [k, k, k]; // reflectance for the iridescent layer (pattern 1/2 read the red channel)
  // elytra
  loft(m, {
    x0: -8.6, x1: 1.4, rings: lo ? 4 : 10, sides: lo ? 8 : 16, exp: 2.3, tag: T(0.24, 1, 1),
    prof: (t) => {
      const h = Math.pow(Math.sqrt(Math.max(0, 1 - ((t - 0.55) / 0.58) ** 2)), 0.7);
      const w = Math.pow(Math.sqrt(Math.max(0, 1 - ((t - 0.48) / 0.53) ** 2)), 0.45);
      return [3.0, 4.1 * h, 0.4 * w, 5.1 * w];
    },
    color: refl(0.5),
  });
  // pronotum: broad dome, front margin curving round the head
  loft(m, {
    x0: 0.6, x1: 5.7, rings: lo ? 3 : 6, sides: lo ? 8 : 16, exp: 2.3, tag: T(0.26, 1, 1),
    prof: (t) => {
      const e = (t < 0.12 ? Math.sin((Math.PI / 2) * (t / 0.12)) : 1) * (t > 0.75 ? Math.pow(Math.cos((Math.PI / 2) * Math.min(1, (t - 0.75) / 0.25)), 0.7) : 1);
      return [3.0, (3.4 - 1.3 * t) * e, 0.5 * e, (4.75 - 0.6 * t * t) * Math.pow(e, 0.6)];
    },
    color: refl(0.5),
  });
  // head: a flat shovel
  loft(m, {
    x0: 4.9, x1: 8.9, rings: lo ? 2 : 5, sides: lo ? 6 : 12, exp: 2.5, tag: T(0.38, 1, 1),
    prof: (t) => {
      const e = Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.2)));
      return [2.5 - 0.6 * t, 1.6 * e, 0.6 * e, 3.0 * Math.pow(e, 0.6)];
    },
    color: refl(0.4),
  });
  if (!lo) {
    // underside: brilliant metallic violet-blue, seen when it climbs over a crumb
    loft(m, {
      x0: -7.6, x1: 5.3, rings: 6, sides: 10, tag: T(0.2, 1, 2),
      prof: (t) => {
        const e = Math.pow(Math.sin(Math.PI * t), 0.5);
        return [2.4, 0.9 * e, 1.0 * e, 4.3 * Math.pow(e, 0.7)];
      },
      color: refl(1.0),
    });
  }
  BEETLE_LEGS.forEach(([hip, knee, ankle, tip, radii, amp], pair) => {
    for (const side of [-1, 1]) {
      const h = mirror(hip, side);
      const tag = { part: 1, creature, phase: gaitPhase(pair, side), swing: side * amp, pivot: h, lift: 0.0022, mat: [0.32, 1, 0, 1] };
      limb(m, [h, mirror(knee, side), mirror(ankle, side), mirror(tip, side)], radii, [0, 0.45, 0.85, 1], [[0.55, 0.55, 0.55]], tag, lo ? 3 : 5);
    }
  });
  // short antennae with a lamellate club
  for (const side of [-1, 1]) {
    const sock = [7.8, 2.6, 2.0 * side];
    const tag = { part: 2, creature, phase: side * 0.9, swing: side * 0.18, pivot: sock, lift: 3, mat: [0.5, 0, 0, 0] };
    limb(m, [sock, [8.8, 3.0, 3.2 * side], [9.4, 2.85, 3.85 * side], [10.1, 2.6, 4.4 * side]], [0.2, 0.18, 0.45, 0.32], [0, 0.4, 0.75, 1],
      [[0.025, 0.02, 0.018], [0.025, 0.02, 0.018], [0.045, 0.036, 0.03]], tag, lo ? 3 : 4);
  }
}

const LADY_LEGS = [
  [[1.6, 0.6, 0.6], [2.0, 0.95, 1.7], [2.6, 0.25, 2.25], [2.9, 0, 2.45], 0.3],
  [[0.2, 0.55, 0.8], [0.1, 0.9, 2.2], [-0.1, 0.25, 2.8], [-0.3, 0, 3.0], 0.32],
  [[-0.8, 0.55, 0.8], [-1.4, 0.9, 2.1], [-2.0, 0.25, 2.7], [-2.3, 0, 2.9], 0.3],
];
const LADY_STRIDE = 0.003;
const LADY = { red: [0.62, 0.025, 0.008], black: [0.006, 0.006, 0.006] };

// Coccinella septempunctata, 6.8 mm: a glossy red dome with seven black spots (drawn in the fragment shader).
function ladybird(m, lo, creature) {
  const T = (r, coat, pattern) => ({ part: 0, creature, mat: [r, 0, coat, pattern] });
  loft(m, {
    x0: -3.45, x1: 1.25, rings: lo ? 3 : 9, sides: lo ? 8 : 18, tag: T(0.15, 1, 3),
    prof: (t) => {
      const h = Math.sqrt(Math.max(0, 1 - ((t - 0.52) / 0.53) ** 2));
      const w = Math.pow(Math.sqrt(Math.max(0, 1 - ((t - 0.5) / 0.52) ** 2)), 0.8);
      return [0.9, 2.75 * h, 0.35 * w, 2.8 * w];
    },
    color: () => LADY.red,
  });
  loft(m, {
    x0: 0.55, x1: 2.6, rings: lo ? 2 : 5, sides: lo ? 6 : 14, exp: 2.2, tag: T(0.2, 0.8, 4),
    prof: (t) => {
      const e = (t < 0.18 ? Math.sin((Math.PI / 2) * (t / 0.18)) : 1) * (t > 0.62 ? Math.pow(Math.cos((Math.PI / 2) * Math.min(1, (t - 0.62) / 0.38)), 0.6) : 1);
      return [0.9, (1.95 - 0.9 * t) * e, 0.4 * e, (2.0 - 0.45 * t * t) * Math.sqrt(e)];
    },
    color: () => LADY.black,
  });
  loft(m, {
    x0: 2.25, x1: 3.3, rings: lo ? 1 : 3, sides: lo ? 4 : 10, tag: T(0.3, 0.5, 5),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * (0.5 + 0.5 * t)), 0.5);
      return [0.85, 0.62 * e, 0.42 * e, 1.0 * Math.pow(e, 0.7)];
    },
    color: () => LADY.black,
  });
  if (!lo) {
    loft(m, {
      x0: -3.0, x1: 2.4, rings: 3, sides: 8, tag: T(0.45, 0, 0),
      prof: (t) => {
        const e = Math.pow(Math.sin(Math.PI * t), 0.5);
        return [0.9, 0.3 * e, 0.4 * e, 2.3 * e];
      },
      color: () => LADY.black,
    });
  }
  LADY_LEGS.forEach(([hip, knee, ankle, tip, amp], pair) => {
    for (const side of [-1, 1]) {
      const h = mirror(hip, side);
      const tag = { part: 1, creature, phase: gaitPhase(pair, side), swing: side * amp, pivot: h, lift: 0.0005, mat: [0.4, 0, 0, 0] };
      limb(m, [h, mirror(knee, side), mirror(ankle, side), mirror(tip, side)], [0.2, 0.17, 0.13, 0.08], [0, 0.45, 0.85, 1], [LADY.black], tag);
    }
  });
  if (!lo) {
    for (const side of [-1, 1]) {
      const sock = [3.1, 1.0, 0.45 * side];
      const tag = { part: 2, creature, phase: side * 1.1, swing: side * 0.25, pivot: sock, lift: 5, mat: [0.4, 0, 0, 0] };
      limb(m, [sock, [3.6, 1.15, 0.85 * side], [3.95, 1.0, 1.1 * side]], [0.08, 0.08, 0.12], [0, 0.6, 1], [LADY.black], tag);
    }
  }
}

const SPIDER_LEGS = [
  [[1.0, 0.95, 0.65], [2.3, 2.05, 2.05], [3.9, 0.7, 3.25], [5.3, 0, 3.8]],
  [[0.45, 0.95, 0.85], [1.2, 2.15, 2.7], [2.1, 0.7, 4.4], [2.8, 0, 5.5]],
  [[-0.15, 0.95, 0.85], [-0.85, 2.05, 2.6], [-1.8, 0.7, 4.2], [-2.5, 0, 5.2]],
  [[-0.7, 0.95, 0.65], [-1.9, 2.25, 2.1], [-3.9, 0.7, 3.3], [-5.6, 0, 3.9]],
];
const SPIDER_STRIDE = 0.0056;
const SPIDER = {
  carapace: [0.035, 0.025, 0.017],
  band: [0.15, 0.12, 0.08],
  abdomen: [0.07, 0.055, 0.04],
  legLight: [0.12, 0.095, 0.065],
  legDark: [0.035, 0.026, 0.018],
};

// Pardosa wolf spider, 6.5 mm body: brown-grey, a pale median band, banded legs.
function spider(m, lo, creature) {
  const T = (r, pattern) => ({ part: 0, creature, mat: [r, 0, 0, pattern] });
  loft(m, {
    x0: -1.6, x1: 1.75, rings: lo ? 2 : 6, sides: lo ? 6 : 10, tag: T(0.55, 6),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * t), 0.45);
      return [1.35 + 0.25 * t, (0.65 + 0.35 * smoothstep(0.4, 0.9, t)) * e, 0.35 * e, 1.15 * Math.pow(e, 0.6) * (1 - 0.25 * t)];
    },
    color: (t, ca, sa) => lerp3(SPIDER.carapace, SPIDER.band, smoothstep(0.45, 0.8, Math.abs(ca)) * smoothstep(0.6, 0.1, sa)),
  });
  loft(m, {
    x0: -5.0, x1: -1.4, rings: lo ? 2 : 6, sides: lo ? 6 : 10, tag: T(0.6, 7),
    prof: (t) => {
      const e = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.55);
      return [1.3 + 0.25 * t, 1.0 * e, 0.85 * e, 1.1 * e];
    },
    color: () => SPIDER.abdomen,
  });
  SPIDER_LEGS.forEach(([hip, knee, ankle, tip], pair) => {
    for (const side of [-1, 1]) {
      const h = mirror(hip, side);
      const tag = { part: 1, creature, phase: gaitPhase(pair, side), swing: side * 0.32, pivot: h, lift: 0.0009, mat: [0.6, 0, 0, 0] };
      const k = mirror(knee, side);
      const a = mirror(ankle, side);
      const pts = lo ? [h, k, a, mirror(tip, side)] : [h, lerp3(h, k, 0.5), k, lerp3(k, a, 0.5), a, mirror(tip, side)];
      const radii = lo ? [0.24, 0.19, 0.15, 0.08] : [0.24, 0.23, 0.19, 0.17, 0.15, 0.08];
      const ts = lo ? [0, 0.45, 0.8, 1] : [0, 0.22, 0.45, 0.62, 0.8, 1];
      const L = SPIDER.legLight;
      const D = SPIDER.legDark;
      limb(m, pts, radii, ts, lo ? [D] : [D, L, D, L, D, D], tag);
    }
  });
  for (const side of [-1, 1]) {
    const sock = [1.65, 1.2, 0.35 * side];
    const tag = { part: 2, creature, phase: side * 0.7, swing: side * 0.1, pivot: sock, lift: 4, mat: [0.6, 0, 0, 0] };
    limb(m, [sock, [2.2, 1.35, 0.55 * side], [2.6, 0.55, 0.65 * side]], [0.13, 0.12, 0.1], [0, 0.5, 1], [SPIDER.legDark], tag);
  }
}

/** Beetle (creature 0), ladybird (1) and spider (2) in one geometry, each posed by its own uniform matrix. */
export function soloGeometry(lo = false) {
  const m = new RigMesh();
  beetle(m, lo, 0);
  ladybird(m, lo, 1);
  spider(m, lo, 2);
  return m.build();
}

// ── the mound: a dome of needles and twig bits ──────────────
function prism(G, p0, p1, r, c, kind, sides) {
  _T.subVectors(p1, p0).normalize();
  _N.set(0, 1, 0);
  if (Math.abs(_T.y) > 0.9) _N.set(1, 0, 0);
  _N.cross(_T).normalize();
  _B.crossVectors(_T, _N);
  const base = G.pos.length / 3;
  for (const p of [p0, p1]) {
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      G.pos.push(p.x + _N.x * ca + _B.x * sa, p.y + _N.y * ca + _B.y * sa, p.z + _N.z * ca + _B.z * sa);
      G.col.push(c[0], c[1], c[2]);
      G.kind.push(kind);
    }
  }
  for (let j = 0; j < sides; j++) {
    const a = base + j;
    const b = base + ((j + 1) % sides);
    G.idx.push(a, b, a + sides, b, b + sides, a + sides);
  }
}

const NEEDLE_TONES = [
  [0.17, 0.085, 0.032], // brown spruce needles
  [0.13, 0.07, 0.03],
  [0.105, 0.07, 0.045], // old, grey-brown
  [0.24, 0.13, 0.05], // fresh, reddish
  [0.075, 0.05, 0.03],
];

const _sn = new THREE.Vector3();
function surfaceNormal(x, z, out, e = 0.003) {
  const hx = lifeSurfaceAt(x + e, z) - lifeSurfaceAt(x - e, z);
  const hz = lifeSurfaceAt(x, z + e) - lifeSurfaceAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

export function moundGeometry(tier, rng) {
  const lo = tier === 'low';
  const { R } = LIFE.mound;
  const G = { pos: [], col: [], kind: [], idx: [] };
  const vert = (x, y, z, c) => {
    G.pos.push(x, y, z);
    G.col.push(c[0], c[1], c[2]);
    G.kind.push(0);
  };
  const tint = (x, z, q) => {
    const f = 0.92 + 0.14 * noise2(x * 6 + 1.7, z * 6 - 2.2) - 0.14 * smoothstep(0.5, 1.0, q) + 0.06 * smoothstep(0.35, 0, q);
    return [f * 1.04, f, f * 0.95];
  };
  // polar dome; the skirt ends 3 cm under the floor so the rim never floats over the coarse terrain mesh
  const K = lo ? 14 : 22;
  const S = lo ? 36 : 56;
  const ringQ = [];
  for (let k = 1; k <= K; k++) ringQ.push(Math.pow(k / K, 0.8));
  ringQ.push(1.07);
  vert(MC.x, lifeSurfaceAt(MC.x, MC.z), MC.z, tint(MC.x, MC.z, 0));
  for (const q of ringQ) {
    for (let j = 0; j < S; j++) {
      const a = (j / S) * TAU;
      const x = MC.x + Math.cos(a) * R * q;
      const z = MC.z + Math.sin(a) * R * q;
      const y = q < 0.999 ? lifeSurfaceAt(x, z) - 0.003 * smoothstep(0.9, 1.0, q) : heroHeightAt(x, z) - (q > 1.01 ? 0.03 : 0.002);
      vert(x, y, z, tint(x, z, q));
    }
  }
  for (let j = 0; j < S; j++) G.idx.push(0, 1 + ((j + 1) % S), 1 + j);
  for (let k = 0; k < ringQ.length - 1; k++) {
    for (let j = 0; j < S; j++) {
      const a = 1 + k * S + j;
      const b = 1 + k * S + ((j + 1) % S);
      G.idx.push(a, b, a + S, b, b + S, a + S);
    }
  }
  // loose needles and twig bits, mostly on the flank that faces the patch
  const toPatchAng = Math.atan2(PC.y - MC.z, PC.x - MC.x);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const place = (apron) => {
    for (let tries = 0; tries < 8; tries++) {
      const a = toPatchAng + (rng.next() - 0.5) * TAU * (rng.chance(0.75) ? 0.36 : 1);
      const q = apron ? rng.float(0.98, 1.25) : Math.sqrt(rng.next()) * 0.97;
      const x = MC.x + Math.cos(a) * R * q;
      const z = MC.z + Math.sin(a) * R * q;
      // the apron debris stays off other modules' ground
      if (apron && inPatch(x, z, 0) && Math.hypot(x - MC.x, z - MC.z) > R * 1.08) continue;
      c.set(x, lifeSurfaceAt(x, z), z);
      surfaceNormal(x, z, _sn);
      return true;
    }
    return false;
  };
  const nNeedles = LIFE.needles[tier] ?? LIFE.needles.medium;
  for (let i = 0; i < nNeedles; i++) {
    if (!place(i % 10 === 0)) continue;
    const ang = rng.float(0, TAU);
    d.set(Math.cos(ang), 0, Math.sin(ang));
    d.addScaledVector(_sn, -d.dot(_sn)).normalize();
    d.y += rng.float(-0.12, 0.35);
    d.normalize();
    const hl = rng.float(0.0035, 0.0085);
    const r = rng.float(0.00042, 0.0006);
    c.addScaledVector(_sn, r * 0.3);
    p0.copy(c).addScaledVector(d, -hl);
    p1.copy(c).addScaledVector(d, hl);
    const tone = NEEDLE_TONES[Math.floor(rng.next() * NEEDLE_TONES.length)];
    const k = rng.float(0.75, 1.25);
    prism(G, p0, p1, r, [tone[0] * k, tone[1] * k, tone[2] * k], 1, 3);
  }
  const nTwigs = LIFE.twigs[tier] ?? LIFE.twigs.medium;
  for (let i = 0; i < nTwigs; i++) {
    if (!place(false)) continue;
    const ang = rng.float(0, TAU);
    d.set(Math.cos(ang), 0, Math.sin(ang));
    d.addScaledVector(_sn, -d.dot(_sn)).normalize();
    const hl = rng.float(0.008, 0.022);
    const r = rng.float(0.0008, 0.0017);
    c.addScaledVector(_sn, r * 0.2);
    p0.copy(c).addScaledVector(d, -hl);
    p1.copy(c).addScaledVector(d, hl);
    const g = rng.float(0.7, 1.2);
    prism(G, p0, p1, r, [0.085 * g, 0.062 * g, 0.045 * g], 2, 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(G.col, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(G.kind, 1));
  g.setIndex(G.idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ── shaders ─────────────────────────────────────────────────
// Shared vertex code: legs swing and lift around their hips from one gait phase, antennae sweep and tap,
// thin limbs are widened to at least uMinPx on screen, cargo that an ant is not carrying collapses away.
const RIG_GLSL = /* glsl */ `
attribute vec4 aRig;
attribute vec4 aPivot;
attribute vec4 aAxis;
uniform float uLifeTime;
uniform float uViewH;
uniform float uMinPx;
#ifdef USE_INSTANCING
  attribute vec4 aGait;
#else
  uniform mat4 uSolo[ 3 ];
  uniform vec4 uSoloGait[ 3 ];
#endif
vec3 lifeRotY( vec3 p, float a ) {
  float c = cos( a ), s = sin( a );
  return vec3( c * p.x + s * p.z, p.y, c * p.z - s * p.x );
}
vec3 lifeRotZ( vec3 p, float a ) {
  float c = cos( a ), s = sin( a );
  return vec3( c * p.x - s * p.y, s * p.x + c * p.y, p.z );
}
vec3 lifeWiden( vec3 p, vec3 ax, mat4 M ) {
  vec3 off = p - ax;
  float r = length( off ) * length( M[ 0 ].xyz );
  vec4 mv = modelViewMatrix * ( M * vec4( ax, 1.0 ) );
  float pxPerM = projectionMatrix[ 1 ][ 1 ] * 0.5 * uViewH / max( - mv.z, 1e-3 );
  float k = clamp( uMinPx / max( 2.0 * r * pxPerM, 1e-6 ), 1.0, 2.6 );
  return ax + off * k;
}
vec3 lifePose( vec3 p, inout vec3 n, vec4 gait, mat4 M ) {
  float part = aRig.x;
  vec3 piv = aPivot.xyz;
  if ( part > 0.5 && part < 1.5 ) {
    float ph = gait.x + aRig.y;
    float sw = aRig.z * gait.y * sin( ph );
    float lift = aPivot.w * gait.y * max( cos( ph ), 0.0 ) * smoothstep( 0.0, 1.0, aRig.w );
    vec3 ax = lifeRotY( aAxis.xyz - piv, sw ) + piv;
    p = lifeRotY( p - piv, sw ) + piv;
    ax.y += lift;
    p.y += lift;
    n = lifeRotY( n, sw );
    p = lifeWiden( p, ax, M );
  } else if ( part > 1.5 && part < 2.5 ) {
    float tt = uLifeTime * aPivot.w + gait.w * 6.2831853 + aRig.y;
    float yaw = aRig.z * ( 0.7 * sin( tt ) + 0.3 * sin( tt * 2.3 + 1.7 ) );
    float pitch = 0.2 * sin( tt * 1.37 + 0.6 ) + 0.08 * sin( tt * 3.1 );
    vec3 ax = lifeRotY( lifeRotZ( aAxis.xyz - piv, pitch ), yaw ) + piv;
    p = lifeRotY( lifeRotZ( p - piv, pitch ), yaw ) + piv;
    n = lifeRotY( lifeRotZ( n, pitch ), yaw );
    p = lifeWiden( p, ax, M );
  } else if ( part > 2.5 ) {
    if ( abs( gait.z - ( part - 2.0 ) ) > 0.5 ) p = piv;
  }
  return p;
}
`;

const POSE_VERTEX = /* glsl */ `
vec3 objectNormal = vec3( normal );
#ifdef USE_INSTANCING
  vec4 lifeGait = aGait;
  mat4 lifeM = instanceMatrix;
#else
  int lifeC = int( aAxis.w + 0.5 );
  vec4 lifeGait = uSoloGait[ lifeC ];
  mat4 lifeM = uSolo[ lifeC ];
#endif
vec3 lifeP = lifePose( position, objectNormal, lifeGait, lifeM );
#ifndef USE_INSTANCING
  lifeP = ( lifeM * vec4( lifeP, 1.0 ) ).xyz;
  objectNormal = mat3( lifeM ) * objectNormal;
#endif
vLifeMat = aMat;
vLifeLocal = position;
`;

const CREATURE_FRAG_PARS = /* glsl */ `
uniform vec3 uEnvSky;
uniform vec3 uEnvGround;
uniform vec3 uEnvSun;
uniform vec3 uSunDirW;
varying vec4 vLifeMat;
varying vec3 vLifeLocal;
// Sky seen in glossy chitin: there is no environment map, so reflect a soft canopy gradient and the bright sky
// around the sun, blurred by roughness.
vec3 lifeEnv( vec3 r, float rough ) {
  float k = smoothstep( -0.3 - rough * 0.5, 0.5 + rough * 0.4, r.y );
  vec3 c = mix( uEnvGround, uEnvSky * ( 0.8 + 0.2 * r.y ), k );
  float sp = mix( 24.0, 3.0, rough );
  return c + uEnvSun * pow( max( dot( r, uSunDirW ), 0.0 ), sp );
}
`;

// After <color_fragment>: structural colour of the beetle and the patterns of ladybird and spider (local mm).
const CREATURE_COLOR = /* glsl */ `
{
  float lifeSp = vLifeMat.w;
  vec2 lp = vLifeLocal.xz * 1000.0;
  float aa = max( fwidth( lp.x ), fwidth( lp.y ) ) + 1e-4;
  float lNdv = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
  if ( lifeSp > 0.5 && lifeSp < 2.5 ) {
    // multilayer reflector: blue-green face on, deep blue, then violet toward grazing angles
    vec3 face = vec3( 0.05, 0.19, 0.3 );
    vec3 mid = vec3( 0.08, 0.1, 0.46 );
    vec3 graze = vec3( 0.26, 0.07, 0.4 );
    vec3 irid = lNdv > 0.55 ? mix( mid, face, ( lNdv - 0.55 ) / 0.45 ) : mix( graze, mid, lNdv / 0.55 );
    diffuseColor.rgb = irid * diffuseColor.r;
  } else if ( lifeSp > 2.5 && lifeSp < 3.5 ) {
    // seven spots: one shared behind the scutellum, three per elytron; white flecks at the elytral base
    vec2 q = vec2( lp.x, abs( lp.y ) );
    float d = min( length( lp - vec2( 0.8, 0.0 ) ) - 0.7, length( q - vec2( 0.05, 1.45 ) ) - 0.55 );
    d = min( d, length( q - vec2( -1.05, 1.95 ) ) - 0.78 );
    d = min( d, length( q - vec2( -2.35, 1.1 ) ) - 0.6 );
    float spot = 1.0 - smoothstep( -aa, aa, d );
    float seam = 1.0 - smoothstep( 0.035, 0.035 + aa * 1.5, q.y );
    float fleck = 1.0 - smoothstep( -aa, aa, length( q - vec2( 1.0, 0.75 ) ) - 0.22 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.004 ), max( spot, seam * 0.7 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.7, 0.64 ), fleck );
  } else if ( lifeSp > 3.5 && lifeSp < 4.5 ) {
    // pronotum: white front corners
    float d = length( vec2( lp.x, abs( lp.y ) ) - vec2( 2.1, 1.4 ) ) - 0.6;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.7, 0.68, 0.62 ), 1.0 - smoothstep( -aa, aa, d ) );
  } else if ( lifeSp > 4.5 && lifeSp < 5.5 ) {
    // head: two small pale spots on the frons
    float d = length( vec2( lp.x, abs( lp.y ) ) - vec2( 2.95, 0.42 ) ) - 0.17;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.6, 0.58, 0.52 ), 1.0 - smoothstep( -aa, aa, d ) );
  } else if ( lifeSp > 5.5 && lifeSp < 6.5 ) {
    // carapace: pale median band widening toward the eyes, two big dark eyes
    float band = 1.0 - smoothstep( -aa, aa, abs( lp.y ) - ( 0.22 + 0.2 * smoothstep( -0.5, 1.2, lp.x ) ) );
    band *= smoothstep( 1.45, 1.6, vLifeLocal.y * 1000.0 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.16, 0.13, 0.09 ), band );
    float eye = 1.0 - smoothstep( -aa, aa, length( vec2( lp.x, abs( lp.y ) ) - vec2( 1.3, 0.33 ) ) - 0.2 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.003 ), eye );
  } else if ( lifeSp > 6.5 ) {
    // abdomen: pale lanceolate heart mark, dark chevrons toward the spinnerets
    float x = lp.x;
    float z = abs( lp.y );
    float lance = 1.0 - smoothstep( -aa, aa, z - 0.28 * max( 0.0, 1.0 - pow( ( x + 2.2 ) / 1.0, 2.0 ) ) );
    float f = fract( ( x + z * 0.9 ) / 0.5 );
    float chev = smoothstep( 0.0, 0.12, f ) * ( 1.0 - smoothstep( 0.2, 0.34, f ) ) * smoothstep( -2.9, -3.3, x ) * ( 1.0 - smoothstep( 0.6, 0.95, z ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.15, 0.125, 0.09 ), lance );
    diffuseColor.rgb *= 1.0 - 0.6 * chev;
  }
}
`;

const CREATURE_ENV = /* glsl */ `
#if defined( RE_IndirectSpecular )
{
  vec3 lifeR = inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
  radiance += lifeEnv( lifeR, material.roughness );
  #ifdef USE_CLEARCOAT
    vec3 lifeRc = inverseTransformDirection( reflect( - geometryViewDir, geometryClearcoatNormal ), viewMatrix );
    clearcoatRadiance += lifeEnv( lifeRc, material.clearcoatRoughness );
  #endif
}
#endif
`;

function creatureMaterial(U) {
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    ior: 1.5,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_GLSL}\nattribute vec4 aMat;\nvarying vec4 vLifeMat;\nvarying vec3 vLifeLocal;`)
      .replace('#include <beginnormal_vertex>', POSE_VERTEX)
      .replace('#include <begin_vertex>', 'vec3 transformed = lifeP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${CREATURE_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CREATURE_COLOR}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vLifeMat.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vLifeMat.y;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n  material.clearcoat *= vLifeMat.z;\n#endif')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${CREATURE_ENV}`);
  };
  mat.customProgramCacheKey = () => 'flyover-life-creature';
  return mat;
}

// The sun shadow of each creature, flattened along the sun onto the ground plane under its feet. Fragments
// write the exact depth of that plane (from gl_FragCoord and per-creature flat values only), so overlapping
// legs and body parts of one creature land on bit-identical depths and LessDepth lets only the first through:
// the shadow darkens once, like a real one, and it still hides behind the creature itself.
const SHADOW_VERT = /* glsl */ `
#include <common>
#include <packing>
${RIG_GLSL}
uniform vec3 uSunDir;
uniform float uShadowK;
uniform vec4 uReach;
uniform float uFadeR;
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
flat varying vec3 vO;
flat varying vec3 vN;
varying float vA;
float lifeSunVis( vec3 wp ) {
  if ( uHasShadow < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( wp, 1.0 );
  sc.xyz /= sc.w;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
  float d = unpackRGBAToDepth( textureLod( tShadow, sc.xy, 0.0 ) );
  return step( sc.z - 0.002, d );
}
void main() {
  vec3 n = normal;
#ifdef USE_INSTANCING
  vec4 g = aGait;
  mat4 M = instanceMatrix;
  float reach = uReach.x;
#else
  int c = int( aAxis.w + 0.5 );
  vec4 g = uSoloGait[ c ];
  mat4 M = uSolo[ c ];
  float reach = c == 0 ? uReach.y : ( c == 1 ? uReach.z : uReach.w );
#endif
  vec3 p = lifePose( position, n, g, M );
  mat4 W = modelMatrix * M;
  vec3 wp = ( W * vec4( p, 1.0 ) ).xyz;
  vec3 O = W[ 3 ].xyz;
  vec3 N = normalize( W[ 1 ].xyz );
  float sN = dot( uSunDir, N );
  float h = max( dot( wp - O, N ), 0.0 );
  vec3 sp = wp - uSunDir * ( h / max( sN, 0.2 ) );
  vO = O;
  vN = N;
  float fade = 1.0 - smoothstep( reach * 0.7, reach, distance( sp, O ) );
  fade *= 1.0 - smoothstep( uFadeR * 0.75, uFadeR, distance( cameraPosition, O ) );
  vA = uShadowK * smoothstep( 0.05, 0.25, sN ) * lifeSunVis( O + N * 0.03 ) * fade;
  gl_Position = projectionMatrix * viewMatrix * vec4( sp, 1.0 );
}
`;

const SHADOW_FRAG = /* glsl */ `
uniform vec4 uViewport;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform float uLift;
flat varying vec3 vO;
flat varying vec3 vN;
varying float vA;
void main() {
  if ( vA < 0.003 ) discard;
  vec2 ndc = ( gl_FragCoord.xy - uViewport.xy ) / uViewport.zw * 2.0 - 1.0;
  vec4 q = uInvVP * vec4( ndc, 0.0, 1.0 );
  vec3 dir = q.xyz / q.w - cameraPosition;
  float den = dot( dir, vN );
  if ( abs( den ) < 1e-7 ) discard;
  vec3 hit = cameraPosition + dir * ( dot( vO - cameraPosition, vN ) / den );
  hit += normalize( cameraPosition - hit ) * uLift;
  vec4 clip = uVP * vec4( hit, 1.0 );
  gl_FragDepth = clamp( clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0 );
  gl_FragColor = vec4( 0.0, 0.0, 0.0, vA );
}
`;

function shadowMaterial(SU) {
  return new THREE.ShaderMaterial({
    uniforms: SU,
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    transparent: true,
    depthWrite: true,
    depthFunc: THREE.LessDepth,
    side: THREE.FrontSide,
  });
}

// The mound: procedural needle thatch (top-most needle per pixel, filtered by footprint), nest entrances, snow.
const MOUND_FRAG_PARS = /* glsl */ `
uniform float uSnow;
uniform vec4 uHoles[ 8 ];
varying float vKind;
varying vec3 vMW;
vec2 lifeSlope = vec2( 0.0 );
vec4 lifeHash4( vec2 p ) {
  vec4 p4 = fract( vec4( p.xyxy ) * vec4( 0.1031, 0.103, 0.0973, 0.1099 ) );
  p4 += dot( p4, p4.wzxy + 33.33 );
  return fract( ( p4.xxyz + p4.yzzw ) * p4.zywx );
}
// Needles are at most one cell long on each side of their centre, so the 3 × 3 cell search never clips one.
vec3 lifeThatch( vec2 p, float px ) {
  const float CS = 0.0065;
  vec2 cell = floor( p / CS );
  float best = -1.0;
  // between the top needles: the shaded layer below
  vec3 col = vec3( 0.045, 0.027, 0.014 ) * ( 0.7 + 0.6 * lifeHash4( cell ).x );
  for ( int j = -1; j <= 1; j++ ) {
    for ( int i = -1; i <= 1; i++ ) {
      vec2 c = cell + vec2( float( i ), float( j ) );
      for ( int k = 0; k < 3; k++ ) {
        vec4 h = lifeHash4( c * 1.731 + float( k ) * 17.37 + 0.5 );
        vec2 ctr = ( c + h.xy ) * CS;
        float ang = h.z * 6.2831853;
        vec2 dir = vec2( cos( ang ), sin( ang ) );
        vec2 d = p - ctr;
        float al = dot( d, dir );
        float ac = dot( d, vec2( - dir.y, dir.x ) );
        float hl = mix( 0.003, 0.0058, h.w ); // + half width stays inside one cell
        float w = mix( 0.00045, 0.0006, fract( h.w * 7.1 ) );
        float dist = length( vec2( max( abs( al ) - hl, 0.0 ), ac ) );
        float cov = 1.0 - smoothstep( w - px, w + px, dist );
        float layer = fract( h.x * 13.7 + h.y * 7.3 );
        if ( cov > 0.35 && layer > best ) {
          best = layer;
          float tone = fract( h.w * 31.7 );
          vec3 nc = tone < 0.55 ? vec3( 0.17, 0.085, 0.032 ) : ( tone < 0.85 ? vec3( 0.105, 0.07, 0.045 ) : vec3( 0.24, 0.13, 0.05 ) );
          nc *= 0.75 + 0.5 * fract( h.z * 5.3 );
          float across = clamp( ac / w, -1.0, 1.0 );
          col = mix( col, nc * ( 0.8 + 0.25 * sqrt( 1.0 - across * across ) ), cov );
          lifeSlope = vec2( - dir.y, dir.x ) * across * 0.8 * cov;
        }
      }
    }
  }
  // pixels much wider than a needle: fade to the average so the thatch never sparkles
  float blur = smoothstep( 0.8, 2.4, px / 0.0005 );
  lifeSlope *= 1.0 - blur;
  return mix( col, vec3( 0.105, 0.058, 0.027 ), blur );
}
`;

const MOUND_COLOR = /* glsl */ `
{
  vec3 wN = inverseTransformDirection( normalize( vNormal ), viewMatrix );
  float px = length( fwidth( vMW.xz ) ) * 0.5; // outside the branch: derivatives need uniform control flow
  if ( vKind < 0.5 ) {
    diffuseColor.rgb *= lifeThatch( vMW.xz, px );
    float hole = 0.0;
    for ( int i = 0; i < 8; i++ ) {
      float d = length( vMW.xz - uHoles[ i ].xy ) - uHoles[ i ].z;
      hole = max( hole, 1.0 - smoothstep( -0.0015, 0.0015, d ) );
    }
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.006, 0.004, 0.003 ), hole );
    lifeSlope *= 1.0 - hole;
  }
  float snow = uSnow * smoothstep( 0.25, 0.7, wN.y + 0.25 * sin( vMW.x * 61.0 + sin( vMW.z * 47.0 ) ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.75, 0.8 ), snow * 0.9 );
  lifeSlope *= 1.0 - snow;
}
`;

function moundMaterial(holes) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  const uHoles = { value: holes };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = shared.uSnow;
    sh.uniforms.uHoles = uHoles;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aKind;\nvarying float vKind;\nvarying vec3 vMW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvKind = aKind;\nvMW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${MOUND_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${MOUND_COLOR}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vKind > 0.5 ? 0.62 : roughness;')
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize( normal + mat3( viewMatrix ) * vec3( lifeSlope.x, 0.0, lifeSlope.y ) * 0.6 );',
      );
  };
  mat.customProgramCacheKey = () => 'flyover-life-mound';
  return mat;
}

// ── simulation helpers ──────────────────────────────────────
const TIERS = ['ultra', 'high', 'medium', 'low'];
const pickTier = (t) => (TIERS.includes(t) ? t : 'medium');
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

/**
 * Build the creatures. Returns { group, update(dt, time, state), applySeason(sp, v), stats, setPerches(perches) }.
 * perches: [{ p: Vector3, n: Vector3 }] — lingon leaf tops; the ladybird takes the one nearest SPOTS.ladybird.
 */
export function buildLife(ctx = {}) {
  const tier = pickTier(ctx.quality?.tier);
  const rng = new RNG(7151);
  const group = new THREE.Group();
  group.name = 'flyover-life';

  // ── surfaces ──
  const trail = buildTrail();
  const MU = LIFE.mound;
  const moundGrid = new PatchGrid(MU.u - 0.14, MU.v - 0.14, 0.62, 0.62, 0.006, lifeSurfaceAt);
  const BS = SPOTS.beetle;
  const beetleGrid = new PatchGrid(BS.u - 0.075, BS.v - 0.075, 0.15, 0.15, 0.004, lifeSurfaceAt);
  const SS = LIFE.spider;
  const spiderGrid = new PatchGrid(SS.u - SS.r - 0.03, SS.v - SS.r - 0.03, 2 * SS.r + 0.06, 2 * SS.r + 0.06, 0.005, lifeSurfaceAt);

  // ── shared uniforms ──
  const U = {
    uLifeTime: shared.uTime,
    uViewH: { value: 720 },
    uMinPx: { value: LIFE.minPx[tier] },
    uSolo: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
    uSoloGait: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uEnvSky: { value: new THREE.Vector3(0.26, 0.31, 0.37) },
    uEnvGround: { value: new THREE.Vector3(0.05, 0.05, 0.03) },
    uEnvSun: { value: new THREE.Vector3(0.17, 0.15, 0.12) },
    uSunDirW: { value: SUN_DIR },
  };
  for (const m4 of U.uSolo.value) m4.elements.fill(0);
  const SU = {
    uLifeTime: U.uLifeTime,
    uViewH: U.uViewH,
    uMinPx: U.uMinPx,
    uSolo: U.uSolo,
    uSoloGait: U.uSoloGait,
    uSunDir: { value: SUN_DIR },
    uShadowK: { value: 0.66 * LIFE.shadowK },
    uReach: { value: new THREE.Vector4(0.012, 0.03, 0.0075, 0.02) }, // ants, beetle, ladybird (stays on its leaf), spider
    uFadeR: { value: LIFE.shadowFade },
    tShadow: shadowUniforms.tShadow,
    uShadowMatrix: shadowUniforms.uShadowMatrix,
    uHasShadow: shadowUniforms.uHasShadow,
    uViewport: { value: new THREE.Vector4(0, 0, 1280, 720) },
    uInvVP: { value: new THREE.Matrix4() },
    uVP: { value: new THREE.Matrix4() },
    uLift: { value: 0.0012 }, // shadow plane sits this far toward the camera: covers hollows and needles lying on the floor
  };
  const creatureMat = creatureMaterial(U);
  const shadowMat = shadowMaterial(SU);

  // exact viewport and camera of the pass that is drawing (the post pipeline renders into its own target)
  const _vp = new THREE.Vector4();
  const frameUniforms = (renderer, scene, camera) => {
    renderer.getCurrentViewport(_vp);
    SU.uViewport.value.copy(_vp);
    U.uViewH.value = Math.max(1, _vp.w);
    SU.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    SU.uVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  };

  // ── ants ──
  const nAll = LIFE.ants[tier];
  const nTrail = Math.round(nAll * LIFE.trailShare);
  const nMound = nAll - nTrail;
  const shadowCap = LIFE.shadowCap[tier];
  const antGeo = antGeometry(false);
  const antShadowGeo = antGeometry(true);
  const gaitAttr = new THREE.InstancedBufferAttribute(new Float32Array(nAll * 4), 4).setUsage(THREE.DynamicDrawUsage);
  antGeo.setAttribute('aGait', gaitAttr);
  antShadowGeo.setAttribute('aGait', gaitAttr);
  const ants = new THREE.InstancedMesh(antGeo, creatureMat, nAll);
  ants.name = 'life-ants';
  ants.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ants.receiveShadow = true;
  ants.count = 0;
  const antShadows = new THREE.InstancedMesh(antShadowGeo, shadowMat, nAll);
  antShadows.name = 'life-ant-shadows';
  antShadows.instanceMatrix = ants.instanceMatrix;
  antShadows.count = 0;
  ants.onBeforeRender = frameUniforms;
  antShadows.onBeforeRender = frameUniforms;
  // the trail and the mound, with room for bodies and the trail's lateral spread
  {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < trail.n; i += 10) {
      const u = trail.cu[i];
      const v = trail.cv[i];
      box.expandByPoint(p.set(wX(u, v), trail.H[i * trail.nw + 4], wZ(u, v)));
    }
    box.expandByPoint(p.set(MC.x, lifeSurfaceAt(MC.x, MC.z), MC.z));
    box.expandByScalar(0.05);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius += LIFE.mound.R;
    ants.boundingSphere = sphere;
    antShadows.boundingSphere = sphere.clone();
  }

  // trail ants: arc position, direction (+1 away from the nest), wander and pauses
  const A = {
    s: new Float64Array(nTrail),
    dir: new Int8Array(nTrail),
    vBase: new Float32Array(nTrail),
    v: new Float32Array(nTrail),
    cap: new Float32Array(nTrail),
    scale: new Float32Array(nTrail),
    phase: new Float32Array(nTrail),
    seed: new Float32Array(nTrail),
    carry: new Uint8Array(nTrail),
    wa1: new Float32Array(nTrail),
    wk1: new Float32Array(nTrail),
    wp1: new Float32Array(nTrail),
    wa2: new Float32Array(nTrail),
    wk2: new Float32Array(nTrail),
    wp2: new Float32Array(nTrail),
    dist: new Float64Array(nTrail),
    push: new Float32Array(nTrail),
    pushT: new Float32Array(nTrail),
    slope: new Float32Array(nTrail),
    w: new Float32Array(nTrail),
    pause: new Float32Array(nTrail),
    nextPause: new Float32Array(nTrail),
    hide: new Float32Array(nTrail),
    cool: new Float32Array(nTrail),
    rank: new Float32Array(nTrail),
    pres: new Float32Array(nTrail),
    order: new Int16Array(nTrail),
  };
  const antScale = () => {
    const [a, b] = LIFE.antSize;
    return a + (b - a) * (rng.next() + rng.next() + rng.next()) / 3;
  };
  const pickCarry = () => (rng.chance(LIFE.carry.needle) ? 1 : rng.chance(LIFE.carry.seed / (1 - LIFE.carry.needle)) ? 2 : 0);
  for (let i = 0; i < nTrail; i++) {
    A.s[i] = ((i + rng.float(0.15, 0.85)) / nTrail) * trail.L;
    A.dir[i] = rng.sign();
    A.vBase[i] = rng.float(LIFE.antSpeed[0], LIFE.antSpeed[1]);
    A.v[i] = A.vBase[i];
    A.scale[i] = antScale();
    A.phase[i] = rng.float(0, TAU);
    A.seed[i] = rng.next();
    A.carry[i] = A.dir[i] < 0 ? pickCarry() : 0;
    A.wa1[i] = rng.float(0.002, 0.0045);
    A.wk1[i] = rng.float(18, 40);
    A.wp1[i] = rng.float(0, TAU);
    A.wa2[i] = rng.float(0.0008, 0.002);
    A.wk2[i] = rng.float(70, 140);
    A.wp2[i] = rng.float(0, TAU);
    A.nextPause[i] = rng.float(1, 14);
    A.rank[i] = rng.next();
    A.pres[i] = 1;
    A.order[i] = i;
    A.w[i] = A.dir[i] * 0.003 + A.wa1[i] * Math.sin(A.wp1[i]) + A.wa2[i] * Math.sin(A.wp2[i]);
  }
  // keep the order array sorted by s from the start
  A.order.sort((a, b) => A.s[a] - A.s[b]);

  // mound ants: a random walk over the flank that faces the patch, in and out of the nest entrances
  const holes = [];
  {
    const trailStart = { u: trail.cu[0], v: trail.cv[0] };
    holes.push(new THREE.Vector4(wX(trailStart.u, trailStart.v), wZ(trailStart.u, trailStart.v), 0.0055, 0));
    const toPatchAng = Math.atan2(-MU.v, -MU.u);
    while (holes.length < 8) {
      const a = toPatchAng + rng.float(-0.95, 0.95);
      const r = rng.float(0.1, 0.36);
      const u = MU.u + Math.cos(a) * r;
      const v = MU.v + Math.sin(a) * r;
      holes.push(new THREE.Vector4(wX(u, v), wZ(u, v), rng.float(0.004, 0.007), 0));
    }
  }
  const holeUV = holes.map((h) => {
    const dx = h.x - PC.x;
    const dz = h.y - PC.y;
    return [dx * PU.x + dz * PU.y, dx * PV.x + dz * PV.y];
  });
  const B = {
    u: new Float64Array(nMound),
    v: new Float64Array(nMound),
    th: new Float32Array(nMound),
    sp: new Float32Array(nMound),
    vBase: new Float32Array(nMound),
    scale: new Float32Array(nMound),
    phase: new Float32Array(nMound),
    seed: new Float32Array(nMound),
    carry: new Uint8Array(nMound),
    pause: new Float32Array(nMound),
    nextPause: new Float32Array(nMound),
    hide: new Float32Array(nMound),
    goal: new Int8Array(nMound), // nest entrance it heads for (-1 = wandering)
    goalIn: new Float32Array(nMound),
    rank: new Float32Array(nMound),
    pres: new Float32Array(nMound),
    cap: new Float32Array(nMound),
    // trail ants climbing the mound, as obstacles for the swarm
    obsU: new Float64Array(nTrail),
    obsV: new Float64Array(nTrail),
  };
  const inMoundRegion = (u, v) => {
    const du = u - MU.u;
    const dv = v - MU.v;
    return du > -0.1 && dv > -0.1 && du * du + dv * dv < 0.46 * 0.46;
  };
  for (let i = 0; i < nMound; i++) {
    let u;
    let v;
    do {
      u = MU.u + rng.float(-0.1, 0.46);
      v = MU.v + rng.float(-0.1, 0.46);
    } while (!inMoundRegion(u, v));
    B.u[i] = u;
    B.v[i] = v;
    B.th[i] = rng.float(0, TAU);
    B.vBase[i] = rng.float(0.022, 0.045);
    B.scale[i] = antScale();
    B.phase[i] = rng.float(0, TAU);
    B.seed[i] = rng.next();
    B.carry[i] = rng.chance(0.18) ? 1 : 0;
    B.nextPause[i] = rng.float(0.5, 6);
    B.goal[i] = -1;
    B.goalIn[i] = rng.float(3, 25);
    B.rank[i] = rng.next();
    B.pres[i] = 1;
  }

  // ── beetle, ladybird, spider ──
  const soloGeo = soloGeometry(false);
  const soloShadowGeo = soloGeometry(true);
  const solo = new THREE.Mesh(soloGeo, creatureMat);
  solo.name = 'life-solo';
  solo.receiveShadow = true;
  const soloShadows = new THREE.Mesh(soloShadowGeo, shadowMat);
  soloShadows.name = 'life-solo-shadows';
  solo.onBeforeRender = frameUniforms;
  soloShadows.onBeforeRender = frameUniforms;

  const beetleSt = { u: BS.u, v: BS.v, th: rng.float(0, TAU), sp: 0, walk: true, timer: rng.float(2, 6), phase: 0, seed: rng.next(), pres: 1, speedJ: 1 };
  const spiderSt = { u: SS.u, v: SS.v, th: rng.float(0, TAU), sp: 0, mode: 0, timer: rng.float(1, 4), tu: SS.u, tv: SS.v, phase: 0, seed: rng.next(), pres: 1, runV: 0.19 };
  const ladySt = {
    p: new THREE.Vector3(),
    n: new THREE.Vector3(0, 1, 0),
    t1: new THREE.Vector3(1, 0, 0),
    t2: new THREE.Vector3(0, 0, 1),
    a: 0,
    b: 0,
    psi: rng.float(0, TAU),
    mode: 0,
    timer: rng.float(1, 4),
    turn: 0,
    sp: 0,
    phase: 0,
    amp: 0,
    seed: rng.next(),
    pres: 1,
    fallback: true,
  };
  const soloSphere = new THREE.Sphere();
  const updateSoloBounds = () => {
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    box.expandByPoint(p.set(wX(BS.u, BS.v), beetleGrid.height(BS.u, BS.v), wZ(BS.u, BS.v)));
    box.expandByPoint(p.set(wX(SS.u, SS.v), spiderGrid.height(SS.u, SS.v), wZ(SS.u, SS.v)));
    box.expandByPoint(ladySt.p);
    box.getBoundingSphere(soloSphere);
    soloSphere.radius += Math.max(SS.r, 0.06) + 0.03;
    soloGeo.boundingSphere = soloSphere.clone();
    soloShadowGeo.boundingSphere = soloSphere.clone();
  };
  const placeLady = (p, n) => {
    ladySt.p.copy(p);
    ladySt.n.copy(n).normalize();
    ladySt.t1.set(1, 0, 0);
    if (Math.abs(ladySt.n.x) > 0.9) ladySt.t1.set(0, 0, 1);
    ladySt.t1.addScaledVector(ladySt.n, -ladySt.t1.dot(ladySt.n)).normalize();
    ladySt.t2.crossVectors(ladySt.t1, ladySt.n);
    ladySt.a = 0;
    ladySt.b = 0;
    updateSoloBounds();
  };
  {
    const ls = SPOTS.ladybird;
    const x = wX(ls.u, ls.v);
    const z = wZ(ls.u, ls.v);
    placeLady(new THREE.Vector3(x, heroHeightAt(x, z) + 0.06, z), new THREE.Vector3(0, 1, 0));
  }

  // ── the mound ──
  const moundGeo = moundGeometry(tier, new RNG(9001));
  const mound = new THREE.Mesh(moundGeo, moundMaterial(holes));
  mound.name = 'life-mound';
  mound.castShadow = true;
  mound.receiveShadow = true;

  group.add(mound, ants, antShadows, solo, soloShadows);

  // ── winter: tracks in the snow (squirrel, tits) ──
  const tracks = buildTracks(ctx);
  group.add(tracks.mesh);

  // ── season state ──
  const act = { ants: 1, beetle: 1, lady: 1, spider: 1, speed: 1 };

  // ── stats ──
  const tris = (g) => g.index.count / 3;
  const antTris = tris(antGeo);
  const antShadowTris = tris(antShadowGeo);
  const soloTris = tris(soloGeo);
  const soloShadowTris = tris(soloShadowGeo);
  const moundTris = tris(moundGeo);
  const maxTriangles = antTris * nAll + antShadowTris * shadowCap + soloTris + soloShadowTris + moundTris;
  const stats = {
    tier,
    drawCalls: 5,
    triangles: maxTriangles,
    instances: nAll + 3,
    maxTriangles,
    ants: { trail: nTrail, mound: nMound, trisEach: antTris, shadowTrisEach: antShadowTris, shadowCap },
    soloTris,
    soloShadowTris,
    moundTris,
    visibleAnts: 0,
    shadowedAnts: 0,
  };

  // ── per-frame simulation ──
  const tmpN = new THREE.Vector3();

  function simTrail(dt, time) {
    const L = trail.L;
    const sk = act.speed;
    // presence follows the season; hidden ants (in the nest or at the far end) count down
    for (let i = 0; i < nTrail; i++) {
      A.pres[i] += ((A.rank[i] < act.ants ? 1 : 0) - A.pres[i]) * ease(dt, 3);
      A.cap[i] = 1;
      if (A.cool[i] > 0) A.cool[i] -= dt;
    }
    // neighbours along the trail (insertion sort keeps `order` sorted by s; it barely changes per frame)
    const O = A.order;
    for (let k = 1; k < nTrail; k++) {
      const id = O[k];
      const s = A.s[id];
      let j = k - 1;
      while (j >= 0 && A.s[O[j]] > s) {
        O[j + 1] = O[j];
        j--;
      }
      O[j + 1] = id;
    }
    for (let k = 0; k < nTrail; k++) {
      const i = O[k];
      if (A.hide[i] > 0 || A.pres[i] < 0.05) continue;
      for (let q = k + 1; q < nTrail; q++) {
        const j = O[q];
        const ds = A.s[j] - A.s[i];
        if (ds > 0.014) break;
        if (A.hide[j] > 0 || A.pres[j] < 0.05) continue;
        const dw = A.w[j] - A.w[i];
        const len = 0.0036 * (A.scale[i] + A.scale[j]); // centre distance at which two bodies touch end to end
        if (ds < len && Math.abs(dw) < 0.005) {
          // side by side: shoulder each other apart
          const side = dw === 0 ? (A.seed[i] > A.seed[j] ? 1 : -1) : Math.sign(dw);
          const k = 0.03 * dt * (1 - Math.abs(dw) / 0.005);
          A.pushT[i] = clamp(A.pushT[i] - side * k, -0.009, 0.009);
          A.pushT[j] = clamp(A.pushT[j] + side * k, -0.009, 0.009);
          // bodies that still touch are moved apart sideways at once (a fraction of a millimetre per frame)
          const dist = Math.hypot(ds, dw);
          const minD = 0.0018 * (A.scale[i] + A.scale[j]);
          if (dist < minD) {
            const corr = Math.sqrt(minD * minD - ds * ds) - Math.abs(dw);
            if (corr > 0) {
              A.push[i] -= side * corr * 0.5;
              A.push[j] += side * corr * 0.5;
              A.pushT[i] = clamp(A.pushT[i] - side * corr * 0.5, -0.009, 0.009);
              A.pushT[j] = clamp(A.pushT[j] + side * corr * 0.5, -0.009, 0.009);
            }
          }
        }
        if (A.dir[i] === A.dir[j]) {
          if (Math.abs(dw) > 0.0042) continue;
          // the one behind slows down and starts to sidestep
          const behind = A.dir[i] > 0 ? i : j;
          const side = dw === 0 ? (A.seed[behind] > 0.5 ? 1 : -1) : behind === i ? -Math.sign(dw) : Math.sign(dw);
          A.cap[behind] = Math.min(A.cap[behind], clamp((ds - len * 0.75) / (len * 0.6), 0, 1));
          A.pushT[behind] = clamp(A.pushT[behind] + side * 0.012 * dt, -0.008, 0.008);
        } else if (A.dir[i] > 0 && ds < 0.0075) {
          // two ants meet head on: a short antennal greeting, then they pass side by side
          if (Math.abs(dw) < 0.0045) {
            if (A.cool[i] <= 0 && A.cool[j] <= 0) {
              const tPause = rng.float(0.25, 0.7);
              A.pause[i] = Math.max(A.pause[i], tPause);
              A.pause[j] = Math.max(A.pause[j], tPause * rng.float(0.8, 1.2));
              A.cool[i] = A.cool[j] = 2.5;
            }
            const side = dw >= 0 ? 1 : -1;
            A.pushT[i] = clamp(A.pushT[i] - side * 0.003, -0.008, 0.008);
            A.pushT[j] = clamp(A.pushT[j] + side * 0.003, -0.008, 0.008);
          }
        }
      }
    }
    for (let i = 0; i < nTrail; i++) {
      if (A.hide[i] > 0) {
        A.hide[i] -= dt;
        if (A.hide[i] <= 0) {
          // wait in the entrance while another ant is right there
          for (let j = 0; j < nTrail; j++) {
            if (j !== i && A.hide[j] <= 0 && Math.abs(A.s[j] - A.s[i]) < 0.009) {
              A.hide[i] = rng.float(0.2, 0.5);
              break;
            }
          }
        }
        continue;
      }
      if (A.pause[i] > 0) A.pause[i] -= dt;
      else if ((A.nextPause[i] -= dt) <= 0) {
        A.pause[i] = rng.float(0.2, 1.1);
        A.nextPause[i] = rng.float(2.5, 13);
      }
      const jitter = 0.86 + 0.14 * Math.sin(time * 0.7 + A.seed[i] * 40);
      const target = A.pause[i] > 0 ? 0 : A.vBase[i] * sk * jitter * A.cap[i];
      A.v[i] += (target - A.v[i]) * ease(dt, 14);
      const step = A.v[i] * dt;
      A.s[i] += A.dir[i] * step;
      A.dist[i] += step;
      if (A.s[i] >= L) {
        // far end, out of frame: turn round for home, maybe with something
        A.s[i] = L;
        A.dir[i] = -1;
        A.carry[i] = pickCarry();
        A.hide[i] = rng.float(0.5, 3);
      } else if (A.s[i] <= 0) {
        // into the nest; out again a little later
        A.s[i] = 0;
        A.dir[i] = 1;
        A.carry[i] = rng.chance(0.04) ? 1 : 0;
        A.hide[i] = rng.float(2, 8);
      }
      A.push[i] += (A.pushT[i] - A.push[i]) * ease(dt, 8);
      A.pushT[i] *= Math.exp(-dt / 1.8);
      const d = A.dist[i];
      const wander = A.wa1[i] * Math.sin(A.wk1[i] * d + A.wp1[i]) + A.wa2[i] * Math.sin(A.wk2[i] * d + A.wp2[i]);
      const dwdd = A.wa1[i] * A.wk1[i] * Math.cos(A.wk1[i] * d + A.wp1[i]) + A.wa2[i] * A.wk2[i] * Math.cos(A.wk2[i] * d + A.wp2[i]);
      const lane = A.dir[i] * 0.003 * smoothstep(0, 0.15, A.s[i]);
      A.w[i] = clamp(lane + wander + A.push[i], -0.02, 0.02);
      if (A.v[i] > 0.002) A.slope[i] += (clamp(dwdd, -0.6, 0.6) - A.slope[i]) * ease(dt, 10);
      A.phase[i] = (A.phase[i] + (TAU * A.v[i] * dt) / (ANT_STRIDE * A.scale[i])) % TAU;
    }
  }

  // Keep the swarm from walking through itself: the ant that has another one ahead slows and turns away,
  // and bodies that still touch are eased apart.
  const MIN_D = 0.0036;
  const SEE_D = 0.0072;
  function avoid(i, du, dv, d, dt, other) {
    const c = Math.cos(B.th[i]);
    const s = Math.sin(B.th[i]);
    if (c * du + s * dv > 0) {
      B.cap[i] = Math.min(B.cap[i], clamp((d - MIN_D) / (SEE_D - MIN_D), 0, 1));
      B.th[i] = wrapAngle(B.th[i] - Math.sign(c * dv - s * du || 1) * 5 * dt);
    }
    if (d < MIN_D && d > 1e-9) {
      const k = (MIN_D - d) / d / (other ? 2 : 1);
      B.u[i] -= du * k;
      B.v[i] -= dv * k;
    }
  }

  function separateMound(dt) {
    let nObs = 0;
    for (let i = 0; i < nTrail; i++) {
      if (A.hide[i] > 0 || A.s[i] > 0.3 || A.pres[i] < 0.05) continue;
      trailUV(trail, A.s[i], A.w[i]);
      B.obsU[nObs] = TUV.u;
      B.obsV[nObs] = TUV.v;
      nObs++;
    }
    for (let i = 0; i < nMound; i++) B.cap[i] = 1;
    for (let i = 0; i < nMound; i++) {
      if (B.hide[i] > 0 || B.pres[i] < 0.05) continue;
      for (let j = i + 1; j < nMound; j++) {
        if (B.hide[j] > 0 || B.pres[j] < 0.05) continue;
        const du = B.u[j] - B.u[i];
        const dv = B.v[j] - B.v[i];
        if (Math.abs(du) > SEE_D || Math.abs(dv) > SEE_D) continue;
        const d = Math.hypot(du, dv);
        if (d > SEE_D) continue;
        // both use the separation before either moves, so each takes half of the overlap
        avoid(i, du, dv, d, dt, true);
        avoid(j, -du, -dv, d, dt, true);
      }
      for (let o = 0; o < nObs; o++) {
        const du = B.obsU[o] - B.u[i];
        const dv = B.obsV[o] - B.v[i];
        if (Math.abs(du) > SEE_D || Math.abs(dv) > SEE_D) continue;
        const d = Math.hypot(du, dv);
        if (d < SEE_D) avoid(i, du, dv, d, dt, false);
      }
    }
  }

  function simMound(dt, time) {
    const sk = act.speed;
    separateMound(dt);
    for (let i = 0; i < nMound; i++) {
      B.pres[i] += ((B.rank[i] < act.ants ? 1 : 0) - B.pres[i]) * ease(dt, 3);
      if (B.hide[i] > 0) {
        B.hide[i] -= dt;
        if (B.hide[i] <= 0) {
          // out of a random entrance, unless another ant is just there
          const h = holeUV[Math.floor(rng.next() * holeUV.length)];
          let busy = false;
          for (let j = 0; j < nMound && !busy; j++) busy = j !== i && B.hide[j] <= 0 && Math.abs(B.u[j] - h[0]) + Math.abs(B.v[j] - h[1]) < 0.006;
          if (busy) {
            B.hide[i] = rng.float(0.2, 0.6);
            continue;
          }
          B.u[i] = h[0];
          B.v[i] = h[1];
          B.th[i] = rng.float(0, TAU);
          B.goal[i] = -1;
          B.goalIn[i] = rng.float(4, 25);
          B.carry[i] = rng.chance(0.12) ? 1 : 0;
        }
        continue;
      }
      if (B.pause[i] > 0) B.pause[i] -= dt;
      else if ((B.nextPause[i] -= dt) <= 0) {
        B.pause[i] = rng.float(0.15, 0.9);
        B.nextPause[i] = rng.float(1, 7);
      }
      if (B.goal[i] < 0 && (B.goalIn[i] -= dt) <= 0) B.goal[i] = Math.floor(rng.next() * holeUV.length);
      // a busy, wiggling random walk; steer home when leaving the visible flank or heading for a hole
      const sd = B.seed[i] * 50;
      let turn = 2.4 * Math.sin(time * 1.9 + sd) + 1.5 * Math.sin(time * 4.3 + sd * 1.7);
      let goalU = 0;
      let goalV = 0;
      let steer = 0;
      if (B.goal[i] >= 0) {
        goalU = holeUV[B.goal[i]][0];
        goalV = holeUV[B.goal[i]][1];
        steer = 5;
      } else if (!inMoundRegion(B.u[i], B.v[i])) {
        goalU = MU.u + 0.2;
        goalV = MU.v + 0.2;
        steer = 6;
      }
      if (steer > 0) {
        const want = Math.atan2(goalV - B.v[i], goalU - B.u[i]);
        turn = turn * 0.3 + wrapAngle(want - B.th[i]) * steer;
      }
      const target = B.pause[i] > 0 ? 0 : B.vBase[i] * sk * B.cap[i];
      B.sp[i] += (target - B.sp[i]) * ease(dt, 12);
      B.th[i] = wrapAngle(B.th[i] + turn * dt * Math.min(1, B.sp[i] / 0.01 + 0.2));
      B.u[i] += Math.cos(B.th[i]) * B.sp[i] * dt;
      B.v[i] += Math.sin(B.th[i]) * B.sp[i] * dt;
      if (B.goal[i] >= 0) {
        const h = holeUV[B.goal[i]];
        if (Math.hypot(h[0] - B.u[i], h[1] - B.v[i]) < 0.004) B.hide[i] = rng.float(1, 5);
      }
      B.phase[i] = (B.phase[i] + (TAU * B.sp[i] * dt) / (ANT_STRIDE * B.scale[i])) % TAU;
    }
  }

  function simBeetle(dt, time) {
    const b = beetleSt;
    b.pres += ((act.beetle > 0.45 ? 1 : 0) - b.pres) * ease(dt, 3);
    b.timer -= dt;
    if (b.timer <= 0) {
      b.walk = !b.walk;
      b.timer = b.walk ? rng.float(3, 9) : rng.float(1.5, 4.5);
      b.speedJ = rng.float(0.8, 1.2);
    }
    const target = b.walk ? LIFE.beetleSpeed * b.speedJ * (0.6 + 0.4 * act.speed) : 0;
    b.sp += (target - b.sp) * ease(dt, 3);
    let turn = (0.55 * Math.sin(time * 0.41 + 1.0) + 0.35 * Math.sin(time * 1.07 + 2.0)) * (b.walk ? 1 : 0.15);
    const du = BS.u - b.u;
    const dv = BS.v - b.v;
    const dc = Math.hypot(du, dv);
    if (dc > 0.02) turn += wrapAngle(Math.atan2(dv, du) - b.th) * 1.8 * smoothstep(0.02, 0.036, dc);
    b.th = wrapAngle(b.th + turn * dt);
    b.u += Math.cos(b.th) * b.sp * dt;
    b.v += Math.sin(b.th) * b.sp * dt;
    b.phase = (b.phase + (TAU * b.sp * dt) / BEETLE_STRIDE) % TAU;
  }

  function simSpider(dt) {
    const s = spiderSt;
    s.pres += ((act.spider > 0.45 ? 1 : 0) - s.pres) * ease(dt, 3);
    s.timer -= dt;
    if (s.mode === 0 && s.timer <= 0) {
      // pick somewhere to dart to, 4–12 cm away inside the hunting ground
      for (let k = 0; k < 8; k++) {
        const a = rng.float(0, TAU);
        const r = rng.float(0.04, 0.12);
        const tu = s.u + Math.cos(a) * r;
        const tv = s.v + Math.sin(a) * r;
        if (Math.hypot(tu - SS.u, tv - SS.v) < SS.r) {
          s.tu = tu;
          s.tv = tv;
          s.mode = 1;
          s.timer = 0.18;
          s.runV = rng.float(LIFE.spiderSpeed[0], LIFE.spiderSpeed[1]);
          break;
        }
      }
      if (s.mode === 0) s.timer = 0.5;
    }
    const want = Math.atan2(s.tv - s.v, s.tu - s.u);
    const dist = Math.hypot(s.tu - s.u, s.tv - s.v);
    if (s.mode === 1) {
      // quick turn toward the target
      s.th = wrapAngle(s.th + wrapAngle(want - s.th) * ease(dt, 22));
      s.sp += (0.01 - s.sp) * ease(dt, 10);
      if (s.timer <= 0) s.mode = 2;
    } else if (s.mode === 2) {
      s.th = wrapAngle(s.th + wrapAngle(want - s.th) * ease(dt, 8));
      const target = s.runV * smoothstep(0.0, 0.025, dist) * (0.7 + 0.3 * act.speed);
      s.sp += (target - s.sp) * ease(dt, 18);
      if (dist < 0.003) {
        s.mode = 0;
        s.timer = rng.float(1.5, 6.5);
      }
    } else {
      s.sp += (0 - s.sp) * ease(dt, 20);
    }
    const step = Math.min(s.sp * dt, dist);
    s.u += Math.cos(s.th) * step;
    s.v += Math.sin(s.th) * step;
    s.phase = (s.phase + TAU * Math.min(12, s.sp / SPIDER_STRIDE) * dt) % TAU;
  }

  function simLady(dt) {
    const l = ladySt;
    l.pres += ((act.lady > 0.45 ? 1 : 0) - l.pres) * ease(dt, 3);
    l.timer -= dt;
    if (l.timer <= 0) {
      if (l.mode !== 0) {
        l.mode = 0;
        l.timer = rng.float(2, 7);
      } else {
        // walk a few millimetres if there is leaf ahead, otherwise turn on the spot
        const ahead = Math.hypot(l.a + Math.cos(l.psi) * 0.003, l.b + Math.sin(l.psi) * 0.003);
        if (ahead < 0.0028 && rng.chance(0.6)) {
          l.mode = 1;
          l.timer = rng.float(0.4, 1.2);
        } else {
          l.mode = 2;
          l.timer = rng.float(0.4, 1.0);
          l.turn = rng.sign() * rng.float(1.0, 1.8);
        }
      }
    }
    const target = l.mode === 1 ? 0.0035 : 0;
    l.sp += (target - l.sp) * ease(dt, 8);
    if (l.mode === 2) l.psi = wrapAngle(l.psi + l.turn * dt);
    l.a += Math.cos(l.psi) * l.sp * dt;
    l.b += Math.sin(l.psi) * l.sp * dt;
    const r = Math.hypot(l.a, l.b);
    if (r > 0.003) {
      l.a *= 0.003 / r;
      l.b *= 0.003 / r;
    }
    const f = l.mode === 2 ? 1.4 : l.sp / LADY_STRIDE;
    l.amp += ((l.mode === 0 ? 0 : l.mode === 2 ? 0.7 : smoothstep(0.0003, 0.002, l.sp)) - l.amp) * ease(dt, 6);
    l.phase = (l.phase + TAU * f * dt) % TAU;
  }

  // ── writing the instances ──
  // Ants near the camera fill the slots from the front (they get shadows), the rest from the back;
  // the back block is then moved down so the instances stay contiguous.
  const camP = new THREE.Vector3();
  const arr = ants.instanceMatrix.array;
  const G = gaitAttr.array;
  let nNear = 0;
  let nFar = 0;
  const put = (x, y, z, fx, fy, fz, nx, ny, nz, s, ph, amp, carry, seed) => {
    const dx = x - camP.x;
    const dy = y - camP.y;
    const dz = z - camP.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > LIFE.hideBeyond * LIFE.hideBeyond) return;
    const slot = d2 < LIFE.shadowFade * LIFE.shadowFade && nNear < shadowCap ? nNear++ : nAll - 1 - nFar++;
    writeMatrix(arr, slot * 16, x, y, z, fx, fy, fz, nx, ny, nz, s);
    G[slot * 4] = ph;
    G[slot * 4 + 1] = amp;
    G[slot * 4 + 2] = carry;
    G[slot * 4 + 3] = seed;
  };
  function writeAnts() {
    nNear = 0;
    nFar = 0;
    for (let i = 0; i < nTrail; i++) {
      if (A.hide[i] > 0 || A.pres[i] < 0.02) continue;
      trailFrame(trail, A.s[i], A.w[i]);
      const dir = A.dir[i];
      const fx = dir * F.tx + F.lx * A.slope[i];
      const fz = dir * F.tz + F.lz * A.slope[i];
      put(F.x, F.y, F.z, fx, 0, fz, F.nx, F.ny, F.nz, A.scale[i] * A.pres[i], A.phase[i], smoothstep(0.002, 0.012, A.v[i]), A.carry[i], A.seed[i]);
    }
    for (let i = 0; i < nMound; i++) {
      if (B.hide[i] > 0 || B.pres[i] < 0.02) continue;
      const u = B.u[i];
      const v = B.v[i];
      moundGrid.normal(u, v, tmpN);
      const c = Math.cos(B.th[i]);
      const s = Math.sin(B.th[i]);
      put(wX(u, v), moundGrid.height(u, v), wZ(u, v), PU.x * c + PV.x * s, 0, PU.y * c + PV.y * s, tmpN.x, tmpN.y, tmpN.z, B.scale[i] * B.pres[i], B.phase[i], smoothstep(0.002, 0.012, B.sp[i]), B.carry[i], B.seed[i]);
    }
    if (nFar > 0 && nNear + nFar < nAll) {
      arr.copyWithin(nNear * 16, (nAll - nFar) * 16, nAll * 16);
      G.copyWithin(nNear * 4, (nAll - nFar) * 4, nAll * 4);
    }
    ants.count = nNear + nFar;
    antShadows.count = nNear;
    ants.instanceMatrix.needsUpdate = true;
    gaitAttr.needsUpdate = true;
    stats.visibleAnts = ants.count;
    stats.shadowedAnts = nNear;
  }

  const soloOut = (k, x, y, z, fx, fy, fz, nx, ny, nz, s, ph, amp, seed) => {
    const e = U.uSolo.value[k].elements;
    const dx = x - camP.x;
    const dy = y - camP.y;
    const dz = z - camP.z;
    if (s < 0.02 || dx * dx + dy * dy + dz * dz > LIFE.hideBeyond * LIFE.hideBeyond) {
      e.fill(0);
      return false;
    }
    writeMatrix(e, 0, x, y, z, fx, fy, fz, nx, ny, nz, s);
    U.uSoloGait.value[k].set(ph, amp, 0, seed);
    return true;
  };

  function writeSolo() {
    let any = false;
    const b = beetleSt;
    beetleGrid.normal(b.u, b.v, tmpN, 0.008);
    let c = Math.cos(b.th);
    let s = Math.sin(b.th);
    any = soloOut(0, wX(b.u, b.v), beetleGrid.height(b.u, b.v), wZ(b.u, b.v), PU.x * c + PV.x * s, 0, PU.y * c + PV.y * s, tmpN.x, tmpN.y, tmpN.z, b.pres, b.phase, smoothstep(0.0005, 0.004, b.sp), b.seed) || any;
    const l = ladySt;
    c = Math.cos(l.psi);
    s = Math.sin(l.psi);
    const lx = l.p.x + l.t1.x * l.a + l.t2.x * l.b + l.n.x * 0.0001;
    const ly = l.p.y + l.t1.y * l.a + l.t2.y * l.b + l.n.y * 0.0001;
    const lz = l.p.z + l.t1.z * l.a + l.t2.z * l.b + l.n.z * 0.0001;
    any = soloOut(1, lx, ly, lz, l.t1.x * c + l.t2.x * s, l.t1.y * c + l.t2.y * s, l.t1.z * c + l.t2.z * s, l.n.x, l.n.y, l.n.z, l.pres, l.phase, l.amp, l.seed) || any;
    const sp = spiderSt;
    spiderGrid.normal(sp.u, sp.v, tmpN, 0.006);
    c = Math.cos(sp.th);
    s = Math.sin(sp.th);
    any = soloOut(2, wX(sp.u, sp.v), spiderGrid.height(sp.u, sp.v), wZ(sp.u, sp.v), PU.x * c + PV.x * s, 0, PU.y * c + PV.y * s, tmpN.x, tmpN.y, tmpN.z, sp.pres, sp.phase, smoothstep(0.001, 0.01, sp.sp), sp.seed) || any;
    return any;
  }

  return {
    group,
    stats,
    update(dt, time, state = {}) {
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      const cam = state.camera ?? ctx.camera;
      const near = state.near ?? 1;
      // the tracks tell the winter story, when every creature is asleep
      tracks.update(dt, time, state);
      stats.tracks = tracks.stats.drawCalls;
      const awake = act.ants > 0.001 || act.beetle > 0.001 || act.lady > 0.001 || act.spider > 0.001;
      const show = near > 0.001 && awake;
      ants.visible = antShadows.visible = solo.visible = soloShadows.visible = show;
      if (!show) {
        ants.count = antShadows.count = 0;
        stats.drawCalls = 1 + tracks.stats.drawCalls;
        stats.triangles = moundTris + tracks.stats.triangles;
        stats.instances = 0;
        stats.visibleAnts = stats.shadowedAnts = 0;
        return;
      }
      if (cam) camP.copy(cam.position);
      simTrail(dt, time);
      simMound(dt, time);
      simBeetle(dt, time);
      simSpider(dt);
      simLady(dt);
      writeAnts();
      const anySolo = writeSolo();
      solo.visible = soloShadows.visible = anySolo;
      ants.visible = ants.count > 0;
      antShadows.visible = antShadows.count > 0;
      stats.drawCalls = 1 + (ants.visible ? 1 : 0) + (antShadows.visible ? 1 : 0) + (anySolo ? 2 : 0) + tracks.stats.drawCalls;
      stats.triangles = moundTris + ants.count * antTris + antShadows.count * antShadowTris + (anySolo ? soloTris + soloShadowTris : 0) + tracks.stats.triangles;
      stats.instances = ants.count + (anySolo ? 3 : 0);
    },
    applySeason(sp, v) {
      const ph = phenology(v ?? 1.5);
      const snowK = 1 - smoothstep(0.15, 0.3, sp?.snow ?? 0);
      // cool spring and autumn mornings make for slow ants
      const warm = 0.5 + 0.5 * Math.cos(((ph.month - 7.2) / 12) * TAU);
      act.speed = 0.35 + 0.65 * smoothstep(0.2, 0.85, warm);
      act.ants = ph.ants * snowK;
      act.beetle = ph.beetles * snowK;
      // ladybirds wake in April and go into hibernation by the end of September
      act.lady = smoothstep(0.15, 0.6, ph.ants) * (1 - smoothstep(9.3, 9.9, ph.month)) * snowK;
      act.spider = smoothstep(0.2, 0.7, ph.beetles) * snowK;
      if (sp && sp.hemiSky) {
        const k = 0.5 * LIFE.env;
        U.uEnvSky.value.set(sp.hemiSky[0], sp.hemiSky[1], sp.hemiSky[2]).multiplyScalar(sp.hemiI * k);
        U.uEnvGround.value.set(sp.hemiGround[0], sp.hemiGround[1], sp.hemiGround[2]).multiplyScalar(sp.hemiI * k);
        U.uEnvSun.value.set(sp.sun[0], sp.sun[1], sp.sun[2]).multiplyScalar(sp.sunI * 0.05 * LIFE.env);
        // the shadow removes the sun's share of the light on the ground
        const eSun = sp.sunI * SUN_DIR.y;
        const eSky = sp.hemiI * 0.55;
        SU.uShadowK.value = clamp((eSun / (eSun + eSky)) * 0.82, 0, 0.72) * LIFE.shadowK;
      }
      tracks.applySeason(sp, v);
    },
    /** fn(x, z, snow) → world y of the snow's top; the track decals follow it (see tracks.js snowTopAt). */
    setSnowTop(fn) {
      tracks.setSnowTop(fn);
    },
    setPerches(perches) {
      const ls = SPOTS.ladybird;
      const tx = wX(ls.u, ls.v);
      const tz = wZ(ls.u, ls.v);
      let best = null;
      let bd = Infinity;
      for (const pr of perches ?? []) {
        if (!pr || !pr.p || !pr.n) continue;
        const ny = pr.n.y / (Math.hypot(pr.n.x, pr.n.y, pr.n.z) || 1);
        if (ny < 0.55) continue; // the ladybird sits on top, where we can see it
        const d = Math.hypot(pr.p.x - tx, pr.p.z - tz);
        if (d < bd) {
          bd = d;
          best = pr;
        }
      }
      if (best) {
        placeLady(best.p, best.n);
        ladySt.fallback = false;
      }
    },
    // for tests and tuning
    debug: { trail, A, B, beetle: beetleSt, spider: spiderSt, lady: ladySt, act, holes, moundGrid, ants, antShadows, solo, U, SU, tracks },
  };
}
