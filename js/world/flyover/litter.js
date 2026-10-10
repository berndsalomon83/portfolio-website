import * as THREE from 'three';
import { RNG, noise2, smoothstep, clamp } from '../../lib/random.js';
import { MeshData, addStrip } from '../../lib/geometry.js';
import { shared, injectSeason, injectFoliage } from '../../gl/patches.js';
import { PATCH, SPOTS, ANT_TRAIL, heroHeightAt, clearOfOthers, phenology } from './config.js';

// Forest litter for the flyover close-up: what lies on a Swedish pine-heath floor at macro scale.
// Scots pine needle pairs drifting into the hollows, a scatter of spruce needles, pine cones with their
// rhomboid apophyses, a spruce cone, cores and scales left by a red squirrel, dead twigs, a fallen pine
// twig hung with beard lichen and Hypogymnia rosettes, papery bark flakes, birch leaves and granite grit.
// Everything rests on heroHeightAt, or where the moss module grows its carpet, in and on the moss (REST).
//
// Everything is merged into six meshes (six draw calls, three of them shadow casters):
//   fine      needles + grit                 (only while the camera is near)
//   woodNear  bark flakes, squirrel scales, seed wings, needles still on the hero twig (near only)
//   wood      cones, twigs, cores, the hero twig and its Hypogymnia rosettes
//   leaves    birch leaves (alpha-tested atlas; fresh ones appear in autumn)
//   lichen    beard-lichen ribbons (foliage.lichen texture)
//   decal     soft contact darkening under cones and twigs
// The geometry builder is pure (no DOM, no GPU), so tests can run it in Node: see buildLitterGeometry().

// The moss module's carpet stands up to ~4 cm above the floor; litter rests in and on it. Guarded: without
// moss.js (or with an older one) everything lies on heroHeightAt and the corridor uses ANT_TRAIL alone.
let MOSS_API = null;
try {
  MOSS_API = await import('./moss.js');
} catch {
  MOSS_API = null;
}
const mossTopAt = typeof MOSS_API?.mossTopAt === 'function' ? MOSS_API.mossTopAt : null;
const mossTierOf = typeof MOSS_API?.mossTier === 'function' ? MOSS_API.mossTier : null;
const mossTrailDist = typeof MOSS_API?.antTrailDist === 'function' ? MOSS_API.antTrailDist : null;

// ── tuning knobs (counts are at quality.plants = 1; every tier scales them) ──
export const LITTER = {
  pinePairs: 6800, // Scots pine needle fascicles (plus singles and broken ones)
  spruceNeedles: 1500,
  grit: 140, // granite pebbles 3–15 mm
  cones: 16, // scattered Scots pine cones besides the hero cone
  twigs: 34, // small dead twigs, 5–25 cm
  flakes: 12, // scattered bark flakes besides the hero cluster
  oldLeaves: 14, // last year's birch leaves: dark, rotting to skeletons through spring and summer
  freshLeaves: 230, // newly fallen yellow leaves, autumn only
  pileScales: 140, // spruce-cone scales the squirrel left
  usnea: 9, // beard-lichen tufts on the hero twig
  bryoria: 4,
  rosettes: 4, // Hypogymnia physodes rosettes on the hero twig
  contactShadow: 1, // strength of the soft darkening under cones and twigs (scaled down when SSAO runs)
  wetGloss: 0.6, // how much dew lowers roughness
  farHide: 20, // metres: beyond this the whole litter group is hidden
};

// How far up the moss carpet each kind of litter comes to rest (fraction of the carpet's height above the
// floor): light needles and leaves lie among the top shoots, cones and twigs sink in deeper.
export const REST = { needle: 0.96, leaf: 1.0, oldLeaf: 0.75, flake: 0.97, scale: 0.96, cone: 0.7, core: 0.95, twig: 0.85, grit: 0 };

// The squirrel's dining spot (patch frame). Clear of every other module's spot by > 0.13 m.
export const SQUIRREL = { u: -0.28, v: 0.44, r: 0.11 };

const TAU = Math.PI * 2;
const GA = Math.PI * (3 - Math.sqrt(5)); // golden angle: the spiral that orders cone scales

// ── colour helpers (palettes are written as sRGB bytes, stored linear) ──
const s2l = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const lin = (r, g, b) => [s2l(r), s2l(g), s2l(b)];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vary = (rng, c, v = 0.08, hue = 0.04) => {
  const k = 1 + rng.float(-v, v);
  return [c[0] * k * (1 + rng.float(-hue, hue)), c[1] * k * (1 + rng.float(-hue, hue)), c[2] * k * (1 + rng.float(-hue, hue))];
};
const WHITE = [1, 1, 1];

const PAL = {
  needle: {
    fresh: [lin(176, 104, 50), lin(188, 122, 62), lin(164, 94, 44)],
    tan: [lin(148, 100, 62), lin(138, 94, 58), lin(158, 112, 74)],
    grey: [lin(124, 106, 88), lin(112, 98, 82), lin(134, 116, 96)],
    dark: [lin(78, 60, 44), lin(64, 50, 38), lin(90, 66, 46)],
    bleached: [lin(160, 146, 126), lin(150, 138, 120)],
  },
  sheath: lin(74, 58, 46),
  sheathEdge: lin(150, 132, 112),
  spruce: [lin(170, 98, 50), lin(146, 82, 46), lin(122, 102, 82), lin(86, 66, 50)],
  apoBrown: lin(118, 86, 58),
  apoGrey: lin(110, 102, 93),
  plateTop: lin(168, 116, 70),
  plateBot: lin(108, 74, 50),
  coneCore: lin(66, 48, 34),
  peduncle: lin(96, 80, 66),
  sprOut: lin(170, 124, 80),
  sprTip: lin(192, 152, 106),
  sprBase: lin(104, 70, 44),
  gnawed: lin(198, 158, 110),
  gnawedOld: lin(146, 110, 76),
  bark: {
    pine: lin(124, 104, 88),
    pineOrange: lin(168, 108, 70),
    spruce: lin(116, 102, 90),
    birch: lin(92, 58, 48),
    grey: lin(152, 146, 136),
  },
  woodEnd: lin(196, 166, 124),
  flakeOuter: lin(176, 104, 62), // fox-red papery bark of the upper trunk, weathered
  flakeGrey: lin(128, 108, 92),
  flakeInner: lin(204, 122, 70),
  chunkTop: lin(112, 96, 84),
  chunkSide: lin(152, 86, 56),
  leafFresh: [lin(226, 182, 48), lin(214, 156, 36), lin(198, 132, 34), lin(190, 176, 70), lin(206, 168, 62)],
  leafOld: [lin(86, 64, 46), lin(74, 58, 44), lin(98, 78, 58)], // last year's: dark grey-brown, half rotted
  leafSkeleton: lin(134, 114, 86),
  hypoTop: lin(168, 178, 164),
  hypoTip: lin(150, 140, 112),
  hypoSoralia: lin(212, 214, 204),
  hypoDark: lin(42, 38, 34),
  seedWing: lin(186, 146, 104),
};

// ── patch frame, inlined for the hot loops ──
const PCX = PATCH.center.x;
const PCZ = PATCH.center.y;
const PUX = PATCH.u.x;
const PUZ = PATCH.u.y;
const PVX = PATCH.v.x;
const PVZ = PATCH.v.y;
const toU = (x, z) => (x - PCX) * PUX + (z - PCZ) * PUZ;
const toV = (x, z) => (x - PCX) * PVX + (z - PCZ) * PVZ;
const wX = (u, v) => PCX + PUX * u + PVX * v;
const wZ = (u, v) => PCZ + PUZ * u + PVZ * v;
const fadeUV = (u, v) => smoothstep(0, PATCH.fade, Math.min(PATCH.halfL - Math.abs(u), PATCH.halfW - Math.abs(v)));
// heading in world xz of a patch-frame direction angle (0 = +u)
const headingOf = (pa) => Math.atan2(PUZ * Math.cos(pa) + PVZ * Math.sin(pa), PUX * Math.cos(pa) + PVX * Math.sin(pa));

// ── who else grows where ──
// the life module's wolf-spider spot (guarded: older contracts lack it)
const EXTRA = SPOTS.spider ? [] : [{ u: 0.35, v: -0.42, r: 0.1, owner: 'life' }];
const OTHERS = [...Object.values(SPOTS), ...EXTRA].filter((s) => s.owner !== 'litter' && !(s.shares && s.shares.includes('litter')));
const HARD = OTHERS.filter((s) => s.owner !== 'moss'); // plants, life
const MOSSY = OTHERS.filter((s) => s.owner === 'moss'); // reindeer lichen, haircap moss: needles and leaves may lie there
const MINE = [...Object.values(SPOTS).filter((s) => s.owner === 'litter'), SQUIRREL];
const dist2 = (a, b) => Math.sqrt(a * a + b * b); // Math.hypot is slow in V8's hot loops
const clearHard = (u, v) => {
  let best = Infinity;
  for (const s of HARD) best = Math.min(best, dist2(u - s.u, v - s.v) - s.r);
  return best;
};
const inMoss = (u, v) => MOSSY.some((s) => dist2(u - s.u, v - s.v) < s.r);
const clearMine = (u, v) => {
  let best = Infinity;
  for (const s of MINE) best = Math.min(best, dist2(u - s.u, v - s.v) - s.r);
  return best;
};
// clearOfOthers plus the guarded extra spots
const clearOthers = (u, v) => {
  let best = clearOfOthers(u, v, 'litter');
  for (const s of EXTRA) best = Math.min(best, dist2(u - s.u, v - s.v) - s.r);
  return best;
};

function segDist(u, v, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [au, av] = pts[i];
    const [bu, bv] = pts[i + 1];
    const du = bu - au;
    const dv = bv - av;
    const t = clamp(((u - au) * du + (v - av) * dv) / (du * du + dv * dv));
    best = Math.min(best, dist2(au + du * t - u, av + dv * t - v));
  }
  return best;
}

// The ants walk a smooth curve through ANT_TRAIL. Not knowing which spline the life module draws,
// the corridor is the union of the polyline and both Catmull-Rom variants (uniform and centripetal).
const TRAIL_CURVES = ['catmullrom', 'centripetal'].map((type) =>
  new THREE.CatmullRomCurve3(ANT_TRAIL.map(([u, v]) => new THREE.Vector3(u, 0, v)), false, type, 0.5).getSpacedPoints(240).map((p) => [p.x, p.z]),
);
// distance to the nearest of the three lines, baked on a 1 cm grid (capped at 12 cm) on first use
const TG = { h: 0.01, far: 0.12, d: null };
function buildTrailGrid() {
  const m = 0.05;
  TG.u0 = -PATCH.halfL - m;
  TG.v0 = -PATCH.halfW - m;
  TG.nu = Math.ceil((2 * (PATCH.halfL + m)) / TG.h) + 1;
  TG.nv = Math.ceil((2 * (PATCH.halfW + m)) / TG.h) + 1;
  const d = new Float32Array(TG.nu * TG.nv).fill(TG.far);
  const r = Math.ceil(TG.far / TG.h) + 1;
  for (const pts of [ANT_TRAIL, ...TRAIL_CURVES]) {
    for (let k = 0; k < pts.length - 1; k++) {
      const [au, av] = pts[k];
      const [bu, bv] = pts[k + 1];
      const du = bu - au;
      const dv = bv - av;
      const l2 = du * du + dv * dv || 1e-12;
      const i0 = Math.floor((Math.min(au, bu) - TG.u0) / TG.h) - r;
      const i1 = Math.ceil((Math.max(au, bu) - TG.u0) / TG.h) + r;
      const j0 = Math.floor((Math.min(av, bv) - TG.v0) / TG.h) - r;
      const j1 = Math.ceil((Math.max(av, bv) - TG.v0) / TG.h) + r;
      const jE = Math.min(TG.nv - 1, j1);
      const iE = Math.min(TG.nu - 1, i1);
      for (let j = Math.max(0, j0); j <= jE; j++) {
        const v = TG.v0 + j * TG.h;
        for (let i = Math.max(0, i0); i <= iE; i++) {
          const u = TG.u0 + i * TG.h;
          let t = ((u - au) * du + (v - av) * dv) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = au + du * t - u;
          const ey = av + dv * t - v;
          const dd = Math.sqrt(ex * ex + ey * ey);
          if (dd < d[j * TG.nu + i]) d[j * TG.nu + i] = dd;
        }
      }
    }
  }
  TG.d = d;
}
function distToTrail(u, v) {
  if (!TG.d) buildTrailGrid();
  const fu = (u - TG.u0) / TG.h;
  const fv = (v - TG.v0) / TG.h;
  if (fu < 0 || fv < 0 || fu >= TG.nu - 1 || fv >= TG.nv - 1) return segDist(u, v, ANT_TRAIL);
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  const a = fu - i;
  const b = fv - j;
  const k = j * TG.nu + i;
  const d = TG.d;
  // exact on the straight parts; at the corridor edge (2 cm out) the bilinear error stays below a millimetre
  return (d[k] * (1 - a) + d[k + 1] * a) * (1 - b) + (d[k + TG.nu] * (1 - a) + d[k + TG.nu + 1] * a) * b;
}
export const ANT_CORRIDOR = 0.02; // half-width (m) kept free of cones, twigs, flakes, pebbles and leaves
const offTrail = (u, v, r) => Math.min(distToTrail(u, v), mossTrailDist ? mossTrailDist(u, v) : Infinity) > ANT_CORRIDOR + r;

// ═════════════════════════════════════════════════════════════
// Geometry containers
// ═════════════════════════════════════════════════════════════

// Vertex soup for one merged mesh: position, normal, colour (linear), uv and one or two "extra" floats
// (aBury: visible while it is above the snow/LOD threshold; aLeaf: fresh-leaf key + bury threshold).
class Geo {
  constructor(extra = 1) {
    this.extra = extra;
    this.p = [];
    this.n = [];
    this.c = [];
    this.t = [];
    this.e = [];
    this.i = [];
    this.items = [];
    this.cur = null;
    // per piece, for the floor's snow field: anchor u, v (patch frame), top above heroHeightAt, rests up on
    // the moss (0/1); per vertex: height above heroHeightAt. Filled by siteFn / hvFn when a piece ends.
    this.site = [];
    this.hv = [];
    this.siteFn = null;
    this.hvFn = null;
    this.siteDone = 0;
  }

  get count() {
    return this.p.length / 3;
  }

  get triangles() {
    return this.i.length / 3;
  }

  // e0 may also be an array holding all extra channels ([appear, cover, snow noise, cap] for winter litter)
  v(x, y, z, nx, ny, nz, c, u, w, e0 = 1, e1 = 0, e2 = 0, e3 = 0) {
    if (typeof e0 === 'object') {
      e3 = e0[3] ?? 0;
      e2 = e0[2] ?? 0;
      e1 = e0[1] ?? 0;
      e0 = e0[0];
    }
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(c[0], c[1], c[2]);
    this.t.push(u, w);
    this.e.push(e0);
    if (this.extra > 1) this.e.push(e1);
    if (this.extra > 2) this.e.push(e2);
    if (this.extra > 3) this.e.push(e3);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) {
    this.i.push(a, b, c);
  }

  // Triangle wound so its face normal points along (dx, dy, dz).
  triF(a, b, c, dx, dy, dz) {
    const p = this.p;
    const ax = p[3 * a];
    const ay = p[3 * a + 1];
    const az = p[3 * a + 2];
    const ux = p[3 * b] - ax;
    const uy = p[3 * b + 1] - ay;
    const uz = p[3 * b + 2] - az;
    const vx = p[3 * c] - ax;
    const vy = p[3 * c + 1] - ay;
    const vz = p[3 * c + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * dx + ny * dy + nz * dz < 0) this.i.push(a, c, b);
    else this.i.push(a, b, c);
  }

  begin(cat, extra = {}) {
    this.cur = { cat, v0: this.count, i0: this.i.length, ...extra };
  }

  end() {
    const it = this.cur;
    it.v1 = this.count;
    it.i1 = this.i.length;
    this.items.push(it);
    this.cur = null;
    if (this.siteFn) {
      it.site = this.siteFn(this, it);
      for (let k = this.siteDone; k < this.count; k++) {
        this.site.push(it.site[0], it.site[1], it.site[2], it.site[3]);
        if (this.hvFn) this.hv.push(this.hvFn(this.p[3 * k], this.p[3 * k + 1], this.p[3 * k + 2]));
      }
      this.siteDone = this.count;
    }
    return it;
  }

  // Area-weighted smooth normals for vertices [v0, v1) from triangles [i0, i1).
  smoothNormals(v0 = 0, v1 = this.count, i0 = 0, i1 = this.i.length) {
    const p = this.p;
    const n = this.n;
    for (let k = v0 * 3; k < v1 * 3; k++) n[k] = 0;
    for (let k = i0; k < i1; k += 3) {
      const a = this.i[k];
      const b = this.i[k + 1];
      const c = this.i[k + 2];
      const ux = p[3 * b] - p[3 * a];
      const uy = p[3 * b + 1] - p[3 * a + 1];
      const uz = p[3 * b + 2] - p[3 * a + 2];
      const vx = p[3 * c] - p[3 * a];
      const vy = p[3 * c + 1] - p[3 * a + 1];
      const vz = p[3 * c + 2] - p[3 * a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) {
        if (q < v0 || q >= v1) continue;
        n[3 * q] += nx;
        n[3 * q + 1] += ny;
        n[3 * q + 2] += nz;
      }
    }
    for (let q = v0; q < v1; q++) {
      const l = Math.hypot(n[3 * q], n[3 * q + 1], n[3 * q + 2]) || 1;
      n[3 * q] /= l;
      n[3 * q + 1] /= l;
      n[3 * q + 2] /= l;
    }
  }

  // Append another Geo, rotated by the 3×3 part of `m` (Matrix4 elements) and moved by (tx, ty, tz).
  // `colFn(col, wx, wy, wz)` may darken colours (contact AO); `bury` overrides the extra channel.
  append(src, m, tx, ty, tz, { colFn = null, bury = null } = {}) {
    const base = this.count;
    const e = m;
    for (let k = 0; k < src.count; k++) {
      const px = src.p[3 * k];
      const py = src.p[3 * k + 1];
      const pz = src.p[3 * k + 2];
      const nx = src.n[3 * k];
      const ny = src.n[3 * k + 1];
      const nz = src.n[3 * k + 2];
      const x = e[0] * px + e[4] * py + e[8] * pz + tx;
      const y = e[1] * px + e[5] * py + e[9] * pz + ty;
      const z = e[2] * px + e[6] * py + e[10] * pz + tz;
      let c = [src.c[3 * k], src.c[3 * k + 1], src.c[3 * k + 2]];
      if (colFn) c = colFn(c, x, y, z);
      this.v(
        x,
        y,
        z,
        e[0] * nx + e[4] * ny + e[8] * nz,
        e[1] * nx + e[5] * ny + e[9] * nz,
        e[2] * nx + e[6] * ny + e[10] * nz,
        c,
        src.t[2 * k],
        src.t[2 * k + 1],
        bury ?? src.e[src.extra * k],
        src.extra > 1 ? src.e[src.extra * k + 1] : 0,
        src.extra > 2 ? src.e[src.extra * k + 2] : 0,
        src.extra > 3 ? src.e[src.extra * k + 3] : 0,
      );
    }
    for (const q of src.i) this.i.push(q + base);
  }

  build(extraName = 'aBury') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    const n = new Int8Array(this.n.length);
    for (let k = 0; k < n.length; k++) n[k] = Math.round(clamp(this.n[k], -1, 1) * 127);
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3, true));
    const c = new Uint16Array(this.c.length);
    for (let k = 0; k < c.length; k++) c[k] = Math.round(clamp(this.c[k], 0, 1) * 65535);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3, true));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    const e = new Uint8Array(this.e.length);
    for (let k = 0; k < e.length; k++) e[k] = Math.round(clamp(this.e[k], 0, 1) * 255);
    g.setAttribute(extraName, new THREE.BufferAttribute(e, this.extra, true));
    if (this.site.length === this.count * 4) g.setAttribute('aSite', siteAttribute(this.site));
    if (this.hvFn && this.hv.length === this.count) {
      const hv = new Int16Array(this.count);
      for (let k = 0; k < hv.length; k++) hv[k] = Math.round(clamp(this.hv[k] / 0.15, -1, 1) * 32767);
      g.setAttribute('aHv', new THREE.BufferAttribute(hv, 1, true));
    }
    const Idx = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new Idx(this.i), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// aSite: u / 2.1, v / 1.2, top / 0.15, moss — Int16, normalised (see SITE_GLSL)
function siteAttribute(site) {
  const a = new Int16Array(site.length);
  const sc = [2.1, 1.2, 0.15, 1];
  for (let k = 0; k < site.length; k++) a[k] = Math.round(clamp(site[k] / sc[k % 4], -1, 1) * 32767);
  return new THREE.BufferAttribute(a, 4, true);
}

// Soft dark quads on the ground (contact darkening); colour carries alpha.
class DecalGeo {
  constructor() {
    this.p = [];
    this.t = [];
    this.a = [];
    this.i = [];
  }

  get count() {
    return this.p.length / 3;
  }

  get triangles() {
    return this.i.length / 3;
  }

  v(x, y, z, u, w, a) {
    this.p.push(x, y, z);
    this.t.push(u, w);
    this.a.push(a);
    return this.count - 1;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    const c = new Uint8Array(this.a.length * 4);
    for (let k = 0; k < this.a.length; k++) {
      c[4 * k] = c[4 * k + 1] = c[4 * k + 2] = 255;
      c[4 * k + 3] = Math.round(clamp(this.a[k]) * 255);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 4, true));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// ═════════════════════════════════════════════════════════════
// The ground: a cached heroHeightAt grid, plus what already lies on it
// ═════════════════════════════════════════════════════════════

class Ground {
  constructor(step = 0.0125, margin = 0.15, tier = 'medium') {
    this.s = step;
    this.u0 = -PATCH.halfL - margin;
    this.v0 = -PATCH.halfW - margin;
    this.nu = Math.ceil((2 * (PATCH.halfL + margin)) / step) + 1;
    this.nv = Math.ceil((2 * (PATCH.halfW + margin)) / step) + 1;
    this.h = new Float32Array(this.nu * this.nv);
    for (let j = 0; j < this.nv; j++) {
      for (let i = 0; i < this.nu; i++) {
        const u = this.u0 + i * step;
        const v = this.v0 + j * step;
        this.h[j * this.nu + i] = heroHeightAt(wX(u, v), wZ(u, v));
      }
    }
    // The moss carpet's visible height above the floor, sampled exactly where the moss module puts its shell
    // vertices (its tier grid over the patch) and interpolated over the same triangles, so litter rests on
    // the carpet as it is drawn.
    this.ml = null;
    if (mossTopAt) {
      const step = mossTierOf?.({ tier })?.grid ?? 0.03;
      this.mnu = Math.ceil((2 * PATCH.halfL) / step);
      this.mnv = Math.ceil((2 * PATCH.halfW) / step);
      this.mdu = (2 * PATCH.halfL) / this.mnu;
      this.mdv = (2 * PATCH.halfW) / this.mnv;
      const W = this.mnu + 1;
      this.ml = new Float32Array(W * (this.mnv + 1));
      for (let j = 0; j <= this.mnv; j++) {
        for (let i = 0; i <= this.mnu; i++) {
          const u = -PATCH.halfL + i * this.mdu;
          const v = -PATCH.halfW + j * this.mdv;
          const x = wX(u, v);
          const z = wZ(u, v);
          this.ml[j * W + i] = Math.max(0, mossTopAt(x, z) - heroHeightAt(x, z));
        }
      }
    }
  }

  mossLift(x, z) {
    if (!this.ml) return 0;
    const fu = (toU(x, z) + PATCH.halfL) / this.mdu;
    const fv = (toV(x, z) + PATCH.halfW) / this.mdv;
    if (fu < 0 || fv < 0 || fu > this.mnu || fv > this.mnv) return 0;
    const i = Math.min(this.mnu - 1, Math.floor(fu));
    const j = Math.min(this.mnv - 1, Math.floor(fv));
    const a = fu - i;
    const b = fv - j;
    const W = this.mnu + 1;
    const m = this.ml;
    const A = m[j * W + i];
    const B = m[j * W + i + 1];
    const Cc = m[(j + 1) * W + i];
    const D = m[(j + 1) * W + i + 1];
    // the shells split each cell along (i + 1, j)–(i, j + 1)
    return a + b <= 1 ? A + (B - A) * a + (Cc - A) * b : D + (Cc - D) * (1 - a) + (B - D) * (1 - b);
  }

  sample(arr, u, v) {
    const fu = clamp((u - this.u0) / this.s, 0, this.nu - 1.0001);
    const fv = clamp((v - this.v0) / this.s, 0, this.nv - 1.0001);
    const i = Math.floor(fu);
    const j = Math.floor(fv);
    const a = fu - i;
    const b = fv - j;
    const k = j * this.nu + i;
    const n = this.nu;
    return (arr[k] * (1 - a) + arr[k + 1] * a) * (1 - b) + (arr[k + n] * (1 - a) + arr[k + n + 1] * a) * b;
  }

  uv(u, v) {
    return this.sample(this.h, u, v);
  }

  at(x, z) {
    return this.sample(this.h, toU(x, z), toV(x, z));
  }

  normal(x, z, out = new THREE.Vector3()) {
    const e = this.s;
    const hx = this.at(x + e, z) - this.at(x - e, z);
    const hz = this.at(x, z + e) - this.at(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }
}

// Twigs (capsules) and flat pieces (discs) that later litter can rest on.
class Supports {
  constructor(ground) {
    this.g = ground;
    this.cs = 0.04;
    this.cells = new Map();
    this.mk = 0; // how far up the moss carpet the litter being placed now rests (see REST)
  }

  // the resting surface for the current kind of litter: the floor, or partway up the moss
  surf(x, z) {
    return this.g.at(x, z) + (this.mk ? this.mk * this.g.mossLift(x, z) : 0);
  }

  key(i, j) {
    return (i + 2048) * 8192 + (j + 2048);
  }

  insert(item, x0, z0, x1, z1) {
    const cs = this.cs;
    for (let i = Math.floor(x0 / cs); i <= Math.floor(x1 / cs); i++) {
      for (let j = Math.floor(z0 / cs); j <= Math.floor(z1 / cs); j++) {
        const k = this.key(i, j);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
      }
    }
  }

  capsule(a, b, r) {
    const it = { cap: true, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r };
    this.insert(it, Math.min(a.x, b.x) - r, Math.min(a.z, b.z) - r, Math.max(a.x, b.x) + r, Math.max(a.z, b.z) + r);
  }

  // a flat piece lying `lift` metres above the ground (follows the slope under it)
  disc(x, z, r, lift) {
    this.insert({ cap: false, x, z, r, lift, mk: this.mk }, x - r, z - r, x + r, z + r);
  }

  // Is any twig within `rad` of the ground segment (ax, az)–(bx, bz)?
  nearCapsule(ax, az, bx, bz, rad) {
    const cs = this.cs;
    const seen = new Set();
    const pd = (px, pz, x0, z0, x1, z1) => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-12 ? clamp(((px - x0) * dx + (pz - z0) * dz) / l2) : 0;
      return Math.hypot(x0 + dx * t - px, z0 + dz * t - pz);
    };
    for (let i = Math.floor((Math.min(ax, bx) - rad) / cs); i <= Math.floor((Math.max(ax, bx) + rad) / cs); i++) {
      for (let j = Math.floor((Math.min(az, bz) - rad) / cs); j <= Math.floor((Math.max(az, bz) + rad) / cs); j++) {
        for (const it of this.cells.get(this.key(i, j)) ?? []) {
          if (!it.cap || seen.has(it)) continue;
          seen.add(it);
          // 2D segment–segment distance: crossing, or the closest endpoint
          const d1x = bx - ax;
          const d1z = bz - az;
          const d2x = it.bx - it.ax;
          const d2z = it.bz - it.az;
          const den = d1x * d2z - d1z * d2x;
          if (Math.abs(den) > 1e-12) {
            const s = ((it.ax - ax) * d2z - (it.az - az) * d2x) / den;
            const t = ((it.ax - ax) * d1z - (it.az - az) * d1x) / den;
            if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return true;
          }
          const d = Math.min(pd(ax, az, it.ax, it.az, it.bx, it.bz), pd(bx, bz, it.ax, it.az, it.bx, it.bz), pd(it.ax, it.az, ax, az, bx, bz), pd(it.bx, it.bz, ax, az, bx, bz));
          if (d < rad + it.r) return true;
        }
      }
    }
    return false;
  }

  top(x, z, capsOnly = false, discK = 1) {
    const list = this.cells.get(this.key(Math.floor(x / this.cs), Math.floor(z / this.cs)));
    if (!list) return -Infinity;
    let best = -Infinity;
    for (const it of list) {
      if (capsOnly && !it.cap) continue;
      if (it.cap) {
        const dx = it.bx - it.ax;
        const dz = it.bz - it.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? clamp(((x - it.ax) * dx + (z - it.az) * dz) / l2) : 0;
        const ex = it.ax + dx * t - x;
        const ez = it.az + dz * t - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < it.r * it.r) best = Math.max(best, it.ay + (it.by - it.ay) * t + Math.sqrt(it.r * it.r - d2));
      } else {
        const d2 = (x - it.x) ** 2 + (z - it.z) ** 2;
        if (d2 < it.r * it.r) best = Math.max(best, this.g.at(x, z) + it.mk * this.g.mossLift(x, z) + it.lift * discK);
      }
    }
    return best;
  }

  // discK < 1: needles settle between the flat pieces rather than on top of them
  at(x, z, discK = 1) {
    return Math.max(this.surf(x, z), this.top(x, z, false, discK));
  }
}

// 1D box blur of every line of a 2D array: `len` samples per line, `stride` between samples, `lineStep` between lines.
function boxBlur(src, len, lines, rad, stride, lineStep) {
  const out = new Float32Array(src.length);
  for (let l = 0; l < lines; l++) {
    const o = l * lineStep;
    let sum = 0;
    let n = 0;
    for (let k = 0; k <= Math.min(len - 1, rad); k++) {
      sum += src[o + k * stride];
      n++;
    }
    for (let i = 0; i < len; i++) {
      out[o + i * stride] = sum / n;
      const add = i + rad + 1;
      const drop = i - rad;
      if (add < len) {
        sum += src[o + add * stride];
        n++;
      }
      if (drop >= 0) {
        sum -= src[o + drop * stride];
        n--;
      }
    }
  }
  return out;
}

// Density fields: hollows (where needles drift), the nearby pines and spruces.
class Fields {
  constructor(ground, trees) {
    this.g = ground;
    const { nu, nv, h } = ground;
    const rad = Math.max(1, Math.round(0.08 / ground.s));
    // positive in hollows: the ground lies below its 8 cm neighbourhood (separable box blur, running sums)
    const tmp = boxBlur(h, nu, nv, rad, 1, nu);
    const blur = boxBlur(tmp, nv, nu, rad, nu, 1);
    this.hol = new Float32Array(nu * nv);
    for (let k = 0; k < nu * nv; k++) this.hol[k] = blur[k] - h[k];
    this.pines = [];
    this.spruces = [];
    this.birches = [];
    for (const t of trees ?? []) {
      const u = toU(t.x, t.z);
      const v = toV(t.x, t.z);
      if (Math.abs(u) > 7 || Math.abs(v) > 7) continue;
      if (t.species === 'pine') this.pines.push({ u, v, s: t.scale ?? 1 });
      if (t.species === 'spruce') this.spruces.push({ u, v, s: t.scale ?? 1 });
      if (t.species === 'birch' || t.species === 'youngBirch') this.birches.push({ u, v, s: t.scale ?? 1 });
    }
    // the trees beside the glide (in case the tree list is missing)
    if (!this.pines.length) this.pines.push({ u: 2.51, v: -1.42, s: 1 }, { u: 1.17, v: 4.13, s: 1.15 });
    if (!this.spruces.length) this.spruces.push({ u: 4.92, v: -4.48, s: 0.95 });
    if (!this.birches.length) this.birches.push({ u: -0.4, v: -1.58, s: 1.15 }, { u: -1.49, v: 3.31, s: 1.2 });
  }

  hollow(u, v) {
    return this.g.sample(this.hol, u, v);
  }

  // 0 … ~1.5: litter fall from the nearby pine crowns
  pine(u, v) {
    let s = 0;
    for (const p of this.pines) s += Math.exp(-dist2(u - p.u, v - p.v) / 1.6) * p.s;
    return s;
  }

  spruce(u, v) {
    let s = 0;
    for (const p of this.spruces) s += Math.exp(-dist2(u - p.u, v - p.v) / 4) * p.s;
    return s;
  }
}

// ═════════════════════════════════════════════════════════════
// Procedural textures (pure: they return pixel arrays)
// ═════════════════════════════════════════════════════════════

const AT = 512; // atlas width (texels)
const ATH = 256; // detail-atlas height: 256 texels along a 5 cm needle is 0.2 mm each
// Atlas regions (texel columns): needles 0–127 (8 strips), granite 128–255, bark 256–319,
// lichen-crusted bark 320–383, bark flake 384–447, wood/cone 448–511 with a plain white block on top.
const UV = {
  needle: (col, s) => (col * 16 + 2 + 12 * s) / AT,
  grit: (s) => (132 + 120 * s) / AT,
  bark: (s) => (256.5 + 63 * s) / AT,
  barkLichen: (s) => (320.5 + 63 * s) / AT,
  flake: (s) => (386 + 60 * s) / AT,
  wood: (s) => (450 + 10 * s) / AT,
  scaleIn: (s, t) => (465 + 46 * s) / AT, // inner face of a loose spruce scale (s across, t along)
  scaleOut: (s, t) => (465 + 46 * s) / AT,
  scaleInV: (t) => (1 + 110 * t) / ATH,
  scaleOutV: (t) => (113 + 110 * t) / ATH,
  plainU: 488 / AT,
  plainV: 0.975,
};

const ENC = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  ENC[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
}
const enc = (l) => ENC[Math.round(clamp(l) * 4096)];

function hashI(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Periodic value noise (periods px, py in lattice cells) → 0 … 1. Tileable textures need it.
function pnoise(x, y, px, py, s) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hashI(x0, y0, s);
  const b = hashI(x1, y0, s);
  const c = hashI(x0, y1, s);
  const d = hashI(x1, y1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function pfbm(x, y, px, py, oct, s) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * pnoise(x, y, px, py, s + o * 17);
    norm += amp;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

// Periodic Worley noise: { f1, f2, id } for cells of `cell` texels over a px × py cell torus.
function worley(x, y, px, py, s) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const cx = (((ix + a) % px) + px) % px;
      const cy = (((iy + b) % py) + py) % py;
      const fx = ix + a + hashI(cx, cy, s);
      const fy = iy + b + hashI(cx, cy, s + 1);
      const d = Math.hypot(x - fx, y - fy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cx * 977 + cy;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id };
}

/** Litter detail atlas, 512 × 256 RGBA8 (sRGB colour, alpha = roughness). */
export function litterAtlasPixels(px = new Uint8Array(AT * ATH * 4)) {
  const S = AT;
  const H = ATH;
  const put = (x, y, r, g, b, a) => {
    const k = (y * S + x) * 4;
    px[k] = enc(r);
    px[k + 1] = enc(g);
    px[k + 2] = enc(b);
    px[k + 3] = Math.round(clamp(a) * 255);
  };

  // A — needle strips (base → tip along v): stomata lines, black Lophodermium fruit bodies, zone lines, decay
  for (let col = 0; col < 8; col++) {
    const rng = new RNG(4100 + col);
    const spots = [];
    for (let k = 0; k < [0, 2, 5, 9, 3, 14, 1, 4][col]; k++) spots.push([rng.float(0.06, 0.93), rng.float(-0.4, 0.4), rng.float(0.006, 0.016), rng.float(0.22, 0.42)]);
    const lines = [];
    for (let k = 0; k < [0, 0, 1, 0, 3, 4, 0, 2][col]; k++) lines.push([rng.float(0.08, 0.92), rng.float(0.0022, 0.004)]);
    for (let y = 0; y < H; y++) {
      const t = (y + 0.5) / H;
      for (let lx = 0; lx < 16; lx++) {
        const a = (lx - 7.5) / 6;
        let lum = 0.9 + 0.1 * noise2(a * 1.7 + col * 13.1, t * 70 + col * 3.7);
        lum *= 1 - 0.1 * a * a;
        lum *= 0.96 + 0.04 * Math.sin(a * 7.5 + col * 1.3);
        if (col === 7) lum *= 1 - 0.3 * smoothstep(0.15, 0.45, noise2(a * 1.2 + 40, t * 22));
        if (col === 6) lum *= 1 - 0.18 * smoothstep(0.75, 1, t);
        let r = lum;
        let g = lum;
        let b = lum;
        let rough = 0.74 + 0.06 * noise2(a + col, t * 30);
        for (const [tc, ac, lt, wa] of spots) {
          const e = ((t - tc) / lt) ** 2 + ((a - ac) / wa) ** 2;
          if (e < 1.5) {
            const k = smoothstep(1.5, 0.7, e);
            r += (0.014 - r) * k;
            g += (0.012 - g) * k;
            b += (0.011 - b) * k;
            rough += (0.32 - rough) * k;
          }
        }
        for (const [tl, th] of lines) {
          const d = Math.abs(t - tl);
          if (d < th) {
            const k = 0.85 * smoothstep(th, th * 0.4, d);
            r += (0.03 - r) * k;
            g += (0.025 - g) * k;
            b += (0.02 - b) * k;
          }
        }
        put(col * 16 + lx, y, r, g, b, rough);
      }
    }
  }

  // B — granite: pink K-feldspar, white plagioclase, grey glassy quartz, black biotite
  const MIN = [
    [lin(196, 160, 150), 0.7],
    [lin(214, 210, 202), 0.65],
    [lin(150, 150, 156), 0.4],
    [lin(38, 34, 32), 0.45],
  ];
  for (let y = 0; y < H; y++) {
    for (let lx = 0; lx < 128; lx++) {
      const w = worley(lx / 16, y / 16, 8, H / 16, 300);
      const hpick = hashI(w.id, 7, 301);
      const m = hpick < 0.36 ? 0 : hpick < 0.62 ? 1 : hpick < 0.88 ? 2 : 3;
      const n = 0.9 + 0.2 * pnoise(lx / 4, y / 4, 32, H / 4, 310);
      const edge = 0.78 + 0.22 * smoothstep(0, 0.12, w.f2 - w.f1);
      const [c, rough] = MIN[m];
      put(128 + lx, y, c[0] * n * edge, c[1] * n * edge, c[2] * n * edge, rough);
    }
  }

  // C1 — neutral twig bark (luminance; the twig's vertex colour gives the hue), tileable both ways
  // C2 — grey-brown bark under crustose lichen (pale grey-green crusts with black apothecia, algae in cracks)
  const barkBase = lin(112, 96, 82);
  const crust = lin(150, 158, 138);
  for (let y = 0; y < H; y++) {
    for (let lx = 0; lx < 64; lx++) {
      const X = lx / 64;
      const Y = y / H;
      const f = pfbm(X * 8, Y * 12, 8, 12, 3, 11);
      const fiss = smoothstep(0.78, 0.95, 1 - Math.abs(2 * f - 1));
      const c2 = pfbm(X * 3, Y * 40, 3, 40, 2, 23);
      const crack = smoothstep(0.88, 0.97, 1 - Math.abs(2 * c2 - 1));
      const grain = pnoise(X * 32, Y * 64, 32, 64, 5);
      const len = pnoise(X * 8, Y * 48, 8, 48, 41);
      const lent = smoothstep(0.86, 0.93, len) * 0.12;
      const lum = 0.82 * (1 - 0.45 * fiss) * (1 - 0.25 * crack) * (0.94 + 0.12 * grain) + lent;
      put(256 + lx, y, lum, lum, lum, 0.86 + 0.08 * grain);

      const lm = smoothstep(0.58, 0.66, pfbm(X * 4 + 0.3, Y * 10, 4, 10, 3, 31)) * 0.9;
      let r = barkBase[0] * lum * 1.15;
      let g = barkBase[1] * lum * 1.15;
      let b = barkBase[2] * lum * 1.15;
      const algae = fiss * 0.4;
      r += (0.06 - r) * algae;
      g += (0.09 - g) * algae;
      b += (0.03 - b) * algae;
      if (lm > 0) {
        const cn = 0.88 + 0.12 * pnoise(X * 16, Y * 32, 16, 32, 33);
        r += (crust[0] * cn - r) * lm;
        g += (crust[1] * cn - g) * lm;
        b += (crust[2] * cn - b) * lm;
        const ap = worley(X * 10, Y * 80, 10, 80, 35);
        if (hashI(ap.id, 3, 36) < 0.35) {
          const k = smoothstep(0.24, 0.16, ap.f1) * lm;
          r += (0.025 - r) * k;
          g += (0.022 - g) * k;
          b += (0.02 - b) * k;
        }
      }
      put(320 + lx, y, r, g, b, 0.92);
    }
  }

  // D1 — papery pine bark flake (fibres, layered edges, specks); D2 — cone/wood fibre, plain block on top
  for (let y = 0; y < H; y++) {
    for (let lx = 0; lx < 64; lx++) {
      const X = lx / 64;
      const Y = y / H;
      // papery bark: fine fibres along the grain (v), paler and darker sheets, thin cross cracks, specks
      const fib = pfbm(X * 24, Y * 3, 24, 3, 3, 51);
      const lay = pfbm(X * 4, Y * 8, 4, 8, 2, 53);
      let lum = 0.6 + 0.4 * fib;
      lum *= 1 - 0.35 * smoothstep(0.58, 0.7, lay) + 0.12 * smoothstep(0.32, 0.2, lay);
      const crk = pnoise(X * 3, Y * 34, 3, 34, 57);
      lum *= 1 - 0.4 * smoothstep(0.9, 0.97, 1 - Math.abs(2 * crk - 1));
      const sp = pnoise(X * 40, Y * 40, 40, 40, 55);
      if (sp > 0.93) lum *= 0.72;
      put(384 + lx, y, Math.min(1, lum), Math.min(1, lum), Math.min(1, lum), 0.8);

      let w = 0.86 + 0.14 * pfbm(X * 20, Y * 4, 20, 4, 3, 61);
      if (lx >= 16 && y >= H - 32) w = 1;
      else if (lx >= 16) {
        // loose spruce-cone scales (48 × 112 texels each): inner face with its two pale seed scars below,
        // outer face above; along t from the woody heel (0) to the torn tip (1)
        const inner = y < 112;
        const sc = (lx - 16 + 0.5) / 48;
        const t = ((inner ? y : y - 112) + 0.5) / 112;
        const str = pnoise(sc * 26, t * 4, 26, 4, inner ? 71 : 73);
        let l = (inner ? 0.86 : 0.74) + (inner ? 0.06 : 0.12) * (str - 0.5) * 2;
        l *= 0.55 + 0.45 * smoothstep(0.0, 0.3, t); // the darker, thicker heel
        if (inner) {
          for (const cx of [0.3, 0.7]) {
            const d = Math.hypot((sc - cx) / 0.16, (t - 0.63) / 0.27);
            l = l + (1 - l) * 0.85 * smoothstep(1.05, 0.75, d) - 0.12 * smoothstep(1.25, 1.05, d) * smoothstep(0.9, 1.05, d);
          }
          l *= 1 - 0.18 * smoothstep(0.06, 0.0, Math.abs(sc - 0.5)) * smoothstep(0.35, 0.5, t); // the ridge between
        } else {
          l *= 1 + 0.12 * smoothstep(0.55, 0.85, t); // weathered exposed tip
        }
        w = clamp(l, 0, 1);
      }
      put(448 + lx, y, w, w, w, 0.84);
    }
  }
  return px;
}

// Birch leaf (Betula pendula): triangular-rhombic, long-acuminate, doubly serrate, 7 straight vein pairs.
// Stored as linear data: R luminance, G vein mask (midrib, side veins, the finer net), B decay order (low rots
// first: the margin, around holes, in blotches), A outline. The vertex colour gives the hue.
// Cell coordinates: X ∈ [-0.5, 0.5], Y ∈ [0, 1]; petiole 0.025 … 0.27, blade 0.27 … 0.97.
function leafCell(px, ox, oy, type, seed) {
  const C = 256;
  const rng = new RNG(seed);
  const W = 0.24;
  const bend = rng.float(-0.012, 0.012);
  const holes = [];
  const nh = [0, 7, 0, 12][type];
  for (let k = 0; k < nh; k++) holes.push([rng.float(-0.17, 0.17), rng.float(0.35, 0.9), rng.float(0.006, type === 3 ? 0.04 : 0.022)]);
  const spots = [];
  for (let k = 0; k < [5, 9, 0, 6][type]; k++) spots.push([rng.float(-0.15, 0.15), rng.float(0.35, 0.85), rng.float(0.004, 0.012)]);
  const sv = [];
  for (let k = 0; k < 7; k++) sv.push(0.05 + 0.118 * k + rng.float(-0.012, 0.012));
  const hw = (s) => (s < 0 || s > 1 ? 0 : s < 0.3 ? W * Math.pow(s / 0.3, 0.55) : W * Math.pow((1 - s) / 0.7, 1.15));
  const tooth = (q, d) => {
    const f = q - Math.floor(q);
    return d * (f < 0.82 ? f / 0.82 : (1 - f) / 0.18);
  };
  const segD = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
    return Math.hypot(x - ax - dx * t, y - ay - dy * t);
  };
  const put = (x, y, r, g, b, a) => {
    const k = ((oy + y) * AT + ox + x) * 4;
    px[k] = Math.round(clamp(r) * 255);
    px[k + 1] = Math.round(clamp(g) * 255);
    px[k + 2] = Math.round(clamp(b) * 255);
    px[k + 3] = Math.round(clamp(a) * 255);
  };
  const aa = C / 1.2;
  const far = type === 2 ? 0.92 : type === 0 ? 0.84 : 0.7; // luminance bled into the empty texels
  for (let y = 0; y < C; y++) {
    const Y = (y + 0.5) / C;
    const s = (Y - 0.27) / 0.7;
    for (let x = 0; x < C; x++) {
      const X = (x + 0.5) / C - 0.5;
      const xr = X - bend * Math.sin(Math.max(0, s) * 2.2);
      const side = xr < 0 ? 0.97 : 1.03;
      // margin with primary and secondary teeth pointing to the apex
      const teeth = (tooth(s * 8.5, 0.02) + tooth(s * 25.5, 0.008) - 0.014) * smoothstep(0.03, 0.12, s) * (1 - smoothstep(0.9, 0.99, s));
      let edge = s >= 0 && s <= 1 ? hw(s) * side + teeth - Math.abs(xr) : -1;
      const pd = Math.abs(X - 0.004 * Math.sin(Y * 9)) - 0.0055;
      const onPetiole = Y > 0.025 && Y < 0.29 && pd < 0.01;
      if (edge < -0.012 && !onPetiole) {
        put(x, y, far, 0, 1, 0);
        continue;
      }
      if (type === 1 || type === 3) edge -= 0.012 * smoothstep(0.55, 0.85, noise2(X * 30 + seed, Y * 30)); // torn, shrivelled margin
      if (type === 3) edge = Math.min(edge, 0.05 + 0.06 * Math.sin(s * 7 + seed) + 0.02 * noise2(Y * 40, seed) - xr); // half torn away
      let a = clamp(edge * aa + 0.5);
      const petA = Y > 0.025 && Y < 0.29 ? clamp(-pd * aa + 0.5) : 0;
      a = Math.max(a, petA);
      // veins: midrib and seven straight pairs running out into the main teeth
      const mid = Math.abs(xr) - (0.0065 * (1 - 0.75 * clamp(s)) + 0.0012);
      let vein = s > -0.02 && s < 1 ? clamp(-mid * aa + 0.5) : 0;
      for (const sk of sv) {
        if (s < sk - 0.03 || s > sk + 0.16) continue;
        const ek = sk + 0.13;
        const ey = 0.27 + 0.7 * ek;
        const sy = 0.27 + 0.7 * sk;
        for (const sg of [-1, 1]) {
          const d = segD(xr, Y, 0, sy, sg * (hw(ek) * 1.0 + 0.008), ey) - 0.0028 * (1 - 0.5 * ek);
          vein = Math.max(vein, clamp(-d * aa + 0.5));
        }
      }
      const wq = worley(X * 36 + 50, Y * 36, 999, 999, seed);
      const net = smoothstep(0.09, 0.03, wq.f2 - wq.f1);
      const n1 = noise2(X * 18 + seed * 0.1, Y * 18);
      let lum;
      if (type === 0) {
        // fresh: pale veins, faint mottling, a darker rim
        lum = 0.84 + 0.06 * n1;
        lum += (0.98 - lum) * vein * 0.6;
        lum *= 1 - 0.12 * smoothstep(0.012, 0.0, edge);
      } else if (type === 2) {
        // skeleton: only the vein net and a few scraps of lamina remain
        const keep = smoothstep(0.62, 0.7, noise2(X * 9 + seed, Y * 9)) * (1 - smoothstep(0.4, 0.9, s));
        a = Math.max(Math.min(a, Math.max(vein, net * 0.95 * clamp(edge * aa), keep)), petA);
        lum = 0.92 + 0.05 * n1;
      } else {
        // old brown / fragment: mottled, darker patches, veins showing light
        const patch = smoothstep(0.2, 0.5, noise2(X * 7 - seed, Y * 7)) * 0.4;
        lum = (0.62 + 0.25 * (0.5 + 0.5 * n1)) * (1 - patch) * (1 - 0.18 * net);
        lum += (0.86 - lum) * vein * 0.5;
      }
      for (const [hx, hy, hr] of spots) {
        const d = Math.hypot(xr - hx, Y - hy);
        if (d < hr * 1.6) lum *= 1 - 0.55 * smoothstep(hr * 1.6, hr * 0.6, d);
      }
      // decay order: the margin, hole rims and blotches go first; veins (G) stay longest
      let dec = 0.55 + 0.3 * noise2(X * 11 + seed, Y * 11 - seed) + 0.15 * noise2(X * 37 - seed, Y * 37);
      dec -= 0.35 * smoothstep(0.03, 0.0, edge);
      for (const [hx, hy, hr] of holes) {
        if (Math.abs(xr - hx) > hr * 1.5 + 0.03 || Math.abs(Y - hy) > hr * 1.5 + 0.03) continue;
        const d = Math.hypot(xr - hx, Y - hy) - hr * (1 + 0.4 * noise2(X * 60, Y * 60 + hx * 9));
        dec -= 0.3 * smoothstep(0.03, 0.0, d);
        if (d < 0.004) {
          a = Math.min(a, clamp(d * aa + 0.5));
          lum *= 0.8;
        }
      }
      if (Y > 0.025 && Y < 0.29 && pd < 0.004) lum *= 0.75;
      put(x, y, lum, Math.max(vein, net * 0.55, petA), dec, a);
    }
  }
}

/** Birch leaf atlas, 512² RGBA8: 0 fresh, 1 old brown, 2 skeleton, 3 torn fragment (2 × 2 cells). */
export function leafAtlasPixels(px = new Uint8Array(AT * AT * 4)) {
  leafCell(px, 0, 0, 0, 11);
  leafCell(px, 256, 0, 1, 23);
  leafCell(px, 0, 256, 2, 37);
  leafCell(px, 256, 256, 3, 41);
  return px;
}

/** 64² soft round blob (alpha) for contact darkening. */
export function blobPixels() {
  const S = 64;
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5) * 2;
      const k = (y * S + x) * 4;
      px[k] = px[k + 1] = px[k + 2] = 255;
      px[k + 3] = Math.round(Math.pow(1 - smoothstep(0.1, 1, d), 1.6) * 255);
    }
  }
  return px;
}

// ═════════════════════════════════════════════════════════════
// Shape builders
// ═════════════════════════════════════════════════════════════

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _n = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Ribbon along a centre line (a needle). Rows carry position, up vector, width and twist.
// Rounded normals across the width fake the needle's half-round section.
function ribbon(g, xs, ys, zs, up, ws, phis, cols, uL, uR, vs, bury) {
  const n = xs.length;
  const base = g.count;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const T = norm3(xs[b] - xs[a], ys[b] - ys[a], zs[b] - zs[a]);
    const S = norm3(...cross3(T, up));
    const N0 = cross3(S, T);
    const cp = Math.cos(phis[i]);
    const sp = Math.sin(phis[i]);
    const R = [S[0] * cp + N0[0] * sp, S[1] * cp + N0[1] * sp, S[2] * cp + N0[2] * sp];
    const F = cross3(R, T);
    const h = ws[i] * 0.5;
    const nl = norm3(F[0] - R[0] * 0.85, F[1] - R[1] * 0.85, F[2] - R[2] * 0.85);
    const nr = norm3(F[0] + R[0] * 0.85, F[1] + R[1] * 0.85, F[2] + R[2] * 0.85);
    g.v(xs[i] - R[0] * h, ys[i] - R[1] * h, zs[i] - R[2] * h, nl[0], nl[1], nl[2], cols[i], uL, vs[i], bury);
    g.v(xs[i] + R[0] * h, ys[i] + R[1] * h, zs[i] + R[2] * h, nr[0], nr[1], nr[2], cols[i], uR, vs[i], bury);
  }
  for (let i = 0; i < n - 1; i++) {
    const l = base + i * 2;
    g.tri(l, l + 1, l + 3);
    g.tri(l, l + 3, l + 2);
  }
}

// Tapered tube along [{x, y, z, r}] with rotation-minimising frames. Returns the frames for later use.
function tube(g, pts, o) {
  const n = pts.length;
  const R = o.radial;
  const T = [];
  const N = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    T.push(norm3(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  let nn = [0, 1, 0];
  {
    const d = nn[0] * T[0][0] + nn[1] * T[0][1] + nn[2] * T[0][2];
    nn = [nn[0] - T[0][0] * d, nn[1] - T[0][1] * d, nn[2] - T[0][2] * d];
    if (Math.hypot(...nn) < 0.2) nn = [1, 0, 0];
  }
  for (let i = 0; i < n; i++) {
    const t = T[i];
    const d = nn[0] * t[0] + nn[1] * t[1] + nn[2] * t[2];
    nn = norm3(nn[0] - t[0] * d, nn[1] - t[1] * d, nn[2] - t[2] * d);
    N.push(nn);
    B.push(cross3(t, nn));
  }
  const base = g.count;
  let acc = o.v0 ?? 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i > 0) acc += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z);
    for (let j = 0; j <= R; j++) {
      const a = (j / R) * TAU + (o.a0 ?? 0);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = N[i][0] * ca + B[i][0] * sa;
      const dy = N[i][1] * ca + B[i][1] * sa;
      const dz = N[i][2] * ca + B[i][2] * sa;
      const r = p.r * (o.rmod ? o.rmod(i, j, a) : 1);
      const x = p.x + dx * r;
      const y = p.y + dy * r;
      const z = p.z + dz * r;
      g.v(x, y, z, dx, dy, dz, o.col(i, j, x, y, z, dy), o.u0 + o.uw * (j / R), acc / (o.vRep ?? 0.05), o.bury ?? 1);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < R; j++) {
      const a = base + i * (R + 1) + j;
      const b = a + R + 1;
      g.tri(a, a + 1, b);
      g.tri(b, a + 1, b + 1);
    }
  }
  return { T, N, B, base, pts };
}

// Fan cap over tube ring `ring` (0 = first, n-1 = last), pushed out by `bulge` along the tube.
function capRing(g, fr, ring, R, col, bury, bulge = 0.2, jag = 0, rng = null) {
  const p = fr.pts[ring];
  const t = fr.T[ring];
  const s = ring === 0 ? -1 : 1;
  const dx = t[0] * s;
  const dy = t[1] * s;
  const dz = t[2] * s;
  const c = g.v(p.x + dx * p.r * bulge, p.y + dy * p.r * bulge, p.z + dz * p.r * bulge, dx, dy, dz, col, UV.plainU, UV.plainV, bury);
  const first = fr.base + ring * (R + 1);
  const ids = [];
  for (let j = 0; j < R; j++) {
    const k = first + j;
    const jj = jag && rng ? rng.float(-jag, jag) * p.r : 0;
    ids.push(g.v(g.p[3 * k] + dx * jj, g.p[3 * k + 1] + dy * jj, g.p[3 * k + 2] + dz * jj, dx, dy, dz, col, UV.plainU, UV.plainV, bury));
  }
  for (let j = 0; j < R; j++) g.triF(c, ids[j], ids[(j + 1) % R], dx, dy, dz);
}

// Orientation that lays local +Y along a heading (world xz angle) with pitch/roll, tilted onto the ground normal.
function layQuat(heading, pitch, roll, nrm) {
  const ax = new THREE.Vector3(Math.cos(heading) * Math.cos(pitch), Math.sin(pitch), Math.sin(heading) * Math.cos(pitch));
  _q.setFromUnitVectors(UPV, ax);
  _q2.setFromAxisAngle(UPV, roll);
  const q = new THREE.Quaternion().multiplyQuaternions(_q, _q2);
  if (nrm) q.premultiply(new THREE.Quaternion().setFromUnitVectors(UPV, nrm));
  return q;
}

// Lowest y offset at which a rigid local shape rests on the support (touching at its highest contact).
function restOffset(src, m, x, z, sup, step = 1) {
  let need = -Infinity;
  for (let k = 0; k < src.count; k += step) {
    const px = src.p[3 * k];
    const py = src.p[3 * k + 1];
    const pz = src.p[3 * k + 2];
    const wx = m[0] * px + m[4] * py + m[8] * pz + x;
    const wy = m[1] * px + m[5] * py + m[9] * pz;
    const wz = m[2] * px + m[6] * py + m[10] * pz + z;
    const s = sup.at(wx, wz) - wy;
    if (s > need) need = s;
  }
  return need;
}

// Place a rigid local Geo on the support: try a few pitches, keep the one with the lowest centre of mass.
function placeRigid(dst, src, env, o) {
  const { x, z } = o;
  const nrm = env.ground.normal(x, z, new THREE.Vector3());
  let best = null;
  const pitches = o.pitches ?? [0];
  for (const pitch of pitches) {
    // o.flat: a flat piece (local +Y = its face normal) turned about the ground normal and tipped a little;
    // otherwise local +Y is an axis (cone, core) laid along the heading
    const q = o.flat
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(o.tip?.[0] ?? 0, -o.heading, o.tip?.[1] ?? 0, 'YXZ')).premultiply(new THREE.Quaternion().setFromUnitVectors(UPV, nrm)) // local +x → heading
      : layQuat(o.heading, pitch, o.roll ?? 0, o.tilt === false ? null : nrm);
    const m = _m4.makeRotationFromQuaternion(q).elements.slice();
    const off = restOffset(src, m, x, z, env.sup, pitches.length > 1 ? 3 : 1);
    const com = o.com ?? [0, 0, 0];
    const cy = m[1] * com[0] + m[5] * com[1] + m[9] * com[2] + off;
    if (!best || cy < best.cy) best = { m, off, cy };
  }
  // final offset with every vertex
  const off = pitches.length > 1 ? restOffset(src, best.m, x, z, env.sup, 1) : best.off;
  const y = off - (o.sink ?? 0);
  const aoH = o.aoH ?? 0.006;
  // resting up on the moss: buried before deep snow hides the moss shells (else it would float over the flat snow)
  let bury = o.bury;
  if (typeof bury === 'number' && bury > 0.97 && env.sup.mk > 0 && env.ground.mossLift(x, z) * env.sup.mk > 0.002) bury = 0.97;
  const colFn = o.ao === false ? null : (c, wx, wy, wz) => mul3(c, 0.5 + 0.5 * smoothstep(-0.0015, aoH, wy - env.sup.at(wx, wz)));
  dst.begin(o.cat, { contact: 'rest', maxSink: (o.sink ?? 0) + 0.0025, x, z });
  dst.append(src, best.m, x, y, z, { colFn, bury });
  const it = dst.end();
  it.m = best.m;
  it.y = y;
  return it;
}

// ── Scots pine needle pair, draped over ground and twigs ──
// needlePlan() lays out the rows; the caller rejects needles that would rest wholly on wood (lift > 1.7 mm).
function needlePlan(env, o) {
  // o: x, z (base), dir (world xz angle), len, w, curve, phi0, phiRate, lift, tipLift, col, uvCol, broken, bury, rows
  const rows = o.rows ?? 5;
  const xs = new Array(rows);
  const ys = new Array(rows);
  const zs = new Array(rows);
  const ws = new Array(rows);
  const ph = new Array(rows);
  const cols = new Array(rows);
  const vs = new Array(rows);
  const cd = Math.cos(o.dir);
  const sd = Math.sin(o.dir);
  const tipT = o.broken ? 0.85 : 1;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const s = t * o.len;
    const lat = o.curve * t * t;
    const x = o.x + cd * s - sd * lat;
    const z = o.z + sd * s + cd * lat;
    xs[i] = x;
    zs[i] = z;
    let w = o.w;
    if (t < 0.08) w *= 0.78 + 2.7 * t;
    if (!o.broken && t > 0.7) w *= Math.max(0.12, 1 - Math.pow((t - 0.7) / 0.3, 1.4) * 0.88);
    ws[i] = w;
    ph[i] = o.phi0 + o.phiRate * t;
    ys[i] = env.sup.at(x, z, 0.15) + o.lift + Math.abs(Math.sin(ph[i])) * w * 0.5 + o.tipLift * t * t * t;
    const tone = t < 0.15 ? 1.06 : t > 0.8 ? (o.bleachTip ? 1.1 : 0.88) : 1;
    cols[i] = mul3(o.col, tone * (1 + (o.mottle ? o.mottle[i % o.mottle.length] : 0)));
    vs[i] = t * tipT;
  }
  // stiff needles bridge small gaps (never sink below the support)
  for (let it = 0; it < 2; it++) for (let i = 1; i < rows - 1; i++) ys[i] = Math.max(ys[i], (ys[i - 1] + ys[i + 1]) * 0.5 - 0.0004);
  let low = Infinity;
  for (let i = 0; i < rows; i++) low = Math.min(low, ys[i] - Math.abs(Math.sin(ph[i])) * ws[i] * 0.5 - env.sup.surf(xs[i], zs[i]));
  return { xs, ys, zs, ws, ph, cols, vs, low, uvCol: o.uvCol, bury: o.bury };
}

function needleEmit(g, env, n) {
  const rows = n.xs.length;
  env.ground.normal(n.xs[rows >> 1], n.zs[rows >> 1], _n);
  ribbon(g, n.xs, n.ys, n.zs, [_n.x, _n.y, _n.z], n.ws, n.ph, n.cols, UV.needle(n.uvCol, 0), UV.needle(n.uvCol, 1), n.vs, n.bury);
}

// The papery sheath that binds the pair: a short flattened 4-sided tube pointing back from the base.
function sheath(g, env, x, z, dir, len, w, col, bury, lift) {
  const cd = Math.cos(dir);
  const sd = Math.sin(dir);
  env.ground.normal(x, z, _n);
  const pts = [];
  for (const s of [-len, 0]) {
    const px = x + cd * s;
    const pz = z + sd * s;
    pts.push({ x: px, y: env.sup.at(px, pz, 0.15) + lift + w * 0.32, z: pz, r: w * (s === -len ? 0.36 : 0.5) });
  }
  const edge = mix3(col, PAL.sheathEdge, 0.5);
  const fr = tube(g, pts, {
    radial: 4,
    a0: Math.PI / 4,
    u0: UV.plainU,
    uw: 0,
    bury,
    rmod: (i, j, a) => (Math.abs(Math.sin(a)) > 0.5 ? 0.62 : 1.05), // flattened
    col: (i) => (i === 1 ? edge : col),
  });
  capRing(g, fr, 0, 4, mul3(col, 0.8), bury, 0.4);
}

// ── Spruce needle: single, four-sided (a ridged ribbon), 1.5–2.5 cm ──
function spruceNeedle(g, env, o) {
  const cd = Math.cos(o.dir);
  const sd = Math.sin(o.dir);
  const base = g.count;
  env.ground.normal(o.x, o.z, _n);
  const up = [_n.x, _n.y, _n.z];
  const T = norm3(cd, 0, sd);
  const S = norm3(...cross3(T, up));
  const F = cross3(S, T);
  const ts = [0, 0.55, 1];
  for (const t of ts) {
    const x = o.x + cd * o.len * t;
    const z = o.z + sd * o.len * t;
    const w = o.w * (t === 1 ? 0.15 : t === 0 ? 0.7 : 1);
    const y = env.sup.at(x, z, 0.15) + o.lift;
    const c = mul3(o.col, t === 0 ? 0.8 : t === 1 ? 0.9 : 1);
    const nl = norm3(F[0] - S[0], F[1] - S[1], F[2] - S[2]);
    const nr = norm3(F[0] + S[0], F[1] + S[1], F[2] + S[2]);
    const v = 0.15 + 0.7 * t;
    g.v(x - S[0] * w * 0.5, y - S[1] * w * 0.5, z - S[2] * w * 0.5, nl[0], nl[1], nl[2], c, UV.needle(o.uvCol, 0), v, o.bury);
    g.v(x + F[0] * w * 0.45, y + F[1] * w * 0.45, z + F[2] * w * 0.45, F[0], F[1], F[2], mul3(c, 1.08), UV.needle(o.uvCol, 0.5), v, o.bury);
    g.v(x + S[0] * w * 0.5, y + S[1] * w * 0.5, z + S[2] * w * 0.5, nr[0], nr[1], nr[2], c, UV.needle(o.uvCol, 1), v, o.bury);
  }
  for (let i = 0; i < 2; i++) {
    const a = base + i * 3;
    g.triF(a, a + 1, a + 4, F[0], F[1], F[2]);
    g.triF(a, a + 4, a + 3, F[0], F[1], F[2]);
    g.triF(a + 1, a + 2, a + 5, F[0], F[1], F[2]);
    g.triF(a + 1, a + 5, a + 4, F[0], F[1], F[2]);
  }
}

// ── Granite pebble: displaced, flattened icosphere ──
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => norm3(...p));
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const levels = [{ v, f }];
  for (let l = 0; l < 2; l++) {
    const { v: pv, f: pf } = levels[l];
    const nv = pv.slice();
    const cache = new Map();
    const mid = (a, b) => {
      const k = a < b ? a * 1000 + b : b * 1000 + a;
      if (cache.has(k)) return cache.get(k);
      nv.push(norm3((pv[a][0] + pv[b][0]) / 2, (pv[a][1] + pv[b][1]) / 2, (pv[a][2] + pv[b][2]) / 2));
      cache.set(k, nv.length - 1);
      return nv.length - 1;
    };
    const nf = [];
    for (const [a, b, c] of pf) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    levels.push({ v: nv, f: nf });
  }
  return levels;
})();

function pebbleGeo(rng, size, detail) {
  const g = new Geo();
  const { v, f } = ICO[detail];
  const sx = size * 0.5 * rng.float(0.85, 1.25);
  const sy = size * 0.5 * rng.float(0.45, 0.75);
  const sz = size * 0.5 * rng.float(0.8, 1.1);
  const o = [rng.float(0, 50), rng.float(0, 50)];
  const tint = vary(rng, [0.4, 0.39, 0.37], 0.15, 0.05); // weathered, humus-stained
  const pu = rng.float(0, 0.5);
  const pv = rng.float(0, 1);
  for (const d of v) {
    const r = 1 + 0.16 * noise2(d[0] * 1.7 + o[0], d[1] * 1.7 + d[2] * 1.3 + o[1]) + 0.06 * noise2(d[2] * 4 + o[1], d[0] * 4 - d[1] * 3);
    const x = d[0] * r * sx;
    const y = d[1] * r * sy;
    const z = d[2] * r * sz;
    g.v(x, y, z, d[0], d[1], d[2], tint, UV.grit(pu + (d[0] * 0.5 + 0.5) * 0.5), pv + (d[2] * 0.5 + 0.5) * 0.06, 1);
  }
  for (const [a, b, c] of f) g.triF(a, b, c, v[a][0] + v[b][0] + v[c][0], v[a][1] + v[b][1] + v[c][1], v[a][2] + v[b][2] + v[c][2]);
  g.smoothNormals();
  return g;
}

// A gnawed scale stub on a squirrel's core: a small ragged tent sticking out from the axis.
function stubTent(g, b, out, k, ln, w, col, rng) {
  const v0 = g.count;
  const up = norm3(...cross3(k, out));
  const tipJ = rng.float(-0.3, 0.3);
  const pts = [
    [-1, 0, 0],
    [0, 0, 0.35],
    [1, 0, 0],
    [-0.8 + tipJ * 0.3, 1, 0],
    [tipJ * 0.4, 1 + rng.float(-0.25, 0.15), 0.3],
    [0.8 + tipJ * 0.3, 1 + rng.float(-0.3, 0.1), 0],
  ];
  for (const [a, l, h] of pts) {
    const x = b[0] + k[0] * a * w * 0.5 + out[0] * ln * l + up[0] * h * w * 0.5;
    const y = b[1] + k[1] * a * w * 0.5 + out[1] * ln * l + up[1] * h * w * 0.5;
    const z = b[2] + k[2] * a * w * 0.5 + out[2] * ln * l + up[2] * h * w * 0.5;
    g.v(x, y, z, up[0], up[1], up[2], mul3(col, l ? rng.float(0.95, 1.15) : 0.62), UV.wood(rng.next()), rng.next(), 1);
  }
  const i0 = g.i.length;
  g.triF(v0, v0 + 1, v0 + 4, up[0], up[1], up[2]);
  g.triF(v0, v0 + 4, v0 + 3, up[0], up[1], up[2]);
  g.triF(v0 + 1, v0 + 2, v0 + 5, up[0], up[1], up[2]);
  g.triF(v0 + 1, v0 + 5, v0 + 4, up[0], up[1], up[2]);
  g.smoothNormals(v0, g.count, i0, g.i.length);
}

// ── Scots pine cone: Fibonacci-spiral scales, rhomboid apophyses with a transverse keel and umbo ──
function pineConeGeo(rng, o) {
  const g = new Geo();
  const { L, R, N } = o;
  const open = o.open ?? 0;
  const full = o.full !== false;
  const strip = o.strip ?? 0; // squirrel: scales below this t are gnawed down to stubs
  const t0 = 0.03;
  const t1 = 0.975;
  const th0 = rng.float(0, TAU);
  const sunTh = rng.float(0, TAU);
  const gib = o.gib ?? rng.float(0.1, 0.6);
  const age = o.age ?? 0.6;
  const tAt = (j) => t0 + ((t1 - t0) * (j + 0.5)) / N;
  const thAt = (j) => j * GA + th0;
  const shape = (t) => (Math.pow(Math.sin(Math.PI * clamp(t * 0.95 + 0.05)), 0.55) * (1 - 0.3 * t)) / 0.87;
  const rEnv = (t, th) => R * shape(t) * (1 + 0.12 * Math.cos(th - sunTh) * (1 - t));
  const env = (th, t) => {
    const r = rEnv(t, th);
    return [r * Math.cos(th), L * t, r * Math.sin(th)];
  };
  const envN = (th, t) => {
    const drdy = (rEnv(t + 0.01, th) - rEnv(t - 0.01, th)) / (0.02 * L);
    return norm3(Math.cos(th), -drdy, Math.sin(th));
  };
  const wrap = (a) => {
    let x = a % TAU;
    if (x > Math.PI) x -= TAU;
    if (x < -Math.PI) x += TAU;
    return x;
  };
  // the two Fibonacci parastichies whose neighbours lie closest (5 & 8 for a typical cone)
  const FIB = [2, 3, 5, 8, 13, 21];
  const jm = Math.floor(N * 0.45);
  const dist = (F) => {
    const a = env(thAt(jm), tAt(jm));
    const b = env(thAt(jm + F), tAt(jm + F));
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  let pa = 5;
  let pb = 8;
  let bestD = Infinity;
  for (let k = 0; k < FIB.length - 1; k++) {
    const d = Math.max(dist(FIB[k]), dist(FIB[k + 1]));
    if (d < bestD) {
      bestD = d;
      pa = FIB[k];
      pb = FIB[k + 1];
    }
  }
  const apo0 = mix3(PAL.apoBrown, PAL.apoGrey, age);
  const rc = R * 0.2;
  const shrink = 0.93 - 0.05 * open;
  const maxOpen = THREE.MathUtils.degToRad(58);
  const rot = (p, A, k, ang) => {
    // Rodrigues rotation of point p about the line through A along unit k
    const vx = p[0] - A[0];
    const vy = p[1] - A[1];
    const vz = p[2] - A[2];
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const kv = k[0] * vx + k[1] * vy + k[2] * vz;
    const cx = k[1] * vz - k[2] * vy;
    const cy = k[2] * vx - k[0] * vz;
    const cz = k[0] * vy - k[1] * vx;
    return [A[0] + vx * c + cx * s + k[0] * kv * (1 - c), A[1] + vy * c + cy * s + k[1] * kv * (1 - c), A[2] + vz * c + cz * s + k[2] * kv * (1 - c)];
  };
  const stubs = [];
  for (let i = 0; i < N; i++) {
    const t = tAt(i);
    const th = thAt(i);
    const P = env(th, t);
    const nP = envN(th, t);
    const dA = [wrap(thAt(i + pa) - th), tAt(i + pa) - t];
    const dB = [wrap(thAt(i + pb) - th), tAt(i + pb) - t];
    const top = [(dA[0] + dB[0]) * 0.5 * shrink, (dA[1] + dB[1]) * 0.5 * shrink];
    const rgt = [(dB[0] - dA[0]) * 0.5 * shrink, (dB[1] - dA[1]) * 0.5 * shrink];
    const k = [-Math.sin(th), 0, Math.cos(th)];
    if (t < strip) {
      stubs.push({ t, th, P, nP, k });
      continue;
    }
    const tc = env(th + top[0], t + top[1]);
    const size = Math.hypot(tc[0] - P[0], tc[1] - P[1], tc[2] - P[2]);
    const endF = smoothstep(0.02, 0.16, t) * (1 - 0.55 * smoothstep(0.8, 1, t));
    const sunK = Math.max(0, Math.cos(th - sunTh)) * (1 - smoothstep(0.2, 0.6, t));
    const hm = size * (0.3 + 0.15 * endF) * (0.45 + 0.55 * endF) * (1 + gib * sunK);
    const groove = size * 0.12;
    const gk = gib * sunK; // hooked (gibbous) lower half on the sun side near the base
    const pts = full
      ? [
          [0, 1, -groove, 0], [0.5, 0.5, hm * 0.18, 0], [1, 0, -groove, 0], [0.5, -0.5, hm * (0.2 + gk * 0.3), 0],
          [0, -1, -groove, 0], [-0.5, -0.5, hm * (0.2 + gk * 0.3), 0], [-1, 0, -groove, 0], [-0.5, 0.5, hm * 0.18, 0],
          [0, 0.45, hm * 0.5, 1], [0.5, 0, hm * (0.8 + gk * 0.3), 2], [0, -0.45, hm * (0.56 + gk * 0.9), 1], [-0.5, 0, hm * (0.8 + gk * 0.3), 2],
          [0, -0.04, hm * (1 + gk * 0.6), 3],
        ]
      : [
          [0, 1, -groove, 0], [1, 0, -groove, 0], [0, -1, -groove, 0], [-1, 0, -groove, 0],
          [0.55, 0, hm * 0.78, 2], [-0.55, 0, hm * 0.78, 2], [0, 0, hm, 3],
        ];
    const swing = open * maxOpen * smoothstep(0.03, 0.25, t) * (1 - 0.75 * smoothstep(0.78, 1, t)) * rng.float(0.85, 1.1);
    const A = [rc * Math.cos(th), Math.max(0, P[1] - (rEnv(t, th) - rc) / Math.tan(0.85)), rc * Math.sin(th)];
    const apo = vary(rng, apo0, 0.08, 0.03);
    const pos = pts.map(([a, b, hgt]) => {
      const q = env(th + a * rgt[0] + b * top[0], t + a * rgt[1] + b * top[1]);
      const p = [q[0] + nP[0] * hgt, q[1] + nP[1] * hgt, q[2] + nP[2] * hgt];
      return swing > 0.001 ? rot(p, A, k, -swing) : p;
    });
    const nOut = swing > 0.001 ? norm3(...rot([nP[0] + A[0], nP[1] + A[1], nP[2] + A[2]], A, k, -swing).map((x, q) => x - A[q])) : nP;
    const base = g.count;
    pts.forEach(([a, b, , role], q) => {
      let c = role === 0 ? (Math.abs(a) + Math.abs(b) > 0.99 ? mul3(apo, 0.55) : mul3(apo, b > 0 ? 0.92 : 0.82)) : role === 3 ? mix3(mul3(apo, 0.7), PAL.apoGrey, 0.3) : mul3(apo, b > 0.2 ? 1.1 : b < -0.2 ? 0.9 : 1.05);
      if (t < 0.12) c = mul3(c, 0.8);
      g.v(pos[q][0], pos[q][1], pos[q][2], nOut[0], nOut[1], nOut[2], c, UV.wood(rng.next()), rng.next(), 1);
    });
    const i0 = g.i.length;
    const F = (a, b, c) => g.triF(base + a, base + b, base + c, nOut[0], nOut[1], nOut[2]);
    if (full) {
      F(12, 8, 9); F(12, 9, 10); F(12, 10, 11); F(12, 11, 8);
      for (let qd = 0; qd < 4; qd++) {
        const inA = 8 + qd;
        const inB = 8 + ((qd + 1) % 4);
        const o0 = qd * 2;
        F(inA, o0, o0 + 1);
        F(inA, o0 + 1, inB);
        F(inB, o0 + 1, (o0 + 2) % 8);
      }
    } else {
      F(6, 0, 4); F(0, 1, 4); F(6, 4, 2); F(4, 1, 2); F(6, 5, 0); F(5, 3, 0); F(6, 2, 5); F(5, 2, 3);
    }
    g.smoothNormals(base, g.count, i0, g.i.length);
    // the woody scale behind an opened apophysis: upper (adaxial) and lower (abaxial) faces
    if (swing > 0.08) {
      const ix = full ? { L: 6, T: 0, R: 2, B: 4 } : { L: 3, T: 0, R: 1, B: 2 };
      const sideR = Math.sign((pos[ix.R][0] - pos[ix.L][0]) * k[0] + (pos[ix.R][2] - pos[ix.L][2]) * k[2]) || 1;
      const wh = size * 0.6;
      const hinge = (dy) => [
        [A[0] - k[0] * wh * sideR * 0.5, A[1] + dy, A[2] - k[2] * wh * sideR * 0.5],
        [A[0], A[1] + dy, A[2]],
        [A[0] + k[0] * wh * sideR * 0.5, A[1] + dy, A[2] + k[2] * wh * sideR * 0.5],
      ];
      const upDir = norm3(pos[ix.T][0] - pos[ix.B][0], pos[ix.T][1] - pos[ix.B][1], pos[ix.T][2] - pos[ix.B][2]);
      for (const [edgeIds, dy, desired, cA, cB] of [
        [[ix.L, ix.T, ix.R], 0, upDir, PAL.plateTop, 1],
        [[ix.L, ix.B, ix.R], -size * 0.35, upDir.map((x) => -x), PAL.plateBot, -1],
      ]) {
        const hRow = hinge(dy).map((p) => rot(p, A, k, -swing * 0.15));
        const eRow = edgeIds.map((q) => pos[q]);
        const mRow = hRow.map((h, q) => [h[0] + (eRow[q][0] - h[0]) * 0.55 + nOut[0] * size * 0.06 * cB, h[1] + (eRow[q][1] - h[1]) * 0.55 + nOut[1] * size * 0.06 * cB, h[2] + (eRow[q][2] - h[2]) * 0.55 + nOut[2] * size * 0.06 * cB]);
        const pc = vary(rng, mix3(cA, PAL.apoGrey, age * 0.35), 0.1, 0.04);
        const pb = g.count;
        const pi0 = g.i.length;
        for (const [row, kk] of [[hRow, 0.35], [mRow, 0.7], [eRow, 0.95]]) for (const p of row) g.v(p[0], p[1], p[2], desired[0], desired[1], desired[2], mul3(pc, kk), UV.plainU, UV.plainV, 1);
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < 2; c++) {
            const a = pb + r * 3 + c;
            g.triF(a, a + 1, a + 4, desired[0], desired[1], desired[2]);
            g.triF(a, a + 4, a + 3, desired[0], desired[1], desired[2]);
          }
        }
        g.smoothNormals(pb, g.count, pi0, g.i.length);
      }
    }
  }
  // core: the dark fill between apophyses (closed) or the thin axis deep inside (open)
  const core = [];
  const openK = smoothstep(0.05, 0.35, open);
  const ragged = strip > 0;
  for (let r = 0; r <= 12; r++) {
    const t = 0.005 + (r / 12) * 0.965;
    const prof = smoothstep(0.03, 0.25, t) * (1 - 0.75 * smoothstep(0.78, 1, t));
    let rad = rEnv(t, 0) * 0.84 * (1 - openK * prof) + (rc * 1.15) * openK * prof;
    if (ragged && t < strip) rad = R * 0.22;
    if (r === 12) rad = Math.max(0.0004, rad * 0.25);
    core.push({ x: 0, y: L * t, z: 0, r: rad });
  }
  const coreCol = ragged ? PAL.gnawed : PAL.coneCore;
  const coreFr = tube(g, core, {
    radial: full ? 10 : 7,
    u0: UV.wood(0),
    uw: 10 / AT,
    vRep: 0.03,
    rmod: ragged ? (i, j, a) => 1 + 0.32 * noise2(i * 1.7 + 3, a * 3.1) : null,
    col: (i, j, x, y) => (ragged && y / L < strip ? vary(rng, mix3(PAL.gnawed, PAL.gnawedOld, age), 0.12) : mul3(coreCol, 0.9 + 0.2 * (i / 12))),
  });
  // gnawed scale stubs left on a squirrel's core
  for (const s of stubs) {
    const r0 = R * 0.2;
    const b = [r0 * Math.cos(s.th), s.P[1] - 0.003, r0 * Math.sin(s.th)];
    const out = norm3(Math.cos(s.th), rng.float(0.35, 0.8), Math.sin(s.th));
    const c = vary(rng, mix3(PAL.gnawed, PAL.gnawedOld, age), 0.12);
    stubTent(g, b, out, s.k, R * rng.float(0.12, 0.25), R * rng.float(0.22, 0.32), c, rng);
  }
  if (ragged) {
    // the squirrel bit the stalk end off
    capRing(g, coreFr, 0, full ? 10 : 7, vary(rng, mix3(PAL.gnawed, PAL.woodEnd, 0.5), 0.08), 1, 0.15, 0.45, rng);
    return g;
  }
  // the short, bent peduncle
  const ped = [
    { x: 0, y: 0.004, z: 0, r: 0.0017 },
    { x: 0.0003, y: -0.002, z: 0.0008, r: 0.0015 },
    { x: 0.0008, y: -0.006, z: 0.0024, r: 0.0012 },
  ];
  const fr = tube(g, ped, { radial: 6, u0: UV.plainU, uw: 0, col: () => PAL.peduncle });
  capRing(g, fr, 2, 6, PAL.woodEnd, 1, 0.1);
  return g;
}

// ── Norway spruce cone scales (thin, obovate, wavy tip) ──
function spruceScale(g, A, d, k, nOut, len, wid, cup, rec, col, full, rng, bury = 1) {
  const rowsS = full ? [0, 0.3, 0.58, 0.82, 1] : [0, 0.5, 1];
  const wsP = full ? [0.32, 0.66, 0.94, 1, 0.92] : [0.35, 0.95, 0.85];
  const colsX = full ? [-1, -0.5, 0, 0.5, 1] : [-1, 0, 1];
  const base = g.count;
  const notch = rng.float(0.02, 0.05);
  rowsS.forEach((s, r) => {
    const tip = r === rowsS.length - 1;
    colsX.forEach((x) => {
      let along = s * len;
      if (tip) along -= len * (0.13 * (1 - Math.sqrt(1 - Math.min(1, x * x) * 0.96)) + notch * (1 - Math.min(1, Math.abs(x) * 2.5)) + rng.float(-0.015, 0.015));
      const across = x * wid * 0.5 * wsP[r];
      const bulge = cup * (1 - x * x) * s + rec * s * s * s;
      const px = A[0] + d[0] * along + k[0] * across + nOut[0] * bulge;
      const py = A[1] + d[1] * along + k[1] * across + nOut[1] * bulge;
      const pz = A[2] + d[2] * along + k[2] * across + nOut[2] * bulge;
      const c = s < 0.35 ? mix3(PAL.sprBase, col, s / 0.35) : tip ? mix3(col, PAL.sprTip, 0.6) : col;
      g.v(px, py, pz, nOut[0], nOut[1], nOut[2], c, UV.wood(rng.next()), s * 0.1, bury);
    });
  });
  const C = colsX.length;
  const i0 = g.i.length;
  for (let r = 0; r < rowsS.length - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      const a = base + r * C + c;
      g.triF(a, a + 1, a + C + 1, nOut[0], nOut[1], nOut[2]);
      g.triF(a, a + C + 1, a + C, nOut[0], nOut[1], nOut[2]);
    }
  }
  g.smoothNormals(base, g.count, i0, g.i.length);
}

function spruceConeGeo(rng, o) {
  const g = new Geo();
  const { L, N } = o;
  const open = o.open ?? 0.7;
  const full = o.full !== false;
  const strip = o.strip ?? 0;
  const age = o.age ?? 0.5;
  const th0 = rng.float(0, TAU);
  const rc = 0.0028;
  const t0 = 0.02;
  const t1 = 0.985;
  for (let i = 0; i < N; i++) {
    const t = t0 + ((t1 - t0) * (i + 0.5)) / N;
    const th = i * GA + th0;
    const endF = smoothstep(0, 0.18, t) * (1 - 0.65 * smoothstep(0.82, 1, t));
    const ra = [Math.cos(th), 0, Math.sin(th)];
    const k = [-Math.sin(th), 0, Math.cos(th)];
    const A = [rc * ra[0], L * t, rc * ra[2]];
    if (t < strip) {
      // gnawed stub: the squirrel bit each scale off close to the axis
      const c = vary(rng, mix3(PAL.gnawed, PAL.gnawedOld, age), 0.14);
      const out = norm3(ra[0], rng.float(0.35, 0.9), ra[2]);
      stubTent(g, [A[0] * 1.1, A[1], A[2] * 1.1], out, k, rng.float(0.0016, 0.0032), rng.float(0.0026, 0.004), c, rng);
      continue;
    }
    const beta = THREE.MathUtils.degToRad(22 + open * 22 * endF + rng.float(-3, 3));
    const d = [ra[0] * Math.sin(beta), Math.cos(beta), ra[2] * Math.sin(beta)];
    const nOut = norm3(...cross3(d, k).map((x) => -x));
    const nO = nOut[0] * ra[0] + nOut[2] * ra[2] < 0 ? nOut.map((x) => -x) : nOut;
    const len = o.ell * (0.45 + 0.55 * endF);
    const wid = o.W * (0.5 + 0.5 * endF);
    const col = vary(rng, mix3(PAL.sprOut, mix3(PAL.sprOut, PAL.apoGrey, 0.5), age), 0.08, 0.03);
    spruceScale(g, A, d, k, nO, len, wid, 0.0012, 0.0012 + open * 0.0015, col, full, rng);
  }
  const core = [];
  for (let r = 0; r <= 10; r++) {
    const t = r / 10;
    core.push({ x: 0, y: L * (0.005 + t * 0.975), z: 0, r: (strip && t < strip ? 0.0029 : 0.0034) * (r === 10 ? 0.3 : 1) });
  }
  const coreFr = tube(g, core, {
    radial: 7,
    u0: UV.wood(0),
    uw: 10 / AT,
    vRep: 0.03,
    rmod: strip ? (i, j, a) => 1 + 0.32 * noise2(i * 2.1, a * 3.1) : null,
    col: (i) => (strip && i / 10 < strip ? vary(rng, mix3(PAL.gnawed, PAL.gnawedOld, age), 0.1) : PAL.coneCore),
  });
  if (strip) {
    // the squirrel bit the stalk end off
    capRing(g, coreFr, 0, 7, vary(rng, mix3(PAL.gnawed, PAL.woodEnd, 0.5), 0.08), 1, 0.15, 0.45, rng);
    return g;
  }
  const ped = [
    { x: 0, y: 0.004, z: 0, r: 0.0022 },
    { x: 0.0004, y: -0.003, z: 0.001, r: 0.002 },
    { x: 0.0012, y: -0.008, z: 0.003, r: 0.0017 },
  ];
  const fr = tube(g, ped, { radial: 6, u0: UV.plainU, uw: 0, col: () => PAL.peduncle });
  capRing(g, fr, 2, 6, PAL.woodEnd, 1, 0.1);
  return g;
}

// A single loose spruce scale lying in the squirrel's pile (local: base at origin, along +x, face +y).
// A spruce-cone scale the squirrel tore off: thin and woody, 1.2–1.8 cm, reddish-brown outside, paler inside
// with the two seed scars, a dark thick heel, an erose or broken margin. Two layers (outer up, inner down,
// 0.3 mm apart, 1 mm at the heel). Local: heel at x = -len/2, tip toward +x, outer face up (flip = 1).
function looseScaleGeo(rng, full, { fresh = false } = {}) {
  const g = new Geo();
  const len = rng.float(0.012, 0.018);
  const wid = len * rng.float(0.78, 0.95);
  const flip = rng.chance(0.35) ? -1 : 1; // overturned: the inner face with its seed scars up
  const outer = vary(rng, fresh ? lin(128, 76, 48) : lin(112, 72, 50), 0.12, 0.05);
  const inner = vary(rng, fresh ? lin(184, 128, 84) : lin(160, 116, 80), 0.1, 0.04);
  const heel = lin(66, 38, 24);
  const C = full ? 7 : 5;
  const rowsS = full ? [0, 0.18, 0.4, 0.62, 0.82, 1] : [0, 0.35, 0.7, 1];
  const wP = (t) => (t < 0.3 ? 0.36 + 0.4 * (t / 0.3) : t < 0.7 ? 0.76 + 0.24 * ((t - 0.3) / 0.4) : 1 - 0.12 * ((t - 0.7) / 0.3));
  const broken = rng.chance(0.3) ? { side: rng.sign(), from: rng.float(0.35, 0.75), depth: rng.float(0.3, 0.7) } : null;
  const jag = Array.from({ length: C }, () => rng.float(-0.05, 0.05));
  const cup = rng.float(0.0006, 0.0016);
  const twist = rng.float(-0.0015, 0.0015);
  const shape = (t, x) => {
    let along = t * len;
    let across = x * wid * 0.5 * wP(t);
    if (t > 0.999) along -= len * (0.14 * (1 - Math.sqrt(1 - Math.min(1, x * x) * 0.96)) + Math.abs(jag[Math.round((x + 1) * 0.5 * (C - 1))]));
    else if (t > 0.75) across *= 1 + jag[Math.round((x + 1) * 0.5 * (C - 1))] * 0.6;
    if (broken && x * broken.side > 0 && t > broken.from) across *= 1 - broken.depth * smoothstep(broken.from, Math.min(1, broken.from + 0.25), t);
    const y = cup * (1 - x * x) * (0.3 + 0.7 * t) + twist * x * t;
    return [along - len * 0.5, y, across];
  };
  const layer = (up) => {
    const base = g.count;
    const i0 = g.i.length;
    rowsS.forEach((t) => {
      for (let c = 0; c < C; c++) {
        const x = (c / (C - 1)) * 2 - 1;
        const [px, py, pz] = shape(t, x);
        const half = 0.00015 + 0.00035 * (1 - smoothstep(0, 0.3, t)); // thick heel, paper-thin blade
        const k = 0.55 + 0.45 * smoothstep(0, 0.3, t);
        const col = up ? mix3(heel, outer, k) : mix3(heel, inner, 0.35 + 0.65 * k);
        const tip = t > 0.999 ? (up ? 1.08 : 1) : 1;
        g.v(px, py + (up ? half : -half), pz, 0, up ? 1 : -1, 0, mul3(col, tip), up ? UV.scaleOut((x + 1) * 0.5) : UV.scaleIn((x + 1) * 0.5), up ? UV.scaleOutV(t) : UV.scaleInV(t), 1);
      }
    });
    for (let r = 0; r < rowsS.length - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const a = base + r * C + c;
        g.triF(a, a + 1, a + C + 1, 0, up ? 1 : -1, 0);
        g.triF(a, a + C + 1, a + C, 0, up ? 1 : -1, 0);
      }
    }
    g.smoothNormals(base, g.count, i0, g.i.length);
    return base;
  };
  const top = layer(true);
  const bot = layer(false);
  // the woody heel's broken edge
  for (let c = 0; c < C - 1; c++) {
    const v0 = g.count;
    for (const q of [top + c, top + c + 1, bot + c + 1, bot + c]) g.v(g.p[3 * q], g.p[3 * q + 1], g.p[3 * q + 2], -1, 0, 0, mul3(heel, 0.8), UV.plainU, UV.plainV, 1);
    g.triF(v0, v0 + 1, v0 + 2, -1, 0, 0);
    g.triF(v0, v0 + 2, v0 + 3, -1, 0, 0);
  }
  if (flip < 0) {
    // overturned: rotate half a turn about the length axis
    for (let k = 0; k < g.count; k++) {
      g.p[3 * k + 1] = -g.p[3 * k + 1];
      g.p[3 * k + 2] = -g.p[3 * k + 2];
      g.n[3 * k + 1] = -g.n[3 * k + 1];
      g.n[3 * k + 2] = -g.n[3 * k + 2];
    }
  }
  return g;
}

// How a torn-off scale comes to lie: mostly flat, some tipped against others, some on edge.
function scaleTip(rng) {
  const r = rng.next();
  if (r < 0.58) return [rng.float(-0.25, 0.25), rng.float(-0.2, 0.2)];
  if (r < 0.8) return [rng.float(-0.7, 0.7), rng.float(-0.6, 0.6)];
  return [rng.sign() * rng.float(1.0, 1.45), rng.float(-0.3, 0.3)]; // on edge
}

// ── Scots pine bark: a papery flake (two or three sheets peeling apart, a torn outline, rolled along the
// grain) or a thick plate from low on the trunk (fissured grey top, layered reddish sides) ──
function flakeGeo(rng, o) {
  const g = new Geo();
  const thick = o.thick ?? 0;
  const a = o.len * 0.5; // along the grain (x)
  const b = a * (thick ? rng.float(0.55, 0.8) : rng.float(0.32, 0.62));
  const sec = thick ? 14 : 24;
  const rings = 3;
  const ph = rng.float(0, 10);
  const jag = Array.from({ length: sec }, () => rng.float(-1, 1));
  const rOf = (si, sc) => 1 + 0.16 * noise2(Math.cos((si / sec) * TAU) * 1.3 + ph + sc, Math.sin((si / sec) * TAU) * 1.3) + 0.07 * Math.sin((si / sec) * TAU * 5 + ph) + (thick ? 0.03 : 0.08) * jag[si];
  // thin bark rolls up across the grain as it dries; a few lie domed
  const roll = thick ? 0 : rng.float(6, 34) * (rng.chance(0.8) ? 1 : -0.5);
  const bendX = thick ? rng.float(-2, 2) : rng.float(-6, 6);
  const outer = vary(rng, o.outer ?? mix3(PAL.flakeOuter, PAL.flakeGrey, rng.float(0.15, 0.7)), 0.08, 0.04);
  const inner = vary(rng, PAL.flakeInner, 0.08, 0.04);
  const pu = rng.next();
  // one sheet: a fan of rings × sectors; returns the index of its outer ring
  const sheet = (up, y0, sc, dx, dz, col, top) => {
    const base = g.count;
    const i0 = g.i.length;
    for (let r = 0; r <= rings; r++) {
      const rr = r / rings;
      for (let si = 0; si < (r === 0 ? 1 : sec); si++) {
        const ang = (si / sec) * TAU;
        const k = rr * rOf(si, sc) * sc;
        const x = Math.cos(ang) * a * k + dx;
        const z = Math.sin(ang) * b * k + dz;
        const y = roll * z * z + bendX * x * x + y0;
        const c = mul3(col, (0.88 + 0.14 * noise2(x * 260 + ph, z * 260)) * (r === rings ? 0.8 : 1));
        const u = top && thick ? UV.bark(clamp(0.5 + (z / b) * 0.45)) : UV.flake(clamp(pu * 0.4 + (z / b + 1) * 0.3));
        g.v(x, y, z, 0, up, 0, c, u, 0.5 + x / Math.max(0.02, o.len * 1.5), o.bury);
      }
    }
    const ring = (r) => (r === 0 ? base : base + 1 + (r - 1) * sec);
    for (let si = 0; si < sec; si++) g.triF(base, ring(1) + si, ring(1) + ((si + 1) % sec), 0, up, 0);
    for (let r = 1; r < rings; r++) {
      for (let si = 0; si < sec; si++) {
        const p0 = ring(r) + si;
        const p1 = ring(r) + ((si + 1) % sec);
        const q0 = ring(r + 1) + si;
        const q1 = ring(r + 1) + ((si + 1) % sec);
        g.triF(p0, q0, q1, 0, up, 0);
        g.triF(p0, q1, p1, 0, up, 0);
      }
    }
    g.smoothNormals(base, g.count, i0, g.i.length);
    return ring(rings);
  };
  if (!thick) {
    // the weathered outer sheet on top, the bright inner bark peeking out below it
    const n = rng.int(2, 3);
    for (let li = 0; li < n; li++) {
      const sc = 1 - 0.09 * li;
      const col = li === 0 ? outer : mix3(inner, outer, 0.12 * (li - 1));
      sheet(1, -0.00022 * li, sc, rng.float(-0.12, 0.12) * a * li, rng.float(-0.15, 0.15) * b * li, col, false);
    }
    return g;
  }
  const topRing = sheet(1, thick, 1, 0, 0, outer, true);
  const botRing = sheet(-1, 0, 1, 0, 0, inner, false);
  // the plate's layered side wall: reddish inner bark between grey outer layers
  for (let si = 0; si < sec; si++) {
    const s1 = (si + 1) % sec;
    const ang = ((si + 0.5) / sec) * TAU;
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    const v0 = g.count;
    const side = vary(rng, PAL.chunkSide, 0.1);
    for (const q of [topRing + si, topRing + s1, botRing + s1, botRing + si]) g.v(g.p[3 * q], g.p[3 * q + 1], g.p[3 * q + 2], nx, 0, nz, q >= botRing ? mul3(side, 0.75) : mul3(side, 1.05), UV.flake(0.9), (q >= botRing ? 0 : 1) * 0.15 + si * 0.07, o.bury);
    g.triF(v0, v0 + 1, v0 + 2, nx, 0, nz);
    g.triF(v0, v0 + 2, v0 + 3, nx, 0, nz);
  }
  return g;
}

// ── Birch leaf: a curled 5 × 6 grid, draped over the support ──
function leaf(g, env, rng, o) {
  // o: x, z (blade centre), dir, size (cell side, m), cell, col, curlX, curlZ, fresh (0 old | key), bury
  const cols = 5;
  const rows = 6;
  const cd = Math.cos(o.dir);
  const sd = Math.sin(o.dir);
  const S = o.size;
  const cu = (o.cell % 2) * 0.5;
  const cv = Math.floor(o.cell / 2) * 0.5;
  const base = g.count;
  const wav = rng.float(0, 6);
  for (let r = 0; r < rows; r++) {
    const zz = r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const xx = c / (cols - 1) - 0.5;
      const lx = xx * S;
      const lz = (zz - 0.55) * S;
      const x = o.x + cd * lz - sd * lx;
      const z = o.z + sd * lz + cd * lx;
      const curl = o.curlX * S * (2 * xx) * (2 * xx) + o.curlZ * S * Math.max(0, zz - 0.55) ** 2 * 4 + 0.012 * S * Math.sin(xx * 5 + zz * 4 + wav) * o.curlX * 8;
      const y = env.sup.at(x, z) + o.lift + Math.max(0, curl);
      const tone = 0.94 + 0.12 * noise2(x * 40 + wav, z * 40);
      g.v(x, y, z, 0, 1, 0, mul3(o.col, tone), cu + 0.004 + (xx + 0.5) * 0.492, cv + 0.004 + zz * 0.492, [o.fresh, o.bury, o.decay ?? 0]);
    }
  }
  const i0 = g.i.length;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = base + r * cols + c;
      g.triF(a, a + 1, a + cols + 1, 0, 1, 0);
      g.triF(a, a + cols + 1, a + cols, 0, 1, 0);
    }
  }
  g.smoothNormals(base, g.count, i0, g.i.length);
}

// ── Contact darkening ──
function decalBlob(d, env, x, z, dir, ha, hb, alpha) {
  const cd = Math.cos(dir);
  const sd = Math.sin(dir);
  const base = d.count;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const la = (c - 1) * ha;
      const lb = (r - 1) * hb;
      const px = x + cd * la - sd * lb;
      const pz = z + sd * la + cd * lb;
      d.v(px, env.ground.at(px, pz) + 0.00035, pz, c * 0.5, r * 0.5, alpha * (1 - smoothstep(0.002, 0.006, env.ground.mossLift(px, pz))));
    }
  }
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const a = base + r * 3 + c;
      d.i.push(a, a + 3, a + 4, a, a + 4, a + 1);
    }
  }
}

function decalStrip(d, env, pts, half, alpha) {
  if (pts.length < 2) return;
  const base = d.count;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    const sx = -tz / l;
    const sz = tx / l;
    const p = pts[i];
    const gap = p.y - p.r - env.ground.at(p.x, p.z);
    const bare = 1 - smoothstep(0.002, 0.006, env.ground.mossLift(p.x, p.z)); // under moss the decal would be hidden
    const k = alpha * bare * (1 - smoothstep(0.001, 0.012, gap)) * (i === 0 || i === pts.length - 1 ? 0.3 : 1);
    const hw = half(p);
    for (const s of [-1, 1]) {
      const x = p.x + sx * hw * s;
      const z = p.z + sz * hw * s;
      d.v(x, env.ground.at(x, z) + 0.00035, z, s < 0 ? 0 : 1, 0.5, k);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = base + i * 2;
    d.i.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
}

// ═════════════════════════════════════════════════════════════
// Twigs
// ═════════════════════════════════════════════════════════════

// A wandering 2D path with kinks at the nodes (dead twigs zigzag a little where buds were).
function path2D(rng, x, z, head, len, r0, r1, seg = 0.007) {
  const n = Math.max(2, Math.ceil(len / seg));
  const step = len / n;
  const pts = [];
  let h = head;
  let cx = x;
  let cz = z;
  let acc = 0;
  let node = rng.float(0.02, 0.05);
  const bend = rng.float(-1, 1) * 1.2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: cx, z: cz, y: 0, r: r0 + (r1 - r0) * Math.pow(t, 0.85), t });
    acc += step;
    if (acc > node) {
      h += rng.float(-0.2, 0.2);
      acc = 0;
      node = rng.float(0.025, 0.06);
    }
    h += bend * step;
    cx += Math.cos(h) * step;
    cz += Math.sin(h) * step;
  }
  return pts;
}

function drape(pts, sup, sinkFrac, fixFirst = false) {
  for (let i = fixFirst ? 1 : 0; i < pts.length; i++) {
    const p = pts[i];
    p.y = sup.at(p.x, p.z) + p.r * (1 - sinkFrac);
  }
  // rigid wood bridges small hollows: lift points toward the line between their neighbours
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const m = (pts[i - 1].y + pts[i + 1].y) * 0.5;
      if (m > pts[i].y) pts[i].y = m;
    }
  }
}

// A raised branch: leaves its parent upward and droops a little under its own weight.
function raisedPath(p0, head, elev, len, r0, r1, sup, seg = 0.007) {
  const n = Math.max(2, Math.ceil(len / seg));
  const step = len / n;
  const pts = [];
  let dx = Math.cos(head) * Math.cos(elev);
  let dy = Math.sin(elev);
  let dz = Math.sin(head) * Math.cos(elev);
  let x = p0.x;
  let y = p0.y + p0.r * 0.4;
  let z = p0.z;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = r0 + (r1 - r0) * Math.pow(t, 0.85);
    y = Math.max(y, sup.at(x, z) + r);
    pts.push({ x, y, z, r, t });
    dy -= 0.25 * step / len;
    const l = Math.hypot(dx, dy, dz);
    x += (dx / l) * step;
    y += (dy / l) * step;
    z += (dz / l) * step;
  }
  return pts;
}

const SPECIES = {
  pine: { col: PAL.bark.pine, alt: PAL.bark.pineOrange, bumps: 0.12 },
  spruce: { col: PAL.bark.spruce, alt: PAL.bark.grey, bumps: 0.18 },
  birch: { col: PAL.bark.birch, alt: lin(120, 70, 56), bumps: 0.05 },
  grey: { col: PAL.bark.grey, alt: lin(130, 124, 116), bumps: 0.08 },
};

// Tube + caps for one twig part, coloured by species, darkened where it touches the ground.
function twigTube(g, env, pts, o) {
  const sp = SPECIES[o.species];
  const ph = o.rng.float(0, 50);
  const R = pts[0].r > 0.0018 ? 6 : pts[0].r > 0.0009 ? 5 : 4;
  const lich = !!o.lichen;
  const tint = vary(o.rng, WHITE, 0.08, 0.03);
  const fr = tube(g, pts, {
    radial: R,
    u0: lich ? UV.barkLichen(0) : UV.bark(0),
    uw: 63 / AT,
    vRep: 0.05,
    v0: o.rng.float(0, 1),
    bury: o.bury,
    a0: o.rng.float(0, TAU),
    rmod: (i, j, a) => 1 + sp.bumps * noise2(i * 0.8 + ph, a * 1.6) * 0.6 + (o.knots && o.knots.has(i) ? 0.25 : 0),
    col: (i, j, x, y, z) => {
      const p = pts[i];
      const k = smoothstep(-0.3, 0.6, noise2(p.t * 6 + ph, 1.7));
      let c = lich ? mul3(tint, 0.95) : mix3(sp.col, sp.alt, k * (o.species === 'pine' ? 0.4 + 0.6 * smoothstep(0.0025, 0.0008, p.r) : 0.5));
      if (!lich) c = [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]];
      const gap = y - env.sup.at(x, z);
      return mul3(c, 0.55 + 0.45 * smoothstep(-0.2 * p.r, 1.3 * p.r + 0.0008, gap));
    },
  });
  if (o.brokenStart) capRing(g, fr, 0, R, vary(o.rng, PAL.woodEnd, 0.08), o.bury, 0.15, 0.25, o.rng);
  if (o.brokenEnd) capRing(g, fr, pts.length - 1, R, vary(o.rng, PAL.woodEnd, 0.08), o.bury, 0.15, 0.25, o.rng);
  return { fr, R };
}

// One small dead twig with forks. Returns null if any part would leave its allowed area.
function smallTwig(env, rng, o) {
  const main = path2D(rng, o.x, o.z, o.head, o.len, o.r0, o.r0 * rng.float(0.22, 0.42));
  if (!main.every((p) => o.ok(p.x, p.z, p.r))) return null;
  const forks = [];
  const nf = o.len < 0.08 ? rng.int(0, 1) : rng.int(1, 3);
  for (let f = 0; f < nf; f++) {
    const at = Math.floor((main.length - 1) * rng.float(0.2, 0.75));
    const p = main[at];
    const q = main[Math.min(main.length - 1, at + 1)];
    const h = Math.atan2(q.z - p.z, q.x - p.x) + rng.sign() * rng.float(0.45, 1.05);
    const len = o.len * rng.float(0.18, 0.5);
    const raised = rng.chance(o.raise ?? 0.15);
    const r0 = p.r * rng.float(0.55, 0.8);
    forks.push({ at, h, len, raised, r0 });
  }
  const pathF = forks.map((f) => (f.raised ? null : path2D(rng, main[f.at].x, main[f.at].z, f.h, f.len, f.r0, Math.max(0.0003, f.r0 * 0.35))));
  if (pathF.some((pp) => pp && !pp.every((p) => o.ok(p.x, p.z, p.r)))) return null;
  const sink = rng.float(0.15, 0.3);
  drape(main, env.sup, sink);
  env.wood.begin('twig', { contact: 'drape', maxSink: 0.3 * o.r0 + 0.0025 }); // may nestle a little into moss
  const parts = [main];
  twigTube(env.wood, env, main, { rng, species: o.species, lichen: o.lichen, bury: o.bury, brokenStart: true, brokenEnd: rng.chance(0.4) });
  forks.forEach((f, k) => {
    const p0 = main[f.at];
    let pts;
    if (f.raised) {
      pts = raisedPath(p0, f.h, rng.float(0.3, 0.75), f.len, f.r0, Math.max(0.0003, f.r0 * 0.35), env.sup);
      if (!pts.every((p) => o.ok(p.x, p.z, p.r))) return;
    } else {
      pts = pathF[k];
      pts[0].y = p0.y;
      drape(pts, env.sup, sink, true);
    }
    pts[0].x = p0.x;
    pts[0].z = p0.z;
    pts[0].y = p0.y;
    twigTube(env.wood, env, pts, { rng, species: o.species, lichen: o.lichen, bury: o.bury, brokenEnd: rng.chance(0.3) });
    parts.push(pts);
    if (f.raised) env.raisedTips.push(pts[pts.length - 1]);
  });
  env.wood.end();
  for (const pts of parts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.y - a.r - env.sup.surf(a.x, a.z) < 0.01) env.sup.capsule(a, b, (a.r + b.r) * 0.5);
    }
    decalStrip(env.decal, env, pts, (p) => p.r * 3 + 0.0025, 0.32 * env.decalK);
  }
  return parts;
}

// ═════════════════════════════════════════════════════════════
// The builder
// ═════════════════════════════════════════════════════════════

/**
 * Builds all litter geometry (pure: no DOM, no GPU). Node tests call this directly.
 * @param {{ quality?: object, trees?: object[] }} o
 * @returns {{ fine: Geo, near: Geo, wood: Geo, leaves: Geo, lichen: MeshData, decal: DecalGeo, anchors: object, counts: object, ms: number }}
 */
export function buildLitterGeometry({ quality = {}, trees = [] } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const plants = quality.plants ?? 0.7;
  const tier = quality.tier ?? 'medium';
  const low = tier === 'low';
  const ground = new Ground(0.0125, 0.06, tier);
  const env = {
    ground,
    sup: new Supports(ground),
    field: new Fields(ground, trees),
    fine: new Geo(1),
    near: new Geo(1),
    wood: new Geo(1),
    leaves: new Geo(3), // aLeaf: fresh key, bury threshold, decay
    winter: new Geo(4), // on the snow: shoot tips, midden, cones, flakes
    winterNear: new Geo(4), // on the snow, sub-centimetre: needles, birch seeds and scales
    lichen: new MeshData(),
    lichenWinter: new MeshData(), // beard-lichen scraps blown down onto the snow
    decal: new DecalGeo(),
    lichenSites: [], // [first vertex, end vertex, site] per tuft
    lichenWinterSites: [],
    keep: [], // keep-out discs (cones, cores): { x, z, r }
    raisedTips: [],
    anchors: {},
    counts: {},
    plants,
    low,
    decalK: LITTER.contactShadow * (quality.ssao ? 0.6 : 1),
  };
  // the site of a piece for the snow field: its centroid, how high it reaches, whether it rests up on the moss
  const siteOf = (g, it) => {
    let x = 0;
    let z = 0;
    let top = 0;
    const step = Math.max(1, Math.floor((it.v1 - it.v0) / 64));
    let m = 0;
    for (let k = it.v0; k < it.v1; k += step) {
      x += g.p[3 * k];
      z += g.p[3 * k + 2];
      m++;
    }
    x /= Math.max(1, m);
    z /= Math.max(1, m);
    for (let k = it.v0; k < it.v1; k += step) top = Math.max(top, g.p[3 * k + 1] - ground.at(g.p[3 * k], g.p[3 * k + 2]));
    const onMoss = env.sup.mk > 0 && ground.mossLift(x, z) * env.sup.mk > 0.002 ? 1 : 0;
    return [toU(x, z), toV(x, z), top, onMoss];
  };
  const hvOf = (x, y, z) => y - ground.at(x, z);
  for (const g of [env.fine, env.near, env.wood, env.leaves]) {
    g.siteFn = siteOf;
    g.hvFn = hvOf;
  }
  for (const g of [env.winter, env.winterNear]) g.siteFn = siteOf; // winter pieces: only the anchor is used
  const n = (base, min = 0) => Math.max(min, Math.round(base * plants));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const timing = { ground: now() - t0 };
  const step = (name, fn) => {
    const s = now();
    fn();
    timing[name] = Math.round(now() - s);
  };

  step('heroTwig', () => heroTwig(env));
  step('silkTwig', () => silkTwig(env));
  step('twigs', () => smallTwigs(env, n(LITTER.twigs, 6)));
  step('heroCones', () => {
    heroPineCone(env);
    heroSpruceCone(env);
  });
  step('squirrel', () => squirrelSite(env));
  step('cones', () => scatteredCones(env, n(LITTER.cones, 4)));
  step('flakes', () => barkFlakes(env, n(LITTER.flakes, 3)));
  if (!low) step('grit', () => grit(env, n(LITTER.grit)));
  step('leaves', () => birchLeaves(env, n(LITTER.oldLeaves, 8), n(LITTER.freshLeaves, 40)));
  if (!low) step('spruceNeedles', () => spruceNeedles(env, n(LITTER.spruceNeedles)));
  step('pineNeedles', () => pineNeedles(env, n(LITTER.pinePairs)));
  step('winter', () => winterSet(env));
  timing.ground = Math.round(timing.ground);

  return { fine: env.fine, near: env.near, wood: env.wood, leaves: env.leaves, winter: env.winter, winterNear: env.winterNear, lichen: env.lichen, lichenWinter: env.lichenWinter, lichenSites: env.lichenSites, lichenWinterSites: env.lichenWinterSites, decal: env.decal, anchors: env.anchors, counts: env.counts, timing, ms: now() - t0 };
}

const inside = (u, v, m = 0) => Math.abs(u) <= PATCH.halfL - m && Math.abs(v) <= PATCH.halfW - m;
const keepClear = (env, x, z, pad = 0) => env.keep.every((k) => dist2(x - k.x, z - k.z) > k.r + pad);

// ── the hero: a 60 cm fallen pine twig with beard lichen and Hypogymnia ──
function heroTwig(env) {
  env.sup.mk = REST.twig;
  const rng = new RNG(6060);
  const S = SPOTS.lichenTwig;
  const within = (x, z, pad = 0) => Math.hypot(toU(x, z) - S.u, toV(x, z) - S.v) <= S.r - pad && clearOthers(toU(x, z), toV(x, z)) > 0.004 && offTrail(toU(x, z), toV(x, z), pad);
  // main axis, thick broken base at the patch edge → thin tip toward the glide line
  const B0 = [1.1, -0.95];
  const E0 = [0.71, -0.63];
  const len = Math.hypot(E0[0] - B0[0], E0[1] - B0[1]);
  const pdir = Math.atan2(E0[1] - B0[1], E0[0] - B0[0]);
  const n = Math.ceil(len / 0.006);
  const main = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = 0.022 * Math.sin(Math.PI * t * 1.6 + 0.3);
    const u = B0[0] + (E0[0] - B0[0]) * t - Math.sin(pdir) * off;
    const v = B0[1] + (E0[1] - B0[1]) * t + Math.cos(pdir) * off;
    main.push({ x: wX(u, v), z: wZ(u, v), y: 0, r: 0.0015 + 0.0042 * Math.pow(1 - t, 0.8), t });
  }
  const knots = new Set();
  const whorls = [0.3, 0.64].map((t) => Math.round(t * n));
  for (const w of whorls) for (let k = -1; k <= 1; k++) knots.add(w + k);
  drape(main, env.sup, 0.18);
  const w = env.wood;
  w.begin('heroTwig', { contact: 'drape', maxSink: 0.0025 });
  const mainTube = twigTube(w, env, main, { rng, species: 'pine', lichen: true, bury: 1, brokenStart: true, knots });
  const hosts = [{ pts: main, fr: mainTube.fr, thin: 0.5 }];
  const parts = [main];
  const head = (i) => Math.atan2(main[Math.min(n, i + 1)].z - main[i].z, main[Math.min(n, i + 1)].x - main[i].x);
  // whorl branches: two lying left and right, one rising into the air
  const spec = [
    [whorls[0], 1, 0.78, 0.15, 0.0031, false],
    [whorls[0], -1, 0.92, 0.12, 0.0028, false],
    [whorls[0], 0, 0.55, 0.085, 0.0026, true],
    [whorls[1], 1, 0.82, 0.1, 0.0024, false],
    [whorls[1], -1, 0.7, 0.085, 0.0022, false],
    [whorls[1], 0, 0.62, 0.065, 0.002, true],
    [n - 1, 1, 0.55, 0.035, 0.0011, false],
    [n - 1, -1, 0.5, 0.03, 0.001, false],
    [Math.round(0.12 * n), 1, 1.2, 0.016, 0.0028, true],
    [Math.round(0.47 * n), -1, 1.3, 0.012, 0.0022, true],
  ];
  const tips = [];
  for (const [at, side, ang, blen, r0, raised] of spec) {
    const p0 = main[at];
    const h = head(at) + side * ang + rng.float(-0.1, 0.1);
    let pts = raised
      ? raisedPath(p0, head(at) + rng.float(-0.4, 0.4), blen < 0.02 ? 0.4 : rng.float(0.7, 0.95), blen, r0, blen < 0.02 ? r0 * 0.8 : 0.0006, env.sup)
      : path2D(rng, p0.x, p0.z, h, blen, r0, 0.0006);
    // stay inside the spot
    let cut = pts.findIndex((p) => !within(p.x, p.z, p.r));
    if (cut === 0) continue;
    if (cut > 0) pts = pts.slice(0, cut);
    if (pts.length < 3) continue;
    if (!raised) {
      pts[0].y = p0.y;
      drape(pts, env.sup, 0.18, true);
    }
    pts[0].x = p0.x;
    pts[0].z = p0.z;
    pts[0].y = p0.y;
    const stub = blen < 0.02;
    const tb = twigTube(w, env, pts, { rng, species: 'pine', bury: 1, brokenEnd: stub });
    parts.push(pts);
    if (!stub) hosts.push({ pts, fr: tb.fr, thin: 1 });
    if (raised && !stub) tips.push(pts[pts.length - 1]);
    // a twiglet on the lying branches
    if (!raised && blen > 0.08) {
      const at2 = Math.floor(pts.length * 0.5);
      const q = pts[at2];
      let tw = path2D(rng, q.x, q.z, h + side * 0.6, blen * 0.35, q.r * 0.7, 0.0004);
      cut = tw.findIndex((p) => !within(p.x, p.z, p.r));
      if (cut > 0) tw = tw.slice(0, cut);
      if (cut !== 0 && tw.length >= 3) {
        tw[0].y = q.y;
        drape(tw, env.sup, 0.18, true);
        Object.assign(tw[0], { x: q.x, y: q.y, z: q.z });
        const tb2 = twigTube(w, env, tw, { rng, species: 'pine', bury: 1 });
        parts.push(tw);
        hosts.push({ pts: tw, fr: tb2.fr, thin: 1 });
      }
    }
  }
  // Hypogymnia physodes rosettes hugging the thicker part
  const hypoRng = new RNG(6161);
  for (let k = 0; k < (env.low ? 2 : LITTER.rosettes); k++) {
    const f = hypoRng.float(0.06, 0.42) * n;
    hypogymnia(w, main, mainTube.fr, f, hypoRng.float(-1.2, 1.2), hypoRng.float(0.009, 0.014), hypoRng, env.low);
  }
  const twigSite = w.end().site; // what hangs on the twig goes under the snow with it
  for (const pts of parts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      if (a.y - a.r - env.sup.surf(a.x, a.z) < 0.01) env.sup.capsule(a, pts[i + 1], (a.r + pts[i + 1].r) * 0.5);
    }
    decalStrip(env.decal, env, pts, (p) => p.r * 3 + 0.003, 0.36 * env.decalK);
  }
  // beard lichen: pale Usnea tufts and a few dark Bryoria wisps, mostly on the thin outer half
  const lr = new RNG(6262);
  const tuft = (kind) => {
    const host = lr.chance(0.55) ? hosts[0] : hosts[1 + lr.int(0, hosts.length - 2)] ?? hosts[0];
    const np = host.pts.length;
    const f = host === hosts[0] ? lr.float(0.4, 0.97) * (np - 1) : lr.float(0.15, 0.9) * (np - 1);
    lichenTuft(env, host, f, lr.float(-1.7, 1.7), kind, lr, twigSite); // upper half and flanks: tufts on the underside would be crushed
  };
  for (let k = 0; k < LITTER.usnea; k++) tuft('usnea');
  for (let k = 0; k < LITTER.bryoria; k++) tuft('bryoria');
  // a few dead needle pairs still caught near the branch tips
  if (!env.low) {
    const nr = new RNG(6363);
    for (let k = 0; k < 14; k++) {
      const host = hosts[nr.int(0, hosts.length - 1)];
      const np = host.pts.length;
      const f = nr.float(0.7, 0.98) * (np - 1);
      attachedNeedles(env, host, f, nr, twigSite);
    }
  }
  env.anchors.heroTwigTips = tips.map((p) => new THREE.Vector3(p.x, p.y + p.r, p.z));
  env.counts.heroTwig = 1;
}

// Point and outward normal on a tube host at fractional ring index f and angle a.
function surfaceAt(host, f, a) {
  const { pts, fr } = host;
  const i = Math.min(pts.length - 2, Math.max(0, Math.floor(f)));
  const s = clamp(f - i);
  const p0 = pts[i];
  const p1 = pts[i + 1];
  const lerp = (x, y) => x + (y - x) * s;
  const N = norm3(lerp(fr.N[i][0], fr.N[i + 1][0]), lerp(fr.N[i][1], fr.N[i + 1][1]), lerp(fr.N[i][2], fr.N[i + 1][2]));
  const B = norm3(lerp(fr.B[i][0], fr.B[i + 1][0]), lerp(fr.B[i][1], fr.B[i + 1][1]), lerp(fr.B[i][2], fr.B[i + 1][2]));
  const T = norm3(lerp(fr.T[i][0], fr.T[i + 1][0]), lerp(fr.T[i][1], fr.T[i + 1][1]), lerp(fr.T[i][2], fr.T[i + 1][2]));
  const d = [N[0] * Math.cos(a) + B[0] * Math.sin(a), N[1] * Math.cos(a) + B[1] * Math.sin(a), N[2] * Math.cos(a) + B[2] * Math.sin(a)];
  const r = lerp(p0.r, p1.r);
  return { p: [lerp(p0.x, p1.x) + d[0] * r, lerp(p0.y, p1.y) + d[1] * r, lerp(p0.z, p1.z) + d[2] * r], d, T, r, N, B, c: [lerp(p0.x, p1.x), lerp(p0.y, p1.y), lerp(p0.z, p1.z)] };
}

// Hypogymnia physodes: inflated grey-green lobes radiating over the bark, black beneath, pale soralia at the tips.
function hypogymnia(g, pts, fr, f0, a0, radius, rng, low) {
  const host = { pts, fr };
  const nl = low ? 7 : rng.int(9, 12);
  const segLen = 0.0016;
  const ringLen = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y, pts[1].z - pts[0].z) || 0.006;
  for (let l = 0; l < nl; l++) {
    const psi0 = (l / nl) * TAU + rng.float(-0.25, 0.25);
    const branches = [[psi0, 0, radius * rng.float(0.7, 1)]];
    if (!low && rng.chance(0.7)) branches.push([psi0 + rng.float(0.2, 0.4), 0.55, radius * rng.float(0.5, 0.75)], [psi0 - rng.float(0.2, 0.4), 0.55, radius * rng.float(0.5, 0.75)]);
    for (const [psi, start, len] of branches) {
      const steps = Math.max(3, Math.round((len * (1 - start)) / segLen));
      const wid = rng.float(0.0016, 0.0024) * (start > 0 ? 0.8 : 1);
      const base = g.count;
      const across = low ? [-1, 0, 1] : [-1, -0.45, 0.45, 1];
      const sor = rng.chance(0.45);
      for (let s = 0; s <= steps; s++) {
        const q = start + (s / steps) * (1 - start);
        const lx = Math.cos(psi) * q * len;
        const ly = Math.sin(psi) * q * len;
        const tipK = q > 0.85 ? 1 - (q - 0.85) / 0.15 * 0.6 : 1;
        for (const x of across) {
          const ox = lx - Math.sin(psi) * x * wid * 0.5 * tipK;
          const oy = ly + Math.cos(psi) * x * wid * 0.5 * tipK;
          const sp = surfaceAt(host, f0 + ox / ringLen, a0 + oy / Math.max(0.002, surfaceAt(host, f0, a0).r));
          const infl = (1 - x * x) * wid * 0.42 * tipK + 0.00025 + (q > 0.9 ? 0.0004 : 0);
          const c = Math.abs(x) > 0.9 ? PAL.hypoDark : q > 0.82 ? (sor ? PAL.hypoSoralia : PAL.hypoTip) : mix3(PAL.hypoTop, mul3(PAL.hypoTop, 0.78), 1 - q);
          g.v(sp.p[0] + sp.d[0] * infl, sp.p[1] + sp.d[1] * infl, sp.p[2] + sp.d[2] * infl, sp.d[0], sp.d[1], sp.d[2], c, UV.plainU, UV.plainV, 1);
        }
      }
      const C = across.length;
      const i0 = g.i.length;
      const mid = surfaceAt(host, f0, a0).d;
      for (let s = 0; s < steps; s++) {
        for (let c = 0; c < C - 1; c++) {
          const a = base + s * C + c;
          const k = base + (s + 1) * C + c;
          g.triF(a, a + 1, k + 1, mid[0], mid[1], mid[2]);
          g.triF(a, k + 1, k, mid[0], mid[1], mid[2]);
        }
      }
      g.smoothNormals(base, g.count, i0, g.i.length);
    }
  }
}

// A beard-lichen tuft: three crossed ribbons that leave the bark and flop onto the ground.
function lichenTuft(env, host, f, a, kind, rng, hostSite = null) {
  const sp = surfaceAt(host, f, a);
  const v0 = env.lichen.count;
  const usnea = kind === 'usnea';
  const L = usnea ? rng.float(0.03, 0.055) : rng.float(0.045, 0.08);
  const W = usnea ? rng.float(0.018, 0.026) : rng.float(0.012, 0.018);
  const tint = usnea ? vary(rng, [1.0, 1.06, 0.7], 0.08, 0.04) : vary(rng, [0.34, 0.27, 0.21], 0.1, 0.05);
  const segs = 5;
  for (let k = 0; k < 3; k++) {
    let d = new THREE.Vector3(sp.d[0] + sp.T[0] * rng.float(-0.3, 0.6), sp.d[1] + 0.25, sp.d[2] + sp.T[2] * rng.float(-0.3, 0.6)).normalize();
    const p = new THREE.Vector3(sp.p[0], sp.p[1], sp.p[2]).addScaledVector(d, -0.001);
    const centers = [];
    const rights = [];
    const widths = [];
    const vs = [];
    const spin = (k / 3) * Math.PI + rng.float(-0.3, 0.3);
    const droop = usnea ? 0.35 : 0.75;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const gy = env.sup.surf(p.x, p.z) + 0.0006;
      if (p.y < gy) {
        p.y = gy;
        d.y = Math.max(d.y, 0);
        d.normalize();
      }
      const width = W * (0.4 + 0.6 * Math.sin(Math.min(1, t * 1.6 + 0.15) * Math.PI * 0.5)) * (1 - 0.25 * t);
      const side = new THREE.Vector3().crossVectors(d, UPV);
      if (side.lengthSq() < 1e-4) side.set(sp.T[0], sp.T[1], sp.T[2]);
      side.normalize().applyAxisAngle(d, spin);
      // where the tuft lies down, its ribbons flatten out instead of cutting into the ground
      const low = 1 - smoothstep(0.002, 0.02, p.y - gy);
      if (low > 0) {
        side.y *= 1 - low;
        side.normalize();
      }
      const c = p.clone();
      for (const sg of [-1, 1]) {
        const ex = c.x + side.x * width * 0.5 * sg;
        const ez = c.z + side.z * width * 0.5 * sg;
        const ey = c.y + side.y * width * 0.5 * sg;
        const need = env.sup.surf(ex, ez) + 0.0004 - ey;
        if (need > 0) c.y += need;
      }
      centers.push(c);
      rights.push(side);
      widths.push(width);
      vs.push(1 - t * 0.98);
      d.y -= droop / segs;
      d.normalize();
      p.addScaledVector(d, L / segs);
    }
    addStrip(env.lichen, centers, rights, widths, vs, { color: tint, sway: 0 });
  }
  let top = 0;
  for (let k = v0; k < env.lichen.count; k++) top = Math.max(top, env.lichen.pos[3 * k + 1] - env.ground.at(env.lichen.pos[3 * k], env.lichen.pos[3 * k + 2]));
  env.lichenSites.push([v0, env.lichen.count, hostSite ?? [toU(sp.p[0], sp.p[2]), toV(sp.p[0], sp.p[2]), top, 0]]);
  env.counts.lichenTufts = (env.counts.lichenTufts ?? 0) + 1;
}

function attachedNeedles(env, host, f, rng, hostSite = null) {
  const sp = surfaceAt(host, f, rng.float(0, TAU));
  const g = env.near;
  g.begin('twigNeedle', { contact: 'attached', maxSink: 0 });
  const col = vary(rng, rng.pick(PAL.needle.grey), 0.1, 0.04);
  for (let k = 0; k < 2; k++) {
    const d = norm3(sp.T[0] * 0.8 + sp.d[0] * 0.7 + rng.float(-0.2, 0.2) * (k ? 1 : -1), sp.T[1] * 0.8 + sp.d[1] * 0.7 + 0.2, sp.T[2] * 0.8 + sp.d[2] * 0.7 + rng.float(-0.2, 0.2));
    const len = rng.float(0.035, 0.055);
    const xs = [];
    const ys = [];
    const zs = [];
    const ws = [];
    const ph = [];
    const cols = [];
    const vs = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      let x = sp.p[0] + d[0] * len * t;
      let y = sp.p[1] + d[1] * len * t - 0.006 * t * t;
      let z = sp.p[2] + d[2] * len * t;
      y = Math.max(y, env.sup.surf(x, z) + 0.0007);
      xs.push(x);
      ys.push(y);
      zs.push(z);
      ws.push(0.0012 * (t > 0.7 ? 0.3 : 1));
      ph.push(rng.float(-0.6, 0.6));
      cols.push(col);
      vs.push(t);
    }
    ribbon(g, xs, ys, zs, [sp.d[0], sp.d[1], sp.d[2]], ws, ph, cols, UV.needle(k + 2, 0), UV.needle(k + 2, 1), vs, rng.float(0.6, 0.9));
  }
  const it = g.end();
  if (hostSite) {
    // caught on the twig: under the snow together with it
    it.site = hostSite;
    for (let k = it.v0; k < it.v1; k++) g.site.splice(k * 4, 4, hostSite[0], hostSite[1], hostSite[2], hostSite[3]);
  }
}

// ── the silk anchor: a small dead twig whose forked end rises to exactly SILK_TIP ──
// The dew module strings its spider-silk thread from this tip (agreed spot: clear of every other module).
export const SILK_TIP = { u: 0.76, v: -0.08, h: 0.035 };

function silkTwig(env) {
  env.sup.mk = REST.twig;
  const rng = new RNG(7070);
  const g = env.wood;
  const tx = wX(SILK_TIP.u, SILK_TIP.v);
  const tz = wZ(SILK_TIP.u, SILK_TIP.v);
  const tip = { x: tx, y: heroHeightAt(tx, tz) + SILK_TIP.h, z: tz };
  // the lying part runs below the tip, roughly along the glide
  const head = headingOf(Math.atan2(0.06, 0.16));
  const main = path2D(rng, wX(0.64, -0.15), wZ(0.64, -0.15), head, 0.17, 0.0024, 0.0008);
  drape(main, env.sup, 0.2);
  // fork where the lying twig passes ~3 cm short of the tip
  let at = 2;
  let best = Infinity;
  for (let i = 2; i < main.length - 3; i++) {
    const d = Math.abs(Math.hypot(main[i].x - tx, main[i].z - tz) - 0.032);
    if (d < best) {
      best = d;
      at = i;
    }
  }
  const p0 = main[at];
  // the raised branch: a gentle upward bow from the fork to the tip
  const up = [];
  const steps = 8;
  const cx = (p0.x + tx) * 0.5;
  const cz = (p0.z + tz) * 0.5;
  const cy = Math.max(p0.y, tip.y) - 0.004;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    const r = 0.0016 + (0.0006 - 0.0016) * Math.pow(t, 0.85);
    up.push({ x: a * p0.x + b * cx + c * tx, y: a * p0.y + b * cy + c * tip.y, z: a * p0.z + b * cz + c * tz, r, t });
  }
  for (const p of up) p.y = Math.max(p.y, env.sup.surf(p.x, p.z) + p.r);
  up[up.length - 1].y = tip.y;
  // lying up on the moss: buried before deep snow hides the moss shells (else it would float over the flat snow)
  const sb = env.ground.mossLift(main[0].x, main[0].z) > 0.002 ? 0.97 : 1;
  g.begin('twig', { contact: 'drape', maxSink: 0.0012 });
  twigTube(g, env, main, { rng, species: 'pine', bury: sb, brokenStart: true, brokenEnd: true });
  twigTube(g, env, up, { rng, species: 'pine', bury: sb });
  const s0 = main[Math.min(main.length - 2, at + 5)];
  const side = path2D(rng, s0.x, s0.z, head - 0.75, 0.045, 0.0011, 0.0004);
  drape(side, env.sup, 0.2, true);
  Object.assign(side[0], { x: s0.x, y: s0.y, z: s0.z });
  twigTube(g, env, side, { rng, species: 'pine', bury: sb });
  g.end();
  for (const pts of [main, side]) {
    for (let i = 0; i < pts.length - 1; i++) env.sup.capsule(pts[i], pts[i + 1], pts[i].r);
    decalStrip(env.decal, env, pts, (p) => p.r * 3 + 0.0025, 0.32 * env.decalK);
  }
  env.anchors.silkAnchor = new THREE.Vector3(tip.x, tip.y, tip.z);
  env.counts.silkTwig = 1;
}

function smallTwigs(env, count) {
  env.sup.mk = REST.twig;
  const rng = new RNG(3131);
  const f = env.field;
  let made = 0;
  let guard = 0;
  while (made < count && guard++ < count * 40) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    const dens = fadeUV(u, v) * (0.35 + 0.8 * f.pine(u, v));
    if (rng.next() * 1.3 > dens) continue;
    // twigs come down in little groups from the same dead branch
    const group = rng.int(1, 3);
    for (let k = 0; k < group && made < count; k++) {
      const cu = u + rng.gauss() * 0.05;
      const cv = v + rng.gauss() * 0.05;
      const len = 0.05 + 0.2 * Math.pow(rng.next(), 1.6);
      const r0 = 0.001 + 0.002 * Math.pow(rng.next(), 1.3) * (0.5 + len * 2.5);
      const pick = rng.next();
      const species = pick < 0.55 ? 'pine' : pick < 0.75 ? 'spruce' : pick < 0.9 ? 'birch' : 'grey';
      const ok = (x, z, r) => {
        const pu = toU(x, z);
        const pv = toV(x, z);
        return inside(pu, pv, 0.03) && clearOthers(pu, pv) > r + 0.006 && clearMine(pu, pv) > r + 0.01 && offTrail(pu, pv, r + 0.004);
      };
      const res = smallTwig(env, rng, {
        x: wX(cu, cv),
        z: wZ(cu, cv),
        head: rng.float(0, TAU),
        len,
        r0: Math.min(0.003, r0),
        species,
        lichen: species !== 'birch' && rng.chance(0.25),
        bury: clamp(0.45 + r0 * 120 + rng.float(0, 0.1), 0.45, 0.9),
        raise: 0.15,
        ok,
      });
      if (res) made++;
    }
  }
  env.counts.twigs = made;
}

// ── cones ──
function heroPineCone(env) {
  env.sup.mk = REST.cone;
  const rng = new RNG(8080);
  const S = SPOTS.pineCone;
  const geo = pineConeGeo(rng, { L: 0.052, R: 0.0135, N: 64, open: 0.62, age: 0.62, gib: 0.45, full: true });
  const x = wX(S.u, S.v);
  const z = wZ(S.u, S.v);
  const heading = headingOf(2.35);
  const it = placeRigid(env.wood, geo, env, { cat: 'cone', x: x - Math.cos(heading) * 0.026, z: z - Math.sin(heading) * 0.026, heading, roll: 0.9, pitches: [-0.2, -0.1, 0, 0.1, 0.2], com: [0, 0.022, 0], sink: 0.0018, aoH: 0.012, bury: 1 });
  env.keep.push({ x, z, r: 0.03 });
  decalBlob(env.decal, env, x, z, heading, 0.036, 0.024, 0.55 * env.decalK);
  env.anchors.pineCone = new THREE.Vector3(x, it.y + 0.03, z);
  env.counts.heroCone = 1;
}

function heroSpruceCone(env) {
  env.sup.mk = REST.cone;
  const rng = new RNG(8181);
  const S = SPOTS.spruceCone;
  const geo = spruceConeGeo(rng, { L: 0.122, N: env.low ? 100 : 150, ell: 0.021, W: 0.016, open: 0.75, age: 0.4, full: !env.low });
  const x = wX(S.u, S.v);
  const z = wZ(S.u, S.v);
  const heading = headingOf(-0.5);
  const it = placeRigid(env.wood, geo, env, { cat: 'cone', x: x - Math.cos(heading) * 0.058, z: z - Math.sin(heading) * 0.058, heading, roll: 0.4, pitches: [-0.12, -0.06, 0, 0.06, 0.12], com: [0, 0.055, 0], sink: 0.002, aoH: 0.014, bury: 1 });
  env.keep.push({ x, z, r: 0.07 });
  decalBlob(env.decal, env, x, z, heading, 0.075, 0.03, 0.5 * env.decalK);
  env.anchors.spruceCone = new THREE.Vector3(x, it.y + 0.035, z);
  env.counts.spruceCone = 1;
}

// The red squirrel's table: two gnawed spruce cores, a pine core, a scatter of scales and seed wings.
function squirrelSite(env) {
  const rng = new RNG(9090);
  const cx = wX(SQUIRREL.u, SQUIRREL.v);
  const cz = wZ(SQUIRREL.u, SQUIRREL.v);
  env.sup.mk = REST.scale;
  // the pile: scales stripped off one by one, overlapping (stacking stays within ~2 mm of the ground)
  const nScales = Math.round(LITTER.pileScales * Math.max(0.5, env.plants));
  for (let k = 0; k < nScales; k++) {
    // dense where the squirrel sat, a few flung further out
    const r = rng.chance(0.85) ? Math.abs(rng.gauss()) * 0.028 : rng.float(0.04, 0.1);
    const a = rng.float(0, TAU);
    const u = SQUIRREL.u + Math.cos(a) * r;
    const v = SQUIRREL.v + Math.sin(a) * r;
    if (clearOthers(u, v) < 0.015 || !offTrail(u, v, 0.012)) continue;
    const geo = looseScaleGeo(rng, !env.low);
    const x = wX(u, v);
    const z = wZ(u, v);
    const it = placeRigid(env.near, geo, env, { cat: 'scale', x, z, heading: rng.float(0, TAU), flat: true, tip: scaleTip(rng), sink: 0.0004, ao: false, bury: rng.float(0.08, 0.4) });
    env.sup.disc(x, z, 0.006, clamp(it.y + 0.0012 - env.sup.surf(x, z), 0, 0.0012));
  }
  env.sup.mk = REST.core;
  // the cores, dropped on top of the scales, side by side
  const cores = [
    ['spruce', 0.0, 0.0, 0.6, 0.1],
    ['spruce', 0.012, -0.052, 1.05, 0.096],
    ['pine', -0.06, 0.045, 3.3, 0.045],
  ];
  for (const [kind, du, dv, pa, L] of cores) {
    const geo = kind === 'spruce'
      ? spruceConeGeo(rng, { L, N: 120, ell: 0.018, W: 0.014, open: 0.3, strip: 0.86, age: rng.float(0.2, 0.7), full: !env.low })
      : pineConeGeo(rng, { L, R: 0.0125, N: 50, open: 0, strip: 0.8, age: 0.5, full: !env.low });
    const x = wX(SQUIRREL.u + du, SQUIRREL.v + dv);
    const z = wZ(SQUIRREL.u + du, SQUIRREL.v + dv);
    const heading = headingOf(pa);
    placeRigid(env.wood, geo, env, { cat: 'core', x: x - Math.cos(heading) * L * 0.5, z: z - Math.sin(heading) * L * 0.5, heading, roll: rng.float(0, TAU), pitches: [-0.1, 0, 0.1], com: [0, L * 0.5, 0], sink: 0.0012, aoH: 0.008, bury: 0.85 });
    env.keep.push({ x, z, r: L * 0.4 });
    decalBlob(env.decal, env, x, z, heading, L * 0.6, 0.012, 0.4 * env.decalK);
  }
  // seed wings: the squirrel ate the seeds and let the papery wings fall
  env.sup.mk = REST.scale;
  if (!env.low) {
    for (let k = 0; k < 8; k++) {
      const u = SQUIRREL.u + rng.gauss() * 0.05;
      const v = SQUIRREL.v + rng.gauss() * 0.05;
      if (clearOthers(u, v) < 0.01 || !offTrail(u, v, 0.01)) continue;
      const g = new Geo();
      const L = rng.float(0.011, 0.015);
      const W = L * 0.42;
      const col = vary(rng, PAL.seedWing, 0.1, 0.05);
      const pts = [[0, 0], [L * 0.25, -W * 0.5], [L * 0.7, -W * 0.55], [L, -W * 0.1], [L * 0.85, W * 0.35], [L * 0.3, W * 0.4]];
      for (const [px, pz] of pts) g.v(px, rng.float(0, 0.0003), pz, 0, 1, 0, px < L * 0.1 ? mul3(col, 0.5) : col, UV.flake(0.5), 0.3, 1);
      for (let q = 1; q < pts.length - 1; q++) g.triF(0, q, q + 1, 0, 1, 0);
      placeRigid(env.near, g, env, { cat: 'scale', x: wX(u, v), z: wZ(u, v), heading: rng.float(0, TAU), flat: true, sink: 0, ao: false, bury: rng.float(0.05, 0.2) });
    }
  }
  env.keep.push({ x: cx, z: cz, r: 0.05 });
  env.counts.squirrelCores = cores.length;
  env.counts.pileScales = nScales;
}

function scatteredCones(env, count) {
  env.sup.mk = REST.cone;
  const rng = new RNG(8282);
  const f = env.field;
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 80) {
    const u = rng.float(-PATCH.halfL + 0.1, PATCH.halfL - 0.1);
    const v = rng.float(-PATCH.halfW + 0.1, PATCH.halfW - 0.1);
    const dens = fadeUV(u, v) * (0.2 + 1.1 * f.pine(u, v) + 0.4 * smoothstep(0.0005, 0.004, f.hollow(u, v)));
    if (rng.next() * 1.4 > dens) continue;
    const L = rng.float(0.04, 0.06);
    const R = L * rng.float(0.24, 0.29);
    const type = rng.next();
    const open = type < 0.6 ? rng.float(0.55, 1) : type < 0.85 ? rng.float(0.2, 0.5) : 0;
    const foot = open > 0.4 ? L * 0.55 : L * 0.5;
    if (clearOthers(u, v) < foot + 0.01 || clearMine(u, v) < foot + 0.01 || !offTrail(u, v, foot + 0.005)) continue;
    const x = wX(u, v);
    const z = wZ(u, v);
    if (!keepClear(env, x, z, foot) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < 0.07)) continue;
    // not on a twig: the cone's whole footprint (axis ± its opened radius) must be clear
    const heading = rng.float(0, TAU);
    const hx = Math.cos(heading) * L * 0.55;
    const hz = Math.sin(heading) * L * 0.55;
    if (env.sup.nearCapsule(x - hx, z - hz, x + hx, z + hz, R * (1.2 + open * 0.8) + 0.002)) continue;
    const geo = pineConeGeo(rng, { L, R, N: Math.round(56 + 18 * rng.next()), open, age: rng.float(0.3, 0.95), full: !env.low });
    const it = placeRigid(env.wood, geo, env, { cat: 'cone', x: x - Math.cos(heading) * L * 0.45, z: z - Math.sin(heading) * L * 0.45, heading, roll: rng.float(0, TAU), pitches: [-0.15, -0.05, 0.05, 0.15], com: [0, L * 0.42, 0], sink: rng.float(0.001, 0.0025), aoH: 0.01, bury: 1 });
    placed.push({ x, z });
    env.keep.push({ x, z, r: foot * 0.75 });
    decalBlob(env.decal, env, x, z, heading, L * 0.7, R * (1.6 + open * 0.8), 0.5 * env.decalK);
    if (!env.anchors.cones) env.anchors.cones = [];
    env.anchors.cones.push(new THREE.Vector3(x, it.y + R * 2, z));
  }
  env.counts.cones = placed.length;
}

// ── bark flakes: the hero cluster and a few strays from the pines ──
function barkFlakes(env, count) {
  env.sup.mk = REST.flake;
  const rng = new RNG(5151);
  const S = SPOTS.barkFlakes;
  const list = [];
  for (let k = 0; k < (env.low ? 7 : 11); k++) {
    const r = Math.sqrt(rng.next()) * (S.r - 0.03);
    const a = rng.float(0, TAU);
    list.push({ u: S.u + Math.cos(a) * r, v: S.v + Math.sin(a) * r, len: rng.float(0.012, 0.042), chunk: k < 2 });
  }
  const f = env.field;
  let guard = 0;
  let strays = 0;
  while (strays < count && guard++ < count * 60) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    if (rng.next() * 1.2 > fadeUV(u, v) * (0.15 + f.pine(u, v))) continue;
    if (clearOthers(u, v) < 0.03 || clearMine(u, v) < 0.03 || !offTrail(u, v, 0.03)) continue;
    list.push({ u, v, len: rng.float(0.01, 0.035), chunk: false });
    strays++;
  }
  let made = 0;
  for (const fl of list) {
    const x = wX(fl.u, fl.v);
    const z = wZ(fl.u, fl.v);
    if (!keepClear(env, x, z, fl.len * 0.5)) continue;
    // flakes lie on the ground or on each other, never perched on a twig
    const reach = fl.chunk ? 0.025 : fl.len * 0.55;
    if (env.sup.nearCapsule(x, z, x, z, reach)) continue;
    made++;
    const geo = fl.chunk
      ? flakeGeo(rng, { len: rng.float(0.025, 0.045), thick: rng.float(0.003, 0.006), outer: PAL.chunkTop, bury: rng.float(0.25, 0.45) })
      : flakeGeo(rng, { len: fl.len, bury: rng.float(0.1, 0.4) });
    const it = placeRigid(env.near, geo, env, { cat: 'flake', x, z, heading: rng.float(0, TAU), flat: true, tip: [rng.float(-0.15, 0.15), rng.float(-0.15, 0.15)], sink: fl.chunk ? 0.0012 : 0.0001, ao: false });
    env.sup.disc(x, z, fl.len * 0.3, clamp(it.y + 0.0008 - env.sup.surf(x, z), 0, 0.0013));
    if (fl.chunk) decalBlob(env.decal, env, x, z, 0, fl.len * 0.7, fl.len * 0.55, 0.35 * env.decalK);
  }
  env.counts.flakes = made;
}

// ── granite grit, in a few mineral-soil spots and a sparse sprinkle ──
function grit(env, count) {
  env.sup.mk = REST.grit;
  const rng = new RNG(4242);
  const clusters = [];
  while (clusters.length < 5) {
    const u = rng.float(-1.5, 1.5);
    const v = rng.float(-0.8, 0.8);
    if (clearOthers(u, v) > 0.06 && clearMine(u, v) > 0.04 && offTrail(u, v, 0.08)) clusters.push([u, v]);
  }
  let made = 0;
  let guard = 0;
  while (made < count && guard++ < count * 30) {
    let u;
    let v;
    if (rng.chance(0.6)) {
      const c = rng.pick(clusters);
      u = c[0] + rng.gauss() * 0.05;
      v = c[1] + rng.gauss() * 0.05;
    } else {
      u = rng.float(-PATCH.halfL, PATCH.halfL);
      v = rng.float(-PATCH.halfW, PATCH.halfW);
    }
    if (rng.next() > fadeUV(u, v)) continue;
    const size = 0.003 + 0.012 * Math.pow(rng.next(), 2.2);
    if (env.ground.mossLift(wX(u, v), wZ(u, v)) > 0.0008) continue; // grit shows only on bare humus
    if (clearOthers(u, v) < size || clearMine(u, v) < size || !offTrail(u, v, size)) continue;
    const x = wX(u, v);
    const z = wZ(u, v);
    if (!keepClear(env, x, z, size)) continue;
    const geo = pebbleGeo(rng, size, size > 0.009 ? 2 : 1);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.float(-0.3, 0.3), rng.float(0, TAU), rng.float(-0.3, 0.3)));
    const m = _m4.makeRotationFromQuaternion(q).elements.slice();
    const off = restOffset(geo, m, x, z, env.ground);
    // embedded in the humus by a third of its height
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let k = 0; k < geo.count; k++) {
      const y = m[1] * geo.p[3 * k] + m[5] * geo.p[3 * k + 1] + m[9] * geo.p[3 * k + 2];
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
    const sink = (ymax - ymin) * rng.float(0.2, 0.4);
    env.fine.begin('grit', { contact: 'rest', maxSink: sink + 0.001 });
    env.fine.append(geo, m, x, off - sink, z, { colFn: (c, wx, wy, wz) => mul3(c, 0.6 + 0.4 * smoothstep(-0.0005, size * 0.4, wy - env.ground.at(wx, wz))), bury: rng.float(0.01, 0.25) });
    env.fine.end();
    made++;
  }
  env.counts.grit = made;
}

// ── birch leaves ──
function birchLeaves(env, nOld, nFresh) {
  env.sup.mk = REST.leaf;
  const rng = new RNG(2727);
  const f = env.field;
  // r: the leaf quad's reach from its centre (corners included)
  const allowed = (u, v, r) => inside(u, v, r) && clearHard(u, v) > r && clearMine(u, v) > r * 0.6 && offTrail(u, v, r);
  let made = 0;
  const place = (fresh, count) => {
    env.sup.mk = fresh ? REST.leaf : REST.oldLeaf; // last year's leaves lie pressed into the moss
    let k = 0;
    let guard = 0;
    while (k < count && guard++ < count * 60) {
      const u = rng.float(-PATCH.halfL, PATCH.halfL);
      const v = rng.float(-PATCH.halfW, PATCH.halfW);
      let dens = fadeUV(u, v) * (0.3 + 0.8 * smoothstep(0.0003, 0.004, f.hollow(u, v)) + 0.3 * (0.5 + 0.5 * noise2(u * 3 + 9, v * 3)));
      if (inMoss(u, v)) dens *= 0.5;
      if (rng.next() * 1.4 > dens) continue;
      const group = rng.int(1, fresh ? 4 : 2);
      for (let q = 0; q < group && k < count; q++) {
        const pu = u + rng.gauss() * 0.035;
        const pv = v + rng.gauss() * 0.035;
        const blade = rng.float(0.032, 0.058);
        const size = blade / 0.7;
        if (!allowed(pu, pv, size * 0.76)) continue;
        const x = wX(pu, pv);
        const z = wZ(pu, pv);
        if (!keepClear(env, x, z, size * 0.5)) continue;
        let cell;
        let col;
        if (fresh) {
          cell = 0;
          col = vary(rng, rng.pick(PAL.leafFresh), 0.08, 0.05);
        } else {
          const p = rng.next();
          cell = p < 0.5 ? 1 : p < 0.78 ? 2 : 3;
          col = cell === 2 ? vary(rng, PAL.leafSkeleton, 0.08) : vary(rng, rng.pick(PAL.leafOld), 0.1, 0.05);
        }
        env.leaves.begin(fresh ? 'leaf' : 'oldLeaf', { contact: 'drape', maxSink: 0.0005 });
        leaf(env.leaves, env, rng, {
          x,
          z,
          dir: rng.float(0, TAU),
          size,
          cell,
          col,
          curlX: fresh ? rng.float(0.02, 0.09) : rng.float(0.0, 0.015),
          curlZ: fresh ? rng.float(0.0, 0.12) : rng.float(0, 0.02),
          lift: fresh ? 0.0013 : 0.0002,
          fresh: fresh ? rng.float(0.02, 1) : 0,
          bury: fresh ? rng.float(0.1, 0.4) : rng.float(0.15, 0.5),
          decay: fresh ? 0 : rng.float(0.5, 1),
        });
        env.leaves.end();
        k++;
        made++;
      }
    }
    return k;
  };
  env.counts.oldLeaves = place(false, nOld);
  env.counts.freshLeaves = place(true, nFresh);
}

// ── needles ──
function needleAllowed(u, v) {
  return inside(u, v, 0.005) && clearHard(u, v) > 0.007;
}

function spruceNeedles(env, count) {
  env.sup.mk = REST.needle;
  const rng = new RNG(1717);
  const f = env.field;
  let made = 0;
  let guard = 0;
  while (made < count && guard++ < count * 20) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    let dens = fadeUV(u, v) * (0.45 + 0.4 * f.spruce(u, v) + 0.5 * smoothstep(0.0003, 0.004, f.hollow(u, v)));
    if (inMoss(u, v)) dens *= 0.35;
    if (rng.next() * 1.4 > dens) continue;
    const len = rng.float(0.015, 0.025);
    const dir = rng.float(0, TAU);
    const x = wX(u, v);
    const z = wZ(u, v);
    const ex = x + Math.cos(dir) * len;
    const ez = z + Math.sin(dir) * len;
    if (!needleAllowed(u, v) || !needleAllowed(toU(ex, ez), toV(ex, ez)) || !keepClear(env, x, z)) continue;
    // not lying wholly on a twig
    let low = Infinity;
    for (const t of [0, 0.55, 1]) {
      const px = x + Math.cos(dir) * len * t;
      const pz = z + Math.sin(dir) * len * t;
      low = Math.min(low, env.sup.at(px, pz, 0.15) - env.sup.surf(px, pz));
    }
    if (low > 0.0011) continue;
    const pick = rng.next();
    const col = vary(rng, PAL.spruce[pick < 0.25 ? 0 : pick < 0.5 ? 1 : pick < 0.85 ? 2 : 3], 0.1, 0.04);
    env.fine.begin('spruceNeedle', { contact: 'drape', maxSink: 0.0004 });
    spruceNeedle(env.fine, env, { x, z, dir, len, w: rng.float(0.0009, 0.0012), lift: 0.0004 + rng.float(0, 0.0005), col, uvCol: rng.int(0, 7), bury: rng.float(0.02, 0.3) });
    env.fine.end();
    made++;
  }
  env.counts.spruceNeedles = made;
}

function pineNeedles(env, count) {
  env.sup.mk = REST.needle;
  const rng = new RNG(2525);
  const f = env.field;
  // layering: needles that land where others already lie sit a little higher
  const occ = new Map();
  const oc = 0.015;
  const okey = (x, z) => Math.floor(x / oc) * 100003 + Math.floor(z / oc);
  const density = (u, v) => {
    const fade = fadeUV(u, v);
    if (fade <= 0) return 0;
    const hol = smoothstep(0.0003, 0.004, f.hollow(u, v));
    const streak = smoothstep(0.35, 0.75, 0.5 + 0.5 * noise2(u * 2.2 + v * 0.9 + 7.1, v * 5.5 - u * 1.3 - 3.3));
    const blotch = 0.5 + 0.5 * noise2(u * 6 + 3.3, v * 6 - 1.7);
    let d = 0.16 + 0.6 * hol + 0.45 * f.pine(u, v) + 0.35 * streak * blotch;
    if (inMoss(u, v)) d *= 0.35;
    // needles build a mat on bare duff; on the moss carpet only the recent fall still lies on top
    d *= 1.25 - 0.55 * smoothstep(0.002, 0.01, env.ground.mossLift(wX(u, v), wZ(u, v)));
    d *= 0.4 + 0.6 * smoothstep(0.006, 0.02, distToTrail(u, v)); // the ants keep their road clear
    return d * fade * smoothstep(0, 0.02, clearHard(u, v));
  };
  const P = PAL.needle;
  let pairs = 0;
  let singles = 0;
  let guard = 0;
  while (pairs + singles < count && guard++ < count * 25) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    const d = density(u, v);
    if (rng.next() * 1.6 > d) continue;
    // a clump: needles shed together lie together and age together
    const nClump = 1 + Math.floor(Math.pow(rng.next(), 2.2) * 7);
    const cr = 0.01 + rng.next() * 0.035;
    const hol = smoothstep(0.0003, 0.004, f.hollow(u, v));
    const r = rng.next();
    const wFresh = 0.16;
    const wTan = 0.34;
    const wGrey = 0.3 - 0.1 * hol;
    const wDark = 0.12 + 0.25 * hol;
    const fam = r < wFresh ? P.fresh : r < wFresh + wTan ? P.tan : r < wFresh + wTan + wGrey ? P.grey : r < wFresh + wTan + wGrey + wDark ? P.dark : P.bleached;
    const head = rng.float(0, Math.PI);
    for (let k = 0; k < nClump && pairs + singles < count; k++) {
      const pu = u + rng.gauss() * cr;
      const pv = v + rng.gauss() * cr;
      if (density(pu, pv) < 0.02) continue;
      const x = wX(pu, pv);
      const z = wZ(pu, pv);
      if (!keepClear(env, x, z, 0.004)) continue;
      const dir = rng.chance(0.5) ? head + rng.gauss() * 0.35 : rng.float(0, TAU);
      const kind = rng.next();
      const single = kind < 0.12;
      const broken = kind > 0.94;
      const spread = rng.chance(0.5) ? rng.float(0.03, 0.17) : rng.chance(0.7) ? rng.float(0.17, 0.6) : rng.float(0.6, 1.2);
      const len = (broken ? rng.float(0.018, 0.035) : rng.float(0.04, 0.07)) * (single ? rng.float(0.8, 1) : 1);
      // both tips must stay out of other modules' spots
      let ok = needleAllowed(pu, pv);
      for (const s of single ? [0] : [-0.5, 0.5]) {
        for (const t of [0.5, 1]) {
          const ex = x + Math.cos(dir + s * spread) * len * t;
          const ez = z + Math.sin(dir + s * spread) * len * t;
          if (!needleAllowed(toU(ex, ez), toV(ex, ez)) || !keepClear(env, ex, ez, 0.002)) ok = false;
        }
      }
      if (!ok) continue;
      // nor bridge off the edge of a moss shelf
      const s0 = env.sup.surf(x, z);
      if (Math.abs(env.sup.surf(x + Math.cos(dir) * len, z + Math.sin(dir) * len) - s0) > 0.004) continue;
      const key = okey(x, z);
      const stack = Math.min(2, occ.get(key) ?? 0);
      occ.set(key, (occ.get(key) ?? 0) + 1);
      const lift = Math.min(0.0014, 0.00055 + stack * 0.00034 + rng.float(0, 0.00015) + (env.ground.mossLift(x, z) > 0.002 ? 0.0002 : 0)); // moss: ride over the shell creases
      const base = vary(rng, rng.pick(fam), 0.09, 0.04);
      const bury = rng.float(0.04, 0.38);
      const w = rng.float(0.00105, 0.0014);
      const sh = !single || rng.chance(0.4);
      const plans = [];
      for (const s of single ? [0] : [-0.5, 0.5]) {
        const a = dir + s * spread;
        const off = single ? 0 : s * w * 0.9;
        plans.push(needlePlan(env, {
          x: x - Math.sin(dir) * off,
          z: z + Math.cos(dir) * off,
          dir: a,
          len: len * rng.float(0.93, 1.0),
          w,
          curve: rng.float(-0.005, 0.005),
          phi0: rng.float(-0.35, 0.35),
          phiRate: rng.float(-0.9, 0.9),
          lift,
          tipLift: rng.chance(0.15) ? rng.float(0.0006, 0.0025) : 0,
          col: mul3(base, rng.float(0.94, 1.06)),
          bleachTip: fam === P.grey && rng.chance(0.4),
          uvCol: rng.int(0, 7),
          broken,
          bury,
        }));
      }
      if (plans.some((pl) => pl.low > 0.0017)) continue; // would lie wholly on a twig: let it fall elsewhere
      env.fine.begin(single ? 'pineSingle' : 'pinePair', { contact: 'drape', maxSink: 0.0004 }); // may nestle a little into moss shoots
      for (const pl of plans) needleEmit(env.fine, env, pl);
      if (sh) sheath(env.fine, env, x, z, dir, rng.float(0.0025, 0.004), w * 1.35, vary(rng, PAL.sheath, 0.1), bury, lift);
      env.fine.end();
      if (single) singles++;
      else pairs++;
    }
  }
  env.counts.pinePairs = pairs;
  env.counts.pineSingles = singles;
}

// ═════════════════════════════════════════════════════════════
// Winter: what fell after the last snowfall, lying on the snow
// ═════════════════════════════════════════════════════════════
// A January floor under pine and spruce is far from blank: fresh green and brown needles, spruce shoot tips
// the red squirrels snipped for their buds, scraps of beard lichen, bark flakes, birch seeds and catkin scales
// (tiny brown "birds"), a few cones and the squirrel's fresh midden of scales and stripped cores.
// All of it is built at floor level. The vertex shader lifts every piece onto the white surface that is
// actually drawn: on bare ground the floor's own snow, on moss the snow that fills the moss shells from
// below (the moss module's formula), until deep snow buries the shells and the floor's snow takes over.

const WIND = (() => {
  // the prevailing westerly carries everything a little east of the crowns (patch frame, unit)
  const wx = 0.8;
  const wz = -0.6;
  const u = wx * PUX + wz * PUZ;
  const v = wx * PVX + wz * PVZ;
  const l = Math.hypot(u, v);
  return { u: u / l, v: v / l };
})();

// Moss snow data for one point: [moss cover, snow-depth noise] as the moss shells see it (0 without moss).
let MOSS_SNOW_MAP = null;
function mossSnowAt(u, v) {
  if (!MOSS_API?.mossCover || !MOSS_API?.mossMapData) return [0, 0.5];
  const W = MOSS_API.MAP_W;
  const H = MOSS_API.MAP_H;
  MOSS_SNOW_MAP ??= MOSS_API.mossMapData();
  const fs = clamp((u / (2 * PATCH.halfL) + 0.5) * W - 0.5, 0, W - 1.001);
  const ft = clamp((v / (2 * PATCH.halfW) + 0.5) * H - 0.5, 0, H - 1.001);
  const i = Math.floor(fs);
  const j = Math.floor(ft);
  const a = fs - i;
  const b = ft - j;
  const A = (q) => MOSS_SNOW_MAP[q * 4 + 3] / 255;
  const k = j * W + i;
  const sn = (A(k) * (1 - a) + A(k + 1) * a) * (1 - b) + (A(k + W) * (1 - a) + A(k + W + 1) * a) * b;
  return [clamp(MOSS_API.mossCover(u, v)), sn];
}

// How much winter litter lands at (u, v): under the crowns, shifted downwind, in wind-drawn streaks.
function winterDensity(env, u, v, birchK = 0) {
  const f = env.field;
  const su = u - WIND.u * 0.7;
  const sv = v - WIND.v * 0.7;
  let crown = 0;
  for (const t of f.pines) crown += Math.exp(-((su - t.u) ** 2 + (sv - t.v) ** 2) / (2 * 2.3 * 2.3)) * t.s;
  for (const t of f.spruces) crown += 1.3 * Math.exp(-((su - t.u) ** 2 + (sv - t.v) ** 2) / (2 * 2.2 * 2.2)) * t.s;
  for (const t of f.birches) crown += birchK * Math.exp(-((su - t.u) ** 2 + (sv - t.v) ** 2) / (2 * 3.0 * 3.0)) * t.s;
  const along = u * WIND.u + v * WIND.v;
  const across = -u * WIND.v + v * WIND.u;
  const streak = smoothstep(0.15, 0.75, 0.5 + 0.5 * noise2(along * 1.1 + 4.2, across * 5.5 - 1.3));
  const blotch = 0.5 + 0.5 * noise2(u * 3.3 - 7.7, v * 3.3 + 2.1);
  return fadeUV(u, v) * (0.12 + crown) * (0.3 + 0.9 * streak) * (0.6 + 0.6 * blotch);
}

// A spruce shoot tip snipped by a squirrel: an orange-brown twig densely set with green needles that splay
// against the snow (local: lying along +x on y = 0, the snow).
function spruceShootGeo(rng, len) {
  const g = new Geo();
  const r0 = rng.float(0.0011, 0.0015);
  const lift = 0.0045; // the shoot rests on its lower needles
  const n = Math.max(4, Math.ceil(len / 0.006));
  const pts = [];
  const bend = rng.float(-1, 1) * 0.6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: t * len, y: lift + 0.0015 * Math.sin(t * Math.PI), z: bend * t * t * len * 0.15, r: r0 * (1 - 0.45 * t), t });
  }
  const bark = vary(rng, lin(168, 108, 62), 0.08, 0.04);
  const fr = tube(g, pts, { radial: 5, u0: UV.bark(0), uw: 63 / AT, vRep: 0.05, col: () => bark });
  capRing(g, fr, 0, 5, vary(rng, PAL.woodEnd, 0.06), 1, 0.2, 0.3, rng); // the bitten end
  // needles, spiralling round the shoot, leaning toward its tip; this year's growth is lighter.
  // Each is a ridged ribbon ~1 mm wide facing up: four-sided needles look about as wide from every side.
  const dark = lin(46, 74, 40);
  const light = lin(78, 108, 52);
  const nN = Math.round(len * 1500);
  for (let k = 0; k < nN; k++) {
    const t = 0.03 + 0.95 * (k / nN);
    const i = Math.min(n - 1, Math.floor(t * n));
    const p = pts[i];
    const a = k * GA + rng.float(-0.2, 0.2);
    const nl = rng.float(0.012, 0.019) * (1 - 0.35 * smoothstep(0.75, 1, t));
    const lean = rng.float(0.55, 0.95); // angle from the shoot axis
    const dx = Math.cos(lean);
    const dy = Math.sin(lean) * Math.cos(a);
    const dz = Math.sin(lean) * Math.sin(a);
    const bx = p.x;
    const by = p.y + dy * p.r;
    const bz = p.z + dz * p.r;
    let tx = bx + dx * nl;
    let ty = by + dy * nl;
    let tz = bz + dz * nl;
    if (ty < 0.0005) {
      // pressed against the snow: the needle splays out flat
      const k2 = (by - 0.0005) / Math.max(1e-5, by - ty);
      const fl = nl * (1 - k2);
      tx = bx + dx * nl * k2 + dx * fl * 0.9;
      tz = bz + dz * nl * k2 + Math.sign(dz || 1) * fl * 0.45;
      ty = 0.0005;
    }
    const c = mix3(vary(rng, dark, 0.12, 0.05), light, smoothstep(0.55, 0.95, t) * 0.8);
    const D = norm3(tx - bx, ty - by, tz - bz);
    let R = cross3(D, [0, 1, 0]);
    if (Math.hypot(...R) < 0.2) R = [0, 0, 1];
    R = norm3(...R);
    const F = cross3(R, D); // the face, mostly up
    const v0 = g.count;
    for (const [q, wq, tone] of [[0, 0.75, 0.75], [0.6, 1, 1], [1, 0.12, 1]]) {
      const x = bx + (tx - bx) * q;
      const y = by + (ty - by) * q;
      const z = bz + (tz - bz) * q;
      const hw = 0.0005 * wq;
      const cc = mul3(c, tone);
      const nl0 = norm3(F[0] - R[0], F[1] - R[1], F[2] - R[2]);
      const nr0 = norm3(F[0] + R[0], F[1] + R[1], F[2] + R[2]);
      g.v(x - R[0] * hw, y - R[1] * hw, z - R[2] * hw, nl0[0], nl0[1], nl0[2], cc, UV.needle(2, 0), q, 1);
      g.v(x + F[0] * hw * 0.8, y + F[1] * hw * 0.8, z + F[2] * hw * 0.8, F[0], F[1], F[2], mul3(cc, 1.08), UV.needle(2, 0.5), q, 1);
      g.v(x + R[0] * hw, y + R[1] * hw, z + R[2] * hw, nr0[0], nr0[1], nr0[2], cc, UV.needle(2, 1), q, 1);
    }
    for (let r = 0; r < 2; r++) {
      const q0 = v0 + r * 3;
      g.triF(q0, q0 + 1, q0 + 4, F[0], F[1], F[2]);
      g.triF(q0, q0 + 4, q0 + 3, F[0], F[1], F[2]);
      g.triF(q0 + 1, q0 + 2, q0 + 5, F[0], F[1], F[2]);
      g.triF(q0 + 1, q0 + 5, q0 + 4, F[0], F[1], F[2]);
    }
  }
  // the buds the squirrel was after: often eaten, sometimes still there
  if (rng.chance(0.4)) {
    const tip = pts[n];
    const bud = [{ x: tip.x, y: tip.y, z: tip.z, r: 0.0012 }, { x: tip.x + 0.0025, y: tip.y, z: tip.z, r: 0.0013 }, { x: tip.x + 0.005, y: tip.y, z: tip.z, r: 0.0002 }];
    tube(g, bud, { radial: 5, u0: UV.plainU, uw: 0, col: () => lin(122, 74, 44) });
  }
  return g;
}

// Birch catkin scale (three-lobed, like a tiny bird) or winged seed, ~3 mm (local, flat on y = 0).
function birchBitGeo(rng, seed) {
  const g = new Geo();
  const sc = rng.float(0.85, 1.2) * 0.001;
  const outline = seed
    ? [[0, -0.6], [0.7, -0.9], [1.7, -0.4], [2.0, 0.4], [1.3, 1.0], [0.35, 0.9], [0.2, 1.4], [-0.2, 1.4], [-0.35, 0.9], [-1.3, 1.0], [-2.0, 0.4], [-1.7, -0.4], [-0.7, -0.9]]
    : [[0, -1.1], [0.55, -0.6], [1.8, 0.2], [1.5, 0.75], [0.55, 0.55], [0.4, 1.3], [-0.4, 1.3], [-0.55, 0.55], [-1.5, 0.75], [-1.8, 0.2], [-0.55, -0.6]];
  const body = seed ? lin(92, 62, 40) : vary(rng, lin(128, 92, 58), 0.1, 0.04);
  const wing = seed ? vary(rng, lin(176, 146, 108), 0.08) : body;
  const c0 = g.v(0, 0.00015, 0, 0, 1, 0, body, UV.plainU, UV.plainV, 1);
  for (const [x, z] of outline) {
    const far = Math.hypot(x, z) > 0.9;
    g.v(x * sc, 0, z * sc, 0, 1, 0, far ? wing : mix3(body, wing, 0.4), UV.plainU, UV.plainV, 1);
  }
  for (let k = 0; k < outline.length; k++) g.triF(c0, c0 + 1 + k, c0 + 1 + ((k + 1) % outline.length), 0, 1, 0);
  return g;
}

function winterSet(env) {
  const rng = new RNG(1212);
  const sup = new Supports(env.ground); // winter litter lies on the snow, not on last summer's twigs
  const wenv = { ...env, sup };
  const W = env.winter;
  const WN = env.winterNear;
  const plants = env.plants;
  const ok = (u, v, r) => inside(u, v, r) && clearOthers(u, v) > r && clearMine(u, v) > r * 0.5 && offTrail(u, v, r);
  const okFlat = (u, v, r) => inside(u, v, r) && clearHard(u, v) > r && offTrail(u, v, r * 0.5);
  const okMidden = (u, v, r) => inside(u, v, r) && clearOthers(u, v) > r && offTrail(u, v, r);
  // [winter level it appears at, moss cover, moss snow noise, snow cap 0 … 1]
  const tag = (u, v, appear, cap = 0) => {
    const [c, sn] = mossSnowAt(u, v);
    return [clamp(appear, 0.004, 1), c, sn, cap];
  };
  const pick = (birchK, tries = 60) => {
    for (let t = 0; t < tries; t++) {
      const u = rng.float(-PATCH.halfL, PATCH.halfL);
      const v = rng.float(-PATCH.halfW, PATCH.halfW);
      if (rng.next() * 1.6 < winterDensity(env, u, v, birchK)) return [u, v];
    }
    return null;
  };
  const counts = {};
  const n = (b, min = 0) => Math.max(min, Math.round(b * plants));

  // ── the squirrel's fresh midden on the snow: beside its summer table, on the clearing ──
  {
    const mu = SQUIRREL.u - 0.03;
    const mv = SQUIRREL.v - 0.1;
    let scales = 0;
    for (let k = 0; k < n(170, 70); k++) {
      const r = rng.chance(0.8) ? Math.abs(rng.gauss()) * 0.04 : rng.float(0.05, 0.14);
      const a = rng.float(0, TAU);
      const u = mu + Math.cos(a) * r * 1.2;
      const v = mv + Math.sin(a) * r;
      if (!okMidden(u, v, 0.012)) continue;
      const g = looseScaleGeo(rng, !env.low, { fresh: true });
      const x = wX(u, v);
      const z = wZ(u, v);
      const it = placeRigid(W, g, wenv, { cat: 'wScale', x, z, heading: rng.float(0, TAU), flat: true, tip: scaleTip(rng), sink: 0.0008, ao: false, bury: tag(u, v, rng.float(0.02, 0.35), 0) });
      sup.disc(x, z, 0.006, clamp(it.y + 0.001 - env.ground.at(x, z), 0, 0.0012));
      scales++;
    }
    counts.midden = scales;
    const cores = [
      ['spruce', 0.03, 0.02, 1.2, 0.098, 0.88],
      ['spruce', -0.05, -0.03, 2.6, 0.09, 0.9],
      ['spruce', 0.07, -0.06, 0.2, 0.11, 0.45], // dropped half-eaten
    ];
    for (const [kind, du, dv, pa, L, strip] of cores) {
      const u = mu + du;
      const v = mv + dv;
      if (!okMidden(u, v, L * 0.55)) continue;
      const geo = spruceConeGeo(rng, { L, N: 120, ell: 0.018, W: 0.014, open: 0.25, strip, age: 0.05, full: !env.low });
      const x = wX(u, v);
      const z = wZ(u, v);
      const heading = headingOf(pa);
      placeRigid(W, geo, wenv, { cat: 'wCore', x: x - Math.cos(heading) * L * 0.5, z: z - Math.sin(heading) * L * 0.5, heading, roll: rng.float(0, TAU), pitches: [-0.1, 0, 0.1], com: [0, L * 0.5, 0], sink: 0.003, aoH: 0.006, bury: tag(u, v, rng.float(0.02, 0.2), 0.15) });
    }
    env.anchors.midden = new THREE.Vector3(wX(mu, mv), env.ground.at(wX(mu, mv), wZ(mu, mv)), wZ(mu, mv));
  }

  // ── spruce shoot tips with green needles ──
  counts.shoots = 0;
  for (let k = 0; k < n(18, 6); k++) {
    const at = pick(0);
    if (!at) continue;
    // squirrels drop them in little groups under one tree
    const group = rng.int(1, 3);
    for (let q = 0; q < group; q++) {
      const u = at[0] + rng.gauss() * 0.06;
      const v = at[1] + rng.gauss() * 0.06;
      const len = rng.float(0.05, 0.11);
      if (!ok(u, v, len * 0.65)) continue;
      const geo = spruceShootGeo(rng, len);
      const x = wX(u, v);
      const z = wZ(u, v);
      const h = rng.float(0, TAU);
      placeRigid(W, geo, wenv, { cat: 'wShoot', x: x - Math.cos(h) * len * 0.5, z: z - Math.sin(h) * len * 0.5, heading: h, flat: true, sink: 0.0015, ao: false, bury: tag(u, v, rng.float(0.02, 0.8), rng.float(0.25, 0.6)) });
      counts.shoots++;
    }
  }

  // ── a few cones that fell after the snow, still closed and brown ──
  counts.cones = 0;
  for (let k = 0; k < n(5, 2); k++) {
    const at = pick(0);
    if (!at) continue;
    const [u, v] = at;
    const L = rng.float(0.04, 0.055);
    if (!ok(u, v, L * 0.6)) continue;
    const geo = pineConeGeo(rng, { L, R: L * 0.27, N: 60, open: rng.chance(0.3) ? 0.3 : 0, age: 0.1, full: !env.low });
    const x = wX(u, v);
    const z = wZ(u, v);
    const h = rng.float(0, TAU);
    placeRigid(W, geo, wenv, { cat: 'wCone', x: x - Math.cos(h) * L * 0.45, z: z - Math.sin(h) * L * 0.45, heading: h, roll: rng.float(0, TAU), pitches: [-0.1, 0, 0.1], com: [0, L * 0.42, 0], sink: 0.004, aoH: 0.004, bury: tag(u, v, rng.float(0.05, 0.9), rng.float(0.3, 0.8)) });
    counts.cones++;
  }

  // ── bark flakes, bright on the white ──
  counts.flakes = 0;
  for (let k = 0; k < n(12, 4); k++) {
    const at = pick(0);
    if (!at) continue;
    const [u, v] = at;
    const len = rng.float(0.01, 0.035);
    if (!ok(u, v, len * 0.6)) continue;
    const geo = flakeGeo(rng, { len, bury: 1 });
    placeRigid(W, geo, wenv, { cat: 'wFlake', x: wX(u, v), z: wZ(u, v), heading: rng.float(0, TAU), flat: true, tip: [rng.float(-0.2, 0.2), rng.float(-0.2, 0.2)], sink: 0.0004, ao: false, bury: tag(u, v, rng.float(0.05, 1), 0.2) });
    counts.flakes++;
  }

  // ── fresh needles: green ones torn off by wind and squirrels, brown ones from the inner crown ──
  const pineGreen = [lin(82, 102, 62), lin(96, 112, 66), lin(70, 92, 56)];
  const pineBrown = [lin(150, 98, 56), lin(132, 92, 60)];
  const spruceGreen = [lin(48, 76, 42), lin(60, 88, 46)];
  const spruceBrown = [lin(160, 92, 48), lin(138, 84, 50)];
  counts.pine = 0;
  counts.spruce = 0;
  const nPine = n(900, 120);
  const nSpruce = n(800, 100);
  let guard = 0;
  while ((counts.pine < nPine || counts.spruce < nSpruce) && guard++ < (nPine + nSpruce) * 4) {
    const at = pick(0, 20);
    if (!at) continue;
    const clump = 1 + Math.floor(Math.pow(rng.next(), 2) * 6);
    for (let q = 0; q < clump; q++) {
      const u = at[0] + rng.gauss() * 0.03;
      const v = at[1] + rng.gauss() * 0.03;
      const x = wX(u, v);
      const z = wZ(u, v);
      const dir = rng.float(0, TAU);
      const spruce = counts.spruce < nSpruce && (counts.pine >= nPine || rng.chance(0.47));
      const len = spruce ? rng.float(0.014, 0.022) : rng.float(0.035, 0.06);
      // base (with the sheath), middle and tip must all stay clear
      let clear = okFlat(u, v, 0.008);
      for (const t of [0.5, 1]) {
        for (const sg of spruce ? [0] : [-0.35, 0.35]) {
          const ex = x + Math.cos(dir + sg) * len * t;
          const ez = z + Math.sin(dir + sg) * len * t;
          if (!okFlat(toU(ex, ez), toV(ex, ez), 0.007)) clear = false;
        }
      }
      if (!clear) continue;
      const green = rng.chance(0.55);
      const bury = tag(u, v, rng.float(0.01, 1));
      if (spruce) {
        const col = vary(rng, rng.pick(green ? spruceGreen : spruceBrown), 0.1, 0.04);
        WN.begin('wSpruceNeedle', { contact: 'drape', maxSink: 0.0004 });
        spruceNeedle(WN, wenv, { x, z, dir, len, w: rng.float(0.0009, 0.0012), lift: 0.0002, col, uvCol: rng.int(0, 7), bury });
        WN.end();
        counts.spruce++;
      } else {
        const col = vary(rng, rng.pick(green ? pineGreen : pineBrown), 0.08, 0.04);
        const spread = rng.chance(0.6) ? rng.float(0.03, 0.2) : rng.float(0.2, 0.7);
        const w = rng.float(0.0011, 0.0014);
        WN.begin('wPinePair', { contact: 'drape', maxSink: 0.0004 });
        for (const sgn of [-0.5, 0.5]) {
          const off = sgn * w * 0.9;
          needleEmit(WN, wenv, needlePlan(wenv, { x: x - Math.sin(dir) * off, z: z + Math.cos(dir) * off, dir: dir + sgn * spread, len: len * rng.float(0.94, 1), w, curve: rng.float(-0.004, 0.004), phi0: rng.float(-0.3, 0.3), phiRate: rng.float(-0.8, 0.8), lift: 0.0003, tipLift: 0, col: mul3(col, rng.float(0.95, 1.05)), uvCol: green ? 0 : rng.int(1, 7), broken: false, bury }));
        }
        sheath(WN, wenv, x, z, dir, rng.float(0.0025, 0.004), w * 1.35, vary(rng, PAL.sheath, 0.1), bury, 0.0003);
        WN.end();
        counts.pine++;
      }
    }
  }

  // ── birch seeds and catkin scales, blown far over the crust ──
  counts.birch = 0;
  const nBirch = env.low ? 0 : n(700);
  guard = 0;
  while (counts.birch < nBirch && guard++ < nBirch * 6) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    if (rng.next() * 1.4 > 0.35 * fadeUV(u, v) + winterDensity(env, u, v, 1.5) * 0.5) continue;
    if (!okFlat(u, v, 0.003)) continue;
    const geo = birchBitGeo(rng, rng.chance(0.4));
    placeRigid(WN, geo, wenv, { cat: 'wBirch', x: wX(u, v), z: wZ(u, v), heading: rng.float(0, TAU), flat: true, sink: 0, ao: false, bury: tag(u, v, rng.float(0.01, 1)) });
    counts.birch++;
  }

  // ── scraps of beard lichen blown down, lying flat ──
  counts.lichen = 0;
  for (let k = 0; k < n(10, 3); k++) {
    const at = pick(0);
    if (!at) continue;
    const [u, v] = at;
    if (!ok(u, v, 0.03)) continue;
    const [c, sn] = mossSnowAt(u, v);
    const lv0 = env.lichenWinter.count;
    const usnea = rng.chance(0.7);
    const tint = usnea ? vary(rng, [1.0, 1.06, 0.7], 0.08, 0.04) : vary(rng, [0.34, 0.27, 0.21], 0.1, 0.05);
    const L = rng.float(0.02, 0.05);
    const wd = L * rng.float(0.5, 0.75);
    for (let q = 0; q < 2; q++) {
      const a = rng.float(0, TAU);
      const centers = [];
      const rights = [];
      const widths = [];
      const vs = [];
      const x0 = wX(u, v) + rng.gauss() * 0.004;
      const z0 = wZ(u, v) + rng.gauss() * 0.004;
      for (let sI = 0; sI <= 3; sI++) {
        const t = sI / 3;
        const x = x0 + Math.cos(a) * L * (t - 0.5);
        const z = z0 + Math.sin(a) * L * (t - 0.5);
        centers.push(new THREE.Vector3(x, env.ground.at(x, z) + 0.0012 + 0.002 * Math.sin(t * Math.PI), z));
        rights.push(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)));
        widths.push(wd * (0.6 + 0.4 * Math.sin(t * Math.PI)));
        vs.push(1 - t);
      }
      // the winter lichen mesh carries the moss cover in aSway and the moss snow noise in aH
      addStrip(env.lichenWinter, centers, rights, widths, vs, { color: tint, sway: c, h: sn });
    }
    env.lichenWinterSites.push([lv0, env.lichenWinter.count, [u, v, 0, c]]);
    counts.lichen++;
  }
  env.counts.winter = counts;
}

// ═════════════════════════════════════════════════════════════
// Materials (GPU side)
// ═════════════════════════════════════════════════════════════


const WORLD_VERT = /* glsl */ `
#ifdef USE_INSTANCING
  vLWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vLWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
  vLWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vLWN = normalize(mat3(modelMatrix) * objectNormal);
#endif`;

// ── Snow on the litter (GPU) ──
// Two ways to know the snow. Once setSnowField has bound the floor's snow field (SNOW_FIELD_GLSL and the very
// same uniform objects as floor and moss, #define LITTER_FIELD), everything follows that field, so litter,
// moss and floor agree. Before that, or without a floor, the season value alone decides (uBury thresholds by
// size, the moss's old fill formula for the winter pieces).
//
// Per piece (aSite): anchor u / 2.1, v / 1.2 in the patch frame, its top above heroHeightAt / 0.15, and
// whether it rests up on the moss carpet. Per vertex (aHv): height above heroHeightAt / 0.15.
const SITE_GLSL = /* glsl */ `
#ifdef LITTER_FIELD
attribute vec4 aSite;
uniform float uMossShown; // 0 once deep snow hides the moss shells and the floor's snow takes over
vec2 litterSite(vec4 s) { return uSnowMapA.xy + uSnowMapB.xy * (s.x * 2.1) + uSnowMapB.zw * (s.y * 1.2); }
// buried: the snow lies here (thickness > 0) and its surface reaches 5 mm over the piece's top (the moss's
// ragged edge stays drawn over it); resting up on the moss: gone with the moss shells
bool litterBuried(vec4 s) {
  vec4 sA = floorSnowAt(litterSite(s));
  return (sA.y > 0.0 && sA.x > s.z * 0.15 + 0.005) || (s.w > 0.5 && uMossShown < 0.5);
}
#endif`;

// Summer litter and leaves: buried pieces collapse; vHv carries each point's height above the floor, so the
// fragment can ask the floor where its lying snow reaches (floorSnowLieAt).
const BURY_FIELD_VERT = /* glsl */ `
#ifdef LITTER_FIELD
  if (litterBuried(aSite) || aBury <= uThin) transformed = vec3(0.0);
#else
  if (aBury <= max(uBury, uThin)) transformed = vec3(0.0); // buried by snow or thinned with distance
#endif`;
const SNOWED_VERT = /* glsl */ `
#ifdef LITTER_FIELD
  vHv = aHv * 0.15;
#endif`;

// Snow on a piece, exactly as the floor beside it has it: the lying snow with its ragged, granular edge where
// the point dips under the snow (floorSnowLieAt) or the dusting's grains on up-facing faces (floorSnowDustAt),
// whichever covers more; toned and sloped by floorSnowSurf. `up` = the face's normal.y.
const GRAINS_GLSL = /* glsl */ `
#ifdef LITTER_FIELD
varying float vHv;
float litterSnow(vec3 wp, float up) {
  float foot = max(length(dFdx(wp.xz)), length(dFdy(wp.xz)));
  float lie = floorSnowLieAt(wp.xz, vHv, foot);
  float dust = 0.9 * floorSnowDustAt(wp.xz, floorSnowAt(wp.xz).z, up * up, foot);
  vec3 surf = floorSnowSurf(wp.xz, foot);
  lTone = surf.x;
  lSlope = surf.yz;
  return max(lie, dust);
}
#endif`;

// Winter pieces: x = winter level the piece appears at, y = moss cover, z = moss snow noise (no field), w = cap.
// Built at floor level, lifted onto the white the user sees: on the moss shells the field's surface (never
// above the shell top), elsewhere, and once the moss is hidden, the floor's snow at floor height.
const SNOW_LIFT = /* glsl */ `
float snowLift(float cover, float noise) {
#ifdef LITTER_FIELD
  vec4 sA = floorSnowAt(litterSite(aSite));
  float shellTop = uMossSnow.w * (0.4 + 0.6 * cover) + uMossSnow.z;
  float onFloor = sA.y > 0.0 ? 0.0005 : 0.0; // as the floor draws it (snowTopAt)
  return mix(onFloor, min(sA.x, shellTop), uMossSnow.y * smoothstep(0.05, 0.3, cover));
#else
  float fill = uMossSnow.x * uMossSnow.z * 1.3 * (0.55 + 0.9 * noise) - 0.006;
  return uMossSnow.y * smoothstep(0.05, 0.3, cover) * (uMossSnow.w * (0.4 + 0.6 * cover) + clamp(fill, 0.0, uMossSnow.z));
#endif
}`;
const WINTER_VERT = /* glsl */ `
if (aWin.x > uWinter) transformed = vec3(0.0);
else transformed.y += snowLift(aWin.y, aWin.z);
vCap = aWin.w;`;

const SNOW_WET = /* glsl */ `
  vec3 lwn = normalize(vLWN) * (gl_FrontFacing ? 1.0 : -1.0);
#ifdef LITTER_WINTER
  // fell after the snow: only round crumbs of snow where a flurry caught the top
  vec2 lcp = vLWP.xz * 900.0;
  float lh = fract(sin(dot(floor(lcp), vec2(12.9898, 78.233))) * 43758.5453);
  float lr = 0.5 * step(1.0 - 0.6 * vCap, lh) * (0.55 + 0.45 * fract(lh * 17.31));
  vec2 ljit = vec2(fract(lh * 7.13), fract(lh * 3.71)) - 0.5;
  float lCrumb = smoothstep(lr, lr * 0.55, length(fract(lcp) - 0.5 - ljit * (0.5 - lr)));
  lSnow = lCrumb * smoothstep(0.55, 0.9, lwn.y) * smoothstep(0.04, 0.45, uSnow);
#elif defined(LITTER_FIELD)
  // own colour; the floor's grains, and its lying snow where the point dips under it
  lSnow = litterSnow(vLWP, clamp(lwn.y, 0.0, 1.0));
#else
  float lsn = fract(sin(dot(floor(vLWP.xz * 650.0), vec2(12.9898, 78.233))) * 43758.5453);
  lSnow = smoothstep(0.35, 0.8, lwn.y + (lsn - 0.5) * 0.45) * smoothstep(0.04, 0.45, uSnow);
#endif
  diffuseColor.rgb *= 1.0 - 0.16 * uWet;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.77, 0.82) * lTone, lSnow);`;

// After the normal maps: where snow covers the piece, its normal becomes the snow's (floorSnowSurf slopes).
const SNOW_NORMAL = /* glsl */ `
#ifdef LITTER_FIELD
if (lSnow > 0.001) {
  vec3 lSnowN = normalize((viewMatrix * vec4(normalize(vec3(lSlope.x, 1.0, lSlope.y)), 0.0)).xyz);
  normal = normalize(mix(normal, lSnowN, lSnow));
}
#endif`;
const SNOW_FRAG_GLOBALS = 'float lSnow = 0.0;\nfloat lTone = 1.0;\nvec2 lSlope = vec2(0.0);';

// The floor's snow field, once bound: its GLSL (both stages) and the very same uniform objects.
function bindField(sh, snow) {
  if (!snow.field) return '';
  Object.assign(sh.uniforms, snow.field.uniforms, { uMossShown: snow.uMossShown });
  return `#define LITTER_FIELD\n${snow.field.glsl}\n`;
}
const fieldKey = (snow) => (snow.field ? 'field' : 'season');

function makeTexture(px, w, h, { srgb = true, repeatV = false, anisotropy = 8 } = {}) {
  const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = repeatV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

const SUMMER_VERT_PARS = 'attribute float aBury;\nattribute float aHv;\nuniform float uBury;\nuniform float uThin;\nvarying float vHv;';
const WINTER_VERT_PARS = 'attribute vec4 aWin;\nuniform float uWinter;\nuniform vec4 uMossSnow;\nvarying float vCap;';

// Vertex-coloured standard material on the detail atlas (alpha = roughness), with snow burial,
// distance thinning, snow on upward faces and a wet sheen from the morning dew.
function litterMaterial(map, uni, snow, { winter = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, { uSnow: shared.uSnow });
    const field = bindField(sh, snow);
    const vPars = `${field}${SITE_GLSL}\n${winter ? `${WINTER_VERT_PARS}\n${SNOW_LIFT}` : SUMMER_VERT_PARS}`;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${vPars}\nvarying vec3 vLWP;\nvarying vec3 vLWN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${winter ? WINTER_VERT : `${BURY_FIELD_VERT}\n${SNOWED_VERT}`}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${WORLD_VERT}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${field}${SNOW_FRAG_GLOBALS}\n${winter ? '' : GRAINS_GLSL}\nuniform float uSnow;\nuniform float uWet;\nvarying vec3 vLWP;\nvarying vec3 vLWN;\n${winter ? 'varying float vCap;' : ''}\nfloat lRough = 0.85;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{\n  lRough = diffuseColor.a;\n  diffuseColor.a = 1.0;\n${SNOW_WET}\n}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(lRough * mix(1.0, 0.72, uWet), 0.5, lSnow);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SNOW_NORMAL}`);
  };
  mat.customProgramCacheKey = () => `${winter ? 'flyover-litter-winter' : 'flyover-litter'}-${fieldKey(snow)}`;
  if (winter) mat.defines = { LITTER_WINTER: '' };
  return mat;
}

function litterDepthMaterial(uni, snow, { winter = false } = {}) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    const field = bindField(sh, snow);
    const vPars = `${field}${SITE_GLSL}\n${winter ? `${WINTER_VERT_PARS}\n${SNOW_LIFT}` : 'attribute float aBury;\nuniform float uBury;\nuniform float uThin;'}`;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${vPars}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${winter ? WINTER_VERT : BURY_FIELD_VERT}`);
  };
  mat.customProgramCacheKey = () => `${winter ? 'flyover-litter-depth-winter' : 'flyover-litter-depth'}-${fieldKey(snow)}`;
  return mat;
}

// Birch leaves: alpha-tested atlas; fresh leaves appear with the autumn and brown as it goes on.
// The leaf atlas is data (see leafCell): luminance × vertex colour, the vein net as bump, and last year's
// leaves rotting away between their veins as the season value advances (uRot × the leaf's own decay).
const LEAF_MAP = /* glsl */ `
{
  vec4 lt = texture2D(map, vMapUv);
  diffuseColor.rgb *= lt.r * mix(1.0, 0.62, clamp(vRot, 0.0, 1.0));
  float lKeep = vRot > 0.001 ? max(smoothstep(vRot - 0.05, vRot + 0.05, lt.b), smoothstep(0.35, 0.6, lt.g)) : 1.0;
  diffuseColor.a *= lt.a * lKeep;
}`;
const LEAF_VERT = /* glsl */ `
vFreshK = step(0.001, aLeaf.x);
vRot = aLeaf.z * uRot;
#ifdef LITTER_FIELD
  if (litterBuried(aSite) || aLeaf.x > uFresh) transformed = vec3(0.0);
#else
  if (aLeaf.y <= uBury || aLeaf.x > uFresh) transformed = vec3(0.0);
#endif`;

function leafMaterial(map, uni, a2c, snow) {
  const mat = new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: 0.00025, vertexColors: true, roughness: 0.78, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: a2c });
  const uTrans = { value: new THREE.Vector3(0.45, 0.36, 0.1) }; // thin leaves glow a little against the sun
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni, { uSnow: shared.uSnow, uTrans });
    const field = bindField(sh, snow);
    injectFoliage(sh, { power: 4 });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${field}${SITE_GLSL}\nattribute vec3 aLeaf;\nattribute float aHv;\nuniform float uBury;\nuniform float uFresh;\nuniform float uRot;\nvarying float vFreshK;\nvarying float vRot;\nvarying float vHv;\nvarying vec3 vLWP;\nvarying vec3 vLWN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LEAF_VERT}\n${SNOWED_VERT}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${WORLD_VERT}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${field}${SNOW_FRAG_GLOBALS}\n${GRAINS_GLSL}\nuniform float uSnow;\nuniform float uWet;\nuniform float uAge;\nvarying float vFreshK;\nvarying float vRot;\nvarying vec3 vLWP;\nvarying vec3 vLWN;`)
      .replace('#include <map_fragment>', LEAF_MAP)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  // fresh leaves brown as the autumn goes on; the underside is paler
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.52, 0.38, 0.27), uAge * vFreshK);
  if (!gl_FrontFacing) diffuseColor.rgb *= vec3(1.1, 1.06, 0.92);
${SNOW_WET}
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness * mix(1.0, 0.65, uWet), 0.5, lSnow);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SNOW_NORMAL}`);
  };
  mat.customProgramCacheKey = () => `flyover-litter-leaf-${fieldKey(snow)}`;
  return mat;
}

// Beard lichen: the shared lichen texture with foliage translucency and season snow.
// With the snow field the tufts go under the snow with their twig. Winter scraps: shown once winter has set
// in and lifted onto the drawn snow (aSway = moss cover, aH = moss snow noise for the season fallback).
const LICHEN_VERT_PARS = /* glsl */ `
attribute float aSway;
attribute float aH;
uniform float uWinter;
uniform vec4 uMossSnow;`;
const LICHEN_SUMMER_VERT = /* glsl */ `
#ifdef LITTER_FIELD
  if (litterBuried(aSite)) transformed = vec3(0.0);
#endif`;
const LICHEN_WINTER_VERT = 'if (uWinter < 0.2) transformed = vec3(0.0);\nelse transformed.y += snowLift(aSway, aH);';

function lichenMaterial(map, a2c, snow, { winter = null } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.42, alphaToCoverage: a2c });
  const uTrans = { value: new THREE.Vector3(0.55, 0.6, 0.4) };
  const lightSnow = { value: winter ? 0.12 : 0.35 }; // with the field: grains, not a coat (scraps on the snow hardly any)
  const hook = (sh) => {
    const field = bindField(sh, snow);
    if (winter) Object.assign(sh.uniforms, winter);
    else Object.assign(sh.uniforms, { uWinter: { value: 0 }, uMossSnow: { value: new THREE.Vector4() } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${field}${SITE_GLSL}\n${LICHEN_VERT_PARS}\n${SNOW_LIFT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${winter ? LICHEN_WINTER_VERT : LICHEN_SUMMER_VERT}`);
    return field;
  };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTrans = uTrans;
    injectFoliage(sh, { power: 3 });
    injectSeason(sh, 'none');
    const field = hook(sh);
    if (winter || field) sh.uniforms.uSSnow = lightSnow;
  };
  mat.customProgramCacheKey = () => `${winter ? 'flyover-litter-lichen-winter' : 'flyover-litter-lichen'}-${fieldKey(snow)}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.42 });
  depth.onBeforeCompile = (sh) => {
    hook(sh);
  };
  depth.customProgramCacheKey = () => `${winter ? 'flyover-litter-lichen-winter-depth' : 'flyover-litter-lichen-depth'}-${fieldKey(snow)}`;
  return { mat, depth };
}

function decalMaterial(map) {
  return new THREE.MeshBasicMaterial({
    color: 0x000000,
    map,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

// ═════════════════════════════════════════════════════════════
// Module entry
// ═════════════════════════════════════════════════════════════

/**
 * buildLitter(ctx) → { group, update(dt, time, state), applySeason(sp, v), stats, anchors }
 * ctx: world.ctx ({ quality, trees, foliage: { lichen }, … }).
 */
export function buildLitter(ctx) {
  const quality = ctx.quality ?? { tier: 'medium', plants: 0.7, shadows: true, msaa: 4 };
  const data = buildLitterGeometry({ quality, trees: ctx.trees });
  const shadows = quality.shadows !== false;
  const a2c = (quality.msaa ?? 4) > 0;
  const aniso = quality.anisotropy ?? 8;

  // The two painted atlases are filled in a task of their own right after the build (≈ 0.2 s of JS),
  // so the loader keeps breathing; the patch is far off-screen while the page loads.
  const atlasPx = new Uint8Array(AT * ATH * 4);
  const leafPx = new Uint8Array(AT * AT * 4);
  const atlas = makeTexture(atlasPx, AT, ATH, { repeatV: true, anisotropy: aniso });
  const leafTex = makeTexture(leafPx, AT, AT, { srgb: false, anisotropy: aniso }); // data, not colour
  const blobTex = makeTexture(blobPixels(), 64, 64, { srgb: false, anisotropy: 1 });
  const paint = () => {
    litterAtlasPixels(atlasPx);
    atlas.needsUpdate = true;
    leafAtlasPixels(leafPx);
    leafTex.needsUpdate = true;
  };
  if (ctx.deferTextures !== false && typeof setTimeout === 'function') setTimeout(paint, 0);
  else paint();

  // the snow: the floor's field once setSnowField binds it (see SITE_GLSL), the season value until then
  const snow = { field: null, uMossShown: { value: 1 } };
  const uFine = { uBury: { value: 0 }, uThin: { value: 0 }, uWet: { value: 0 } };
  const uWood = { uBury: uFine.uBury, uThin: { value: 0 }, uWet: uFine.uWet };
  const uLeaf = { uBury: uFine.uBury, uFresh: { value: 0 }, uAge: { value: 0 }, uRot: { value: 0.6 }, uWet: uFine.uWet };
  const matFine = litterMaterial(atlas, uFine, snow);
  const matWood = litterMaterial(atlas, uWood, snow);
  const depthFine = litterDepthMaterial(uFine, snow);
  const depthWood = litterDepthMaterial(uWood, snow);
  const matLeaf = leafMaterial(leafTex, uLeaf, a2c, snow);
  const lichenTex = ctx.foliage?.lichen ?? null;
  const lich = lichenMaterial(lichenTex, a2c, snow);
  const matDecal = decalMaterial(blobTex);
  // winter: what fell on the snow (lifted onto the drawn snow surface, see SNOW_LIFT)
  const uWin = { uWinter: { value: 0 }, uMossSnow: { value: new THREE.Vector4(0, 0, 0.04, 0.004) }, uWet: uFine.uWet };
  const matWinter = litterMaterial(atlas, uWin, snow, { winter: true });
  const depthWinter = litterDepthMaterial(uWin, snow, { winter: true });
  const lichW = lichenMaterial(lichenTex, a2c, snow, { winter: { uWinter: uWin.uWinter, uMossSnow: uWin.uMossSnow } });
  const allMats = [matFine, matWood, depthFine, depthWood, matLeaf, lich.mat, lich.depth, matWinter, depthWinter, lichW.mat, lichW.depth];

  const group = new THREE.Group();
  group.name = 'flyover-litter';
  const mk = (geo, mat, name, cast) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = shadows && cast;
    m.receiveShadow = shadows;
    group.add(m);
    return m;
  };
  const meshes = {};
  if (data.wood.count) {
    meshes.wood = mk(data.wood.build(), matWood, 'litter-wood', true);
    meshes.wood.customDepthMaterial = depthWood;
  }
  if (data.near.count) {
    meshes.near = mk(data.near.build(), matFine, 'litter-near', true);
    meshes.near.customDepthMaterial = depthFine;
  }
  if (data.fine.count) meshes.fine = mk(data.fine.build(), matFine, 'litter-fine', false);
  if (data.leaves.count) meshes.leaves = mk(data.leaves.build('aLeaf'), matLeaf, 'litter-leaves', false);
  // per-tuft sites on the lichen ribbons (MeshData), for the snow field
  const lichenGeo = (md, sites) => {
    const geo = md.build();
    const site = new Array(md.count * 4).fill(0);
    for (const [a, b, st] of sites) for (let k = a; k < b; k++) site.splice(k * 4, 4, st[0], st[1], st[2], st[3]);
    geo.setAttribute('aSite', siteAttribute(site));
    return geo;
  };
  if (data.lichen.count && lichenTex) {
    meshes.lichen = mk(lichenGeo(data.lichen, data.lichenSites), lich.mat, 'litter-lichen', true);
    meshes.lichen.customDepthMaterial = lich.depth;
  }
  if (data.winter.count) {
    meshes.winter = mk(data.winter.build('aWin'), matWinter, 'litter-winter', true);
    meshes.winter.customDepthMaterial = depthWinter;
  }
  if (data.winterNear.count) meshes.winterNear = mk(data.winterNear.build('aWin'), matWinter, 'litter-winter-near', false);
  if (data.lichenWinter.count && lichenTex) {
    meshes.lichenWinter = mk(lichenGeo(data.lichenWinter, data.lichenWinterSites), lichW.mat, 'litter-lichen-winter', true);
    meshes.lichenWinter.customDepthMaterial = lichW.depth;
  }
  if (data.decal.count) {
    meshes.decal = mk(data.decal.build(), matDecal, 'litter-decal', false);
    meshes.decal.receiveShadow = false;
    meshes.decal.renderOrder = 1;
  }

  const tris = (m) => (m ? m.geometry.index.count / 3 : 0);
  const SUMMER = ['wood', 'near', 'fine', 'leaves', 'lichen', 'decal'];
  const WINTER = ['wood', 'winter', 'winterNear', 'lichen', 'lichenWinter', 'decal'];
  const sum = (keys) => keys.reduce((s, k) => s + tris(meshes[k]), 0);
  const stats = {
    drawCalls: Math.max(SUMMER.filter((k) => meshes[k]).length, WINTER.filter((k) => meshes[k]).length), // at most at once
    shadowDrawCalls: Object.values(meshes).filter((m) => m.castShadow).length,
    triangles: Math.max(sum(SUMMER), sum(WINTER)), // drawn at once (summer and winter sets never show together)
    trianglesSummer: sum(SUMMER),
    trianglesWinter: sum(WINTER),
    meshes: Object.keys(meshes).length,
    instances: data.wood.items.length + data.near.items.length + data.fine.items.length + data.leaves.items.length + (data.counts.lichenTufts ?? 0),
    perMesh: Object.fromEntries(Object.entries(meshes).map(([k, m]) => [k, tris(m)])),
    counts: data.counts,
    buildMs: Math.round(data.ms),
  };

  // with the field: a sample of each mesh's pieces decides whether any of them still shows (else no draw)
  const sampleSites = (geo) => {
    const out = [];
    const step = Math.max(1, Math.floor(geo.items.length / 300));
    for (let k = 0; k < geo.items.length; k += step) if (geo.items[k].site) out.push(geo.items[k].site);
    return out;
  };
  const sites = { fine: sampleSites(data.fine), near: sampleSites(data.near), wood: sampleSites(data.wood), leaves: sampleSites(data.leaves) };
  const depthOut = {};
  const showing = (list, sn, mossShown) =>
    list.some(([u, v, top, onMoss]) => {
      if (onMoss && !mossShown) return false;
      const d = snow.field.depthAt(wX(u, v), wZ(u, v), sn, depthOut);
      return !(d.thickness > 0 && d.surface > top + 0.005);
    });
  // the moss module's own test for "is all of the carpet under the snow?" (its probes: RNG 4401, the same count), so the
  // winter pieces drop to the floor's snow exactly when the moss shells give way
  let mossProbes = null;
  const mossBuried = (sn) => {
    if (!snow.field || !MOSS_API?.mossField || sn < 0.5) return false;
    if (!mossProbes) {
      mossProbes = [];
      const prng = new RNG(4401);
      const f = {};
      const MS = MOSS_API.MOSS;
      for (let tries = 0; mossProbes.length < 400 && tries < 20000; tries++) {
        const u = prng.float(-PATCH.halfL, PATCH.halfL);
        const v = prng.float(-PATCH.halfW, PATCH.halfW);
        MOSS_API.mossField(u, v, f);
        if (f.cover < 0.3) continue;
        const pile = f.pile * smoothstep(0.12, 0.7, f.cover);
        mossProbes.push(wX(u, v), wZ(u, v), MS.base * (0.4 + 0.6 * f.cover) + Math.min(1, pile + 0.12) * MS.pile);
      }
    }
    for (let i = 0; i < mossProbes.length; i += 3) {
      const d = snow.field.depthAt(mossProbes[i], mossProbes[i + 1], sn, depthOut);
      if (!(d.thickness > 0.003 && d.surface - 0.002 > mossProbes[i + 2])) return false;
    }
    return true;
  };

  let fineBuried = false;
  let nearBuried = false;
  let woodBuried = false;
  let leavesBuried = false;
  let winterOn = false;
  let lastSeason = null;
  const setWinterVisibility = (near) => {
    if (meshes.winter) meshes.winter.visible = winterOn;
    if (meshes.lichenWinter) meshes.lichenWinter.visible = winterOn;
    if (meshes.winterNear) meshes.winterNear.visible = winterOn && near > 0.001;
  };
  setWinterVisibility(1);
  let lastNear = 1;
  return {
    group,
    stats,
    anchors: data.anchors,
    silkAnchor: data.anchors.silkAnchor, // world-space tip of the raised twig end for dew.setSites({ silk })
    /** Bind the floor's snow field ({ uniforms, glsl, depthAt }): burial, lifting and grains then follow it. */
    setSnowField(field) {
      if (!field?.uniforms || !field?.glsl || typeof field.depthAt !== 'function') return;
      snow.field = field;
      for (const m of allMats) m.needsUpdate = true;
      lastSeason?.();
    },
    update(dt, time, state) {
      const near = state?.near ?? 1;
      const dist = state?.dist ?? 0;
      group.visible = dist < LITTER.farHide;
      // sub-centimetre litter only near the camera, thinning out as it recedes (2.5 → 4 m)
      uFine.uThin.value = (1 - near) * 0.42;
      if (meshes.fine) meshes.fine.visible = near > 0.001 && !fineBuried;
      if (meshes.near) meshes.near.visible = near > 0.001 && !nearBuried;
      lastNear = near;
      setWinterVisibility(near);
    },
    applySeason(sp, v) {
      lastSeason = () => this.applySeason(sp, v);
      const ph = phenology(v ?? 1.5);
      const sn = sp?.snow ?? 0;
      // without the field: snow buries the litter from the smallest pieces up; cones and the hero twig stay
      const bury = clamp((sn - 0.1) / 0.8, 0, 0.996);
      uFine.uBury.value = bury;
      fineBuried = bury >= 0.39;
      nearBuried = bury >= 0.46;
      uFine.uWet.value = (sp?.dew ?? 1) * (1 - sn) * LITTER.wetGloss;
      uLeaf.uFresh.value = clamp(Math.max(ph.freshBirchLeaves, 0.7 * (sp?.litter ?? 0), 0.8 * (sp?.leaves ?? 0)));
      uLeaf.uAge.value = ph.month >= 8.5 ? smoothstep(10.0, 12.2, ph.month) : 1;
      // last year's leaves: matted after the thaw, dark and lacy by midsummer, mostly veins by autumn
      uLeaf.uRot.value = ph.month < 2.8 ? 1.1 : 0.12 + 0.88 * smoothstep(3.2, 10.0, ph.month) + 0.2 * smoothstep(10.0, 11.5, ph.month);
      matDecal.opacity = 1 - 0.85 * smoothstep(0.2, 0.7, sn);
      // winter set: appears as the snow settles (sp.snow 0.45 → 0.85), riding on the snow that is drawn.
      // The moss shells fill with snow by the moss module's own season value and vanish above 0.97.
      uWin.uWinter.value = clamp((sn - 0.45) / 0.4);
      const ms = MOSS_API?.mossSeason ? MOSS_API.mossSeason(sp, v ?? 0)?.snow ?? sn : sn;
      let shown;
      if (snow.field) {
        // the floor's field: the moss shells stand until all of the carpet is under the snow
        shown = MOSS_API?.mossField ? (mossBuried(ms) ? 0 : 1) : 0;
        snow.uMossShown.value = shown;
        fineBuried = !showing(sites.fine, sn, shown);
        nearBuried = !showing(sites.near, sn, shown);
        woodBuried = !showing(sites.wood, sn, shown);
        leavesBuried = !showing(sites.leaves, sn, shown);
      } else {
        shown = MOSS_API?.mossSeason && ms <= 0.97 ? 1 : 0;
        woodBuried = false;
        leavesBuried = bury >= 0.5;
      }
      uWin.uMossSnow.value.set(ms, shown, MOSS_API?.MOSS?.pile ?? 0.04, MOSS_API?.MOSS?.base ?? 0.004);
      if (meshes.leaves) meshes.leaves.visible = !leavesBuried;
      if (meshes.wood) meshes.wood.visible = !woodBuried;
      winterOn = uWin.uWinter.value > 0;
      setWinterVisibility(lastNear);
    },
  };
}
