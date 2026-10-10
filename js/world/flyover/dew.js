import * as THREE from 'three';
import { RNG, fbm2, smoothstep, clamp } from '../../lib/random.js';
import { SUN_DIR } from '../layout.js';
import { shadowUniforms, sunHDR } from '../details.js';
import { PATCH, SPOTS, toPatch, fromPatch, patchFade, heroHeightAt, heroNormalAt, monthOf } from './config.js';

// Dew, silk and the light between the moss: thousands of real water drops on moss tips and leaves (each a tiny
// ball lens with a sun glint, a caustic, a dark rim and, at the right angle, a dewbow), a beaded spider line
// that only flashes where the sun allows, sunlit pollen drifting low over the floor, and hoarfrost on cold
// late-autumn and early-spring mornings.
//
// Four draw calls: drops (instanced lat-long spheres), silk (screen-aligned ribbons), frost (instanced ice
// blades), motes (points). Every builder below is plain JS so it can be tested in Node; only the materials
// touch GLSL.

// ── tuning knobs ────────────────────────────────────────────
export const DEW_TUNING = {
  mossDrops: 3600, // drops on moss tips at quality.plants = 1 (ultra 1.3, medium 0.7, low 0.35)
  leafDrops: 450, // drops on leaves
  motes: 360, // pollen, spores and fluff
  minPx: 1.5, // smallest drop diameter on screen (px); smaller drops grow and dim instead of flickering
  frostMinPx: 2.2, // smallest frost tuft on screen (px)
  glint: 2.5, // sun glint energy
  glintWidth: 0.05, // physical width of the glint lobe (rad, in normal space)
  caustic: 1.6, // focused sunlight on the far inner side of each drop
  bow: 0.9, // dewbow colours (primary 42°, secondary 51°)
  silkGlint: 220, // spider-line flash
  silkWidth: 1.2e-5, // m: dragline plus its water film
  sparkle: 600, // frost glitter
  moteBright: 3.0, // mote brightness
  moteBokeh: 14, // blur circle (px) per dioptre of defocus
  moteGain: 0.65, // < 1 lets out-of-focus motes keep some brightness (1 = strict energy conservation)
  // Distance: the glide stays within ~1.3 m of the patch centre and keeps the full look. From farStart the
  // drops thin out steeply; beyond farEnd only the largest farKeep share remain, and they draw only where
  // they actually glint (no body, so the 1.5 px clamp never leaves grey dots), at farEnergy of the clamp's lift.
  farStart: 1.8, // m from the patch centre
  farEnd: 2.6,
  farKeep: 0.008, // share of drops (largest first) left beyond farEnd: a handful of glints
  farEnergy: 0.25, // brightness floor of a grown far drop (close up it is 0.4)
};

// Geometry detail per quality tier.
const TIERS = {
  ultra: { segs: 8, rings: 5, blades: 6, beadStep: 1 },
  high: { segs: 8, rings: 5, blades: 6, beadStep: 1 },
  medium: { segs: 6, rings: 4, blades: 5, beadStep: 1 },
  low: { segs: 6, rings: 3, blades: 4, beadStep: 1.4 },
};

// The spider line (patch frame, metres; h = height above heroHeightAt). Both ends lie inside SPOTS.silkThread.
export const SILK = {
  from: { u: 0.7, v: 0.42, h: 0.3 }, // a lady-fern frond tip leaning out of fernRight
  to: { u: 0.76, v: -0.08, h: 0.035 }, // the end of a small dead twig lying on the moss
  slack: 1.06, // arc length / chord, reduced automatically if the sag would touch the moss
  clearance: 0.025, // the sag stays this high above the ground
  beadSpacing: 0.0042, // Rayleigh–Plateau beads: one main bead every ~4 mm, satellites between
  brokenLength: 0.16, // a second, broken thread wafting from the fern
};

const MOSS_TINT = [0.05, 0.085, 0.02];
const LEAF_TINT = [0.06, 0.12, 0.025];
const GROUND_TINT = [0.035, 0.045, 0.02];
const UP = new THREE.Vector3(0, 1, 0);

// ── calendar ────────────────────────────────────────────────
function windowMonths(m, a, b, ramp) {
  const inside = (x) => smoothstep(a - ramp, a + ramp, x) * (1 - smoothstep(b - ramp, b + ramp, x));
  return Math.max(inside(m), inside(m + 12), inside(m - 12));
}

/** What the morning brings at season params sp and season value v. All weights 0 … 1. */
export function dewState(sp, v) {
  const m = monthOf(v);
  const snow = sp.snow ?? 0;
  // hoarfrost: cold clear mornings in late autumn and early spring, not once the snow lies
  const win = Math.max(windowMonths(m, 10.3, 11.6, 0.3), windowMonths(m, 3.0, 4.0, 0.3));
  const frost = win * (1 - smoothstep(0.18, 0.3, snow));
  // liquid dew only on mild mornings: never in the frost months, never once snow lies about
  const wet = clamp(sp.dew ?? 0) * (1 - win) * (1 - smoothstep(0.1, 0.3, snow));
  const silk = Math.max(wet, frost) * (1 - smoothstep(0.3, 0.6, snow));
  const motes = clamp((sp.dust ?? 1) * (1 - 0.8 * snow), 0, 1.5);
  return { month: m, frost, wet, silk, motes };
}

// ── sites ───────────────────────────────────────────────────
// Keep fallback dew off things that are not moss or leaves.
const BLOCKED = ['pineCone', 'spruceCone', 'barkFlakes', 'anthill'].map((k) => SPOTS[k]);
const blocked = (u, v) => BLOCKED.some((s) => Math.hypot(u - s.u, v - s.v) < s.r);

/** Moss-tip stand-ins on heroHeightAt, a little above the surface (used until the moss module hands over its tips). */
export function fallbackMossTips(count, seed = 7101) {
  const rng = new RNG(seed);
  const out = [];
  for (let guard = 0; out.length < count && guard < count * 30; guard++) {
    const u = rng.float(-PATCH.halfL, PATCH.halfL);
    const v = rng.float(-PATCH.halfW, PATCH.halfW);
    if (blocked(u, v)) continue;
    const { x, z } = fromPatch(u, v);
    const n = heroNormalAt(x, z);
    n.x += rng.float(-0.35, 0.35);
    n.z += rng.float(-0.35, 0.35);
    n.normalize();
    const top = 0.006 + 0.016 * smoothstep(-0.5, 0.6, fbm2(x * 4.0 + 1.3, z * 4.0 - 6.1, 2)) + rng.float(0, 0.004);
    out.push({ p: new THREE.Vector3(x, heroHeightAt(x, z) + top, z), n });
  }
  return out;
}

/** Low leaf stand-ins around the plant spots, close to the ground (lingon, twinflower and sorrel height). */
export function fallbackLeafSites(count, seed = 7202) {
  const rng = new RNG(seed);
  const spots = ['lingon', 'twinflower', 'woodSorrel', 'bilberry', 'fernLeft', 'fernRight'].map((k) => SPOTS[k]);
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = spots[i % spots.length];
    const a = rng.float(0, Math.PI * 2);
    const r = s.r * Math.sqrt(rng.next()) * 0.9;
    const { x, z } = fromPatch(s.u + Math.cos(a) * r, s.v + Math.sin(a) * r);
    const n = new THREE.Vector3(rng.float(-0.6, 0.6), 1, rng.float(-0.6, 0.6)).normalize();
    if (rng.chance(0.15)) n.y = -n.y; // a few leaves turned over: their drops hang beneath
    out.push({ p: new THREE.Vector3(x, heroHeightAt(x, z) + rng.float(0.015, 0.05), z), n });
  }
  return out;
}

// The camera sees |v| < ~0.55 while it glides |u| < ~1.3; most dew goes there, the rest only glitters from afar.
function siteWeight(p) {
  const f = patchFade(p.x, p.z);
  if (f <= 0) return 0;
  const { u, v } = toPatch(p.x, p.z);
  const swath = Math.abs(v) < 0.62 && Math.abs(u) < 1.5 ? 1 : 0.18;
  const patchy = 0.35 + 0.65 * smoothstep(-0.45, 0.45, fbm2(p.x * 3.1 + 7.7, p.z * 3.1 - 2.3, 2));
  return f * swath * patchy;
}

// Weighted sampling without replacement (Efraimidis–Spirakis): deterministic for a given rng.
function pickWeighted(sites, count, rng, weight) {
  const keyed = [];
  for (const s of sites) {
    if (!s || !s.p) continue;
    const w = weight(s.p);
    if (w > 0) keyed.push([Math.pow(rng.next(), 1 / w), s]);
  }
  keyed.sort((a, b) => b[0] - a[0]);
  return keyed.slice(0, count).map((k) => k[1]);
}

function siteTint(site, fallback) {
  if (site.color && site.color.isColor) return [site.color.r, site.color.g, site.color.b];
  if (Array.isArray(site.c)) return site.c;
  return fallback;
}

// ── drops ───────────────────────────────────────────────────
// A drop record: anchor (contact or hanging point), axis (up of the shape), r (m),
// shape (> 0 sessile lens flattening, < 0 pendant pear), tint (what lies beneath), waft (silk sway weight).

function mossDrop(site, rng) {
  const r = 0.00035 + 0.0011 * Math.pow(rng.next(), 2.2);
  const tint = siteTint(site, MOSS_TINT).map((c) => c * rng.float(0.8, 1.2));
  const n = (site.n ?? UP).clone().normalize();
  if (rng.chance(0.75)) {
    // a pearl perched on the tip, a little flattened under its own weight
    return { anchor: site.p.clone(), axis: n, r, shape: 0.05 + 0.3 * (r / 0.00145) + rng.float(0, 0.08), tint, waft: 0 };
  }
  // a pear hanging from a tip that curls over
  const axis = new THREE.Vector3(rng.float(-0.15, 0.15), 1, rng.float(-0.15, 0.15)).normalize();
  return { anchor: site.p.clone().addScaledVector(n, 0.0004), axis, r: r * 0.85, shape: -rng.float(0.2, 0.6), tint, waft: 0 };
}

function leafDrop(site, rng) {
  const r = 0.0004 + 0.0011 * Math.pow(rng.next(), 1.6);
  const tint = siteTint(site, LEAF_TINT).map((c) => c * rng.float(0.85, 1.15));
  const n = (site.n ?? UP).clone().normalize();
  if (n.y < 0) n.negate(); // dew condenses on the upper side
  if (n.y > 0.4) {
    // a flattened lens on the leaf blade; big drops spread more
    const shape = clamp(0.3 + 0.55 * (r / 0.0015) + rng.float(-0.05, 0.05), 0.2, 0.92);
    return { anchor: site.p.clone().addScaledVector(n, 0.0003), axis: n, r, shape, tint, waft: 0 };
  }
  if (rng.chance(0.6)) {
    // a steep leaf: the drop has run to the edge and hangs there
    return { anchor: site.p.clone().addScaledVector(UP, -0.0004), axis: UP.clone(), r, shape: -rng.float(0.4, 0.9), tint, waft: 0 };
  }
  return { anchor: site.p.clone().addScaledVector(n, 0.0003), axis: n, r: r * 0.8, shape: 0.5, tint, waft: 0 };
}

/** Pack drop records into instanced attribute arrays. */
export function packDrops(drops) {
  const n = drops.length;
  const aDrop = new Float32Array(n * 4);
  const aAxis = new Float32Array(n * 4);
  const aInfo = new Float32Array(n * 4);
  drops.forEach((d, i) => {
    aDrop.set([d.anchor.x, d.anchor.y, d.anchor.z, d.r], i * 4);
    aAxis.set([d.axis.x, d.axis.y, d.axis.z, d.shape], i * 4);
    aInfo.set([d.tint[0], d.tint[1], d.tint[2], d.waft], i * 4);
  });
  return { aDrop, aAxis, aInfo, count: n };
}

/** Unit lat-long sphere, poles on ±y, outward CCW winding. Positions double as normals in the shader. */
export function dropGeometry(segs = 6, rings = 4) {
  const pos = [0, 1, 0];
  for (let i = 1; i < rings; i++) {
    const t = (i / rings) * Math.PI;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      pos.push(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a));
    }
  }
  pos.push(0, -1, 0);
  const bottom = pos.length / 3 - 1;
  const ring = (i, j) => 1 + (i - 1) * segs + (((j % segs) + segs) % segs);
  const idx = [];
  for (let j = 0; j < segs; j++) idx.push(0, ring(1, j + 1), ring(1, j));
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = ring(i, j);
      const b = ring(i, j + 1);
      const c = ring(i + 1, j);
      const d = ring(i + 1, j + 1);
      idx.push(a, b, d, a, d, c);
    }
  }
  for (let j = 0; j < segs; j++) idx.push(bottom, ring(rings - 1, j), ring(rings - 1, j + 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// ── silk ────────────────────────────────────────────────────
/**
 * A hanging thread from A to B with arc length slack × chord, sampled at n + 1 points evenly along its length.
 * y(x) = a cosh((x − x0) / a) + C in the vertical plane through A and B.
 */
export function catenary(A, B, slack, n) {
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const h = Math.hypot(dx, dz);
  const dv = B.y - A.y;
  const L = Math.hypot(h, dv) * slack;
  const target = Math.sqrt(L * L - dv * dv);
  let lo = 1e-5;
  let hi = 1e5;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (2 * mid * Math.sinh(h / (2 * mid)) > target) lo = mid;
    else hi = mid;
  }
  const a = Math.sqrt(lo * hi);
  const x0 = h / 2 - a * Math.atanh(dv / L);
  const C = A.y - a * Math.cosh(x0 / a);
  const s0 = Math.sinh(-x0 / a);
  const hx = dx / h;
  const hz = dz / h;
  const points = [];
  const tangents = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * L;
    const x = x0 + a * Math.asinh(s / a + s0);
    const k = Math.sinh((x - x0) / a); // slope dy/dx
    points.push(new THREE.Vector3(A.x + hx * x, a * Math.cosh((x - x0) / a) + C, A.z + hz * x));
    tangents.push(new THREE.Vector3(hx, k, hz).normalize());
  }
  return { points, tangents, length: L, a, x0, h };
}

function patchPoint({ u, v, h }) {
  const { x, z } = fromPatch(u, v);
  return new THREE.Vector3(x, heroHeightAt(x, z) + h, z);
}

/** Default anchors, optionally snapped to a real fern-frond site from the plants module. */
export function silkAnchors(leafSites = []) {
  const from = patchPoint(SILK.from);
  const to = patchPoint(SILK.to);
  let best = 0.15;
  for (const s of leafSites) {
    if (!s || !s.p) continue;
    const d = Math.hypot(s.p.x - from.x, s.p.z - from.z);
    const hh = s.p.y - heroHeightAt(s.p.x, s.p.z);
    if (d < best && hh > 0.2 && hh < 0.38) {
      best = d;
      from.copy(s.p);
    }
  }
  return { from, to };
}

const lerpAlong = (pts, f) => {
  const x = clamp(f, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(x));
  return pts[i].clone().lerp(pts[i + 1], x - i);
};

/** The main line (catenary + beads), a broken wafting thread, and frost points along both. */
export function buildSilk({ from, to }, { seed = 4242, beadStep = 1 } = {}) {
  const rng = new RNG(seed);
  // the most slack that keeps the sag clear of the moss
  let slack = SILK.slack;
  let cat = null;
  for (let k = 0; k < 30; k++) {
    cat = catenary(from, to, slack, 160);
    const ok = cat.points.every((p, i) => {
      const t = i / 160;
      return t < 0.06 || t > 0.94 || p.y - heroHeightAt(p.x, p.z) >= SILK.clearance;
    });
    if (ok || slack < 1.001) break;
    slack = 1 + (slack - 1) * 0.8;
  }
  const L = cat.length;
  const mainWaft = (t) => 0.12 * Math.sin(Math.PI * t); // the whole line breathes a little
  const mainRate = (t) => (0.12 * Math.PI * Math.cos(Math.PI * t)) / L;
  const ys = cat.points.map((p) => p.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  const beads = [];
  const bead = (p, r, waft) => ({ anchor: p.clone().addScaledVector(UP, r * 0.55), axis: UP.clone(), r, shape: -0.15, tint: GROUND_TINT, waft });
  // Rayleigh–Plateau: a water film on the silk breaks up into evenly spaced beads, small satellites between
  const step = SILK.beadSpacing * beadStep;
  let prev = null;
  for (let s = 0.012; s < L - 0.012; s += step * rng.float(0.82, 1.18)) {
    const t = s / L;
    const p = lerpAlong(cat.points, t);
    const low = 1 - (p.y - yMin) / Math.max(yMax - yMin, 1e-4); // water gathers toward the sag
    beads.push(bead(p, rng.float(0.00022, 0.00042) * (1 + 0.5 * low), mainWaft(t)));
    if (prev !== null && rng.chance(0.55)) {
      const tm = (prev + t) / 2;
      beads.push(bead(lerpAlong(cat.points, tm), rng.float(0.00006, 0.00012), mainWaft(tm)));
    }
    prev = t;
  }

  // a broken thread hangs from the same frond and drifts in the air
  const start = from.clone().add(new THREE.Vector3(PATCH.v.x * 0.03, -0.012, PATCH.v.y * 0.03));
  const drift = new THREE.Vector3(PATCH.u.x * 0.6 - PATCH.v.x * 0.8, 0, PATCH.u.y * 0.6 - PATCH.v.y * 0.8).normalize();
  const nb = 32;
  const broken = [];
  for (let i = 0; i <= nb; i++) {
    const s = i / nb;
    broken.push(
      start
        .clone()
        .addScaledVector(UP, -0.1 * s)
        .addScaledVector(drift, 0.075 * Math.pow(s, 1.6))
        .add(new THREE.Vector3(0.008 * Math.sin(s * 5.0), 0, 0.006 * Math.sin(s * 3.0 + 1.0))),
    );
  }
  const bl = broken.reduce((acc, p, i) => (i ? acc + p.distanceTo(broken[i - 1]) : 0), 0);
  const scale = SILK.brokenLength / bl;
  for (const p of broken) p.sub(start).multiplyScalar(scale).add(start);
  const brokenTan = broken.map((p, i) => broken[Math.min(nb, i + 1)].clone().sub(broken[Math.max(0, i - 1)]).normalize());
  const brokenWaft = broken.map((_, i) => Math.pow(i / nb, 1.3));
  const brokenRate = broken.map((_, i) => (1.3 * Math.pow(Math.max(i / nb, 1e-3), 0.3)) / SILK.brokenLength);
  for (let i = 3; i <= nb; i += 1) {
    if (!rng.chance(0.7)) continue;
    beads.push(bead(broken[i], rng.float(0.00012, 0.0003), brokenWaft[i]));
  }

  // hoarfrost needles all along the threads
  const frost = [];
  const frostAt = (p, T, waft, size) => {
    const side = new THREE.Vector3().crossVectors(T, UP);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const axis = side.applyAxisAngle(T, rng.float(0, Math.PI * 2));
    return { p: p.clone(), axis, size, spin: rng.float(0, Math.PI * 2), waft };
  };
  for (let s = 0.006; s < L - 0.006; s += 0.0055 * beadStep) {
    const t = s / L;
    frost.push(frostAt(lerpAlong(cat.points, t), lerpAlong(cat.tangents, t).normalize(), mainWaft(t), rng.float(0.0007, 0.0014)));
  }
  for (let i = 2; i <= nb; i += 2) frost.push(frostAt(broken[i], brokenTan[i], brokenWaft[i], rng.float(0.0006, 0.0011)));

  const lines = [
    { points: cat.points, tangents: cat.tangents, waft: cat.points.map((_, i) => mainWaft(i / 160)), rate: cat.points.map((_, i) => mainRate(i / 160)) },
    { points: broken, tangents: brokenTan, waft: brokenWaft, rate: brokenRate },
  ];
  return { lines, beads, frost, slack, length: L, catenary: cat };
}

/** Screen-aligned ribbons: two vertices per line point, extruded to ≥ 1 px in the vertex shader. */
export function silkGeometry(lines) {
  const pos = [];
  const tan = [];
  const side = [];
  const waft = [];
  const idx = [];
  for (const line of lines) {
    const base = pos.length / 3;
    line.points.forEach((p, i) => {
      const T = line.tangents[i];
      for (const s of [-1, 1]) {
        pos.push(p.x, p.y, p.z);
        tan.push(T.x, T.y, T.z);
        side.push(s);
        waft.push(line.waft[i], line.rate[i]);
      }
    });
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aWaft', new THREE.Float32BufferAttribute(waft, 2));
  g.setIndex(idx);
  return g;
}

// ── frost ───────────────────────────────────────────────────
/** One rime tuft: `blades` slender ice plates fanning out of a tip along +y (length ≈ 1). */
export function frostGeometry(blades = 5, seed = 31) {
  const rng = new RNG(seed);
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  for (let b = 0; b < blades; b++) {
    const az = (b / blades) * Math.PI * 2 + rng.float(-0.4, 0.4);
    const tilt = THREE.MathUtils.degToRad(b % 2 ? rng.float(15, 40) : rng.float(40, 75));
    const d = new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
    const len = rng.float(0.55, 1.0);
    const w = len * rng.float(0.3, 0.42);
    // a plate through d, rolled at random so every blade mirrors the sun at its own angle
    const side = new THREE.Vector3().crossVectors(d, UP);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize().applyAxisAngle(d, rng.float(-1.2, 1.2));
    const n = new THREE.Vector3().crossVectors(side, d).normalize();
    const base = pos.length / 3;
    const corners = [
      [0, 0, 0.5, 0],
      [0.35 * len, 0.5 * w, 1, 0.35],
      [len, 0, 0.5, 1],
      [0.35 * len, -0.5 * w, 0, 0.35],
    ];
    for (const [along, across, cu, cv] of corners) {
      pos.push(d.x * along + side.x * across, d.y * along + side.y * across, d.z * along + side.z * across);
      nor.push(n.x, n.y, n.z);
      uv.push(cu, cv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function frostFromDrop(d, kind, rng) {
  const axis = d.axis.clone();
  if (kind === 'leaf') {
    // rime grows out along the leaf edges, more sideways than up
    const h = new THREE.Vector3(rng.float(-1, 1), 0, rng.float(-1, 1)).normalize();
    axis.lerp(h, 0.5).normalize();
  } else {
    axis.add(new THREE.Vector3(rng.float(-0.3, 0.3), 0, rng.float(-0.3, 0.3))).normalize();
  }
  const size = kind === 'leaf' ? rng.float(0.001, 0.0021) : rng.float(0.0016, 0.0032);
  const p = d.shape < 0 ? d.anchor.clone() : d.anchor.clone().addScaledVector(d.axis, 0.0006);
  return { p, axis, size, spin: rng.float(0, Math.PI * 2), waft: 0, site: d.site };
}

export function packFrost(list) {
  const n = list.length;
  const aSite = new Float32Array(n * 4);
  const aAxis = new Float32Array(n * 4);
  const aWaft = new Float32Array(n);
  list.forEach((f, i) => {
    aSite.set([f.p.x, f.p.y, f.p.z, f.size], i * 4);
    aAxis.set([f.axis.x, f.axis.y, f.axis.z, f.spin], i * 4);
    aWaft[i] = f.waft;
  });
  return { aSite, aAxis, aWaft, count: n };
}

// ── motes ───────────────────────────────────────────────────
export function moteSeeds(count, seed = 919) {
  const rng = new RNG(seed);
  const pos = new Float32Array(count * 3);
  const k = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.next();
    pos[i * 3 + 1] = rng.next();
    pos[i * 3 + 2] = rng.next();
    k[i] = rng.next();
  }
  return { pos, k };
}

/** Least-squares quadratic fit of heroHeightAt over the patch, around PATCH.center: [c0, cx, cz, cxx, cxz, czz]. */
export function groundFit() {
  const rows = [];
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 20; j++) {
      const u = (i / 40 - 0.5) * 2 * PATCH.halfL;
      const v = (j / 20 - 0.5) * 2 * PATCH.halfW;
      const { x, z } = fromPatch(u, v);
      const dx = x - PATCH.center.x;
      const dz = z - PATCH.center.y;
      rows.push([[1, dx, dz, dx * dx, dx * dz, dz * dz], heroHeightAt(x, z)]);
    }
  }
  // normal equations, solved by Gaussian elimination
  const M = Array.from({ length: 6 }, () => new Array(7).fill(0));
  for (const [f, y] of rows) {
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) M[a][b] += f[a] * f[b];
      M[a][6] += f[a] * y;
    }
  }
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let q = c; q < 7; q++) M[r][q] -= k * M[c][q];
    }
  }
  return M.map((row, i) => row[6] / row[i]);
}

// ── GLSL ────────────────────────────────────────────────────
// Same lookup as details.js (not exported there), with a tighter bias (~10 cm of the 280 m shadow column, so drops
// under fern fronds stay dark), plus a 4-tap soft version for drifting motes.
const SHADOW_GLSL = /* glsl */ `
#include <packing>
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
float sunVisibility(vec3 wp) {
  if (uHasShadow < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 0.5;
  float d = unpackRGBAToDepth(textureLod(tShadow, sc.xy, 0.0));
  return step(sc.z - 0.00035, d);
}
float sunVisibilitySoft(vec3 wp) {
  if (uHasShadow < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 0.5;
  vec2 tx = 1.2 / vec2(textureSize(tShadow, 0));
  float v = 0.0;
  v += step(sc.z - 0.00035, unpackRGBAToDepth(textureLod(tShadow, sc.xy + vec2(-tx.x, -tx.y), 0.0)));
  v += step(sc.z - 0.00035, unpackRGBAToDepth(textureLod(tShadow, sc.xy + vec2(tx.x, -tx.y), 0.0)));
  v += step(sc.z - 0.00035, unpackRGBAToDepth(textureLod(tShadow, sc.xy + vec2(-tx.x, tx.y), 0.0)));
  v += step(sc.z - 0.00035, unpackRGBAToDepth(textureLod(tShadow, sc.xy + vec2(tx.x, tx.y), 0.0)));
  return v * 0.25;
}`;

// Silk sways in the faint morning air. w = 0 at the anchors … 1 at the free end of the broken thread.
// Drops and frost on the threads call the same function with the same weight, so they ride along.
const WAFT_GLSL = /* glsl */ `
uniform float uTime;
vec3 silkWaft(float w) {
  if (w <= 0.0) return vec3(0.0);
  float ph = uTime * 1.1 - w * 3.2;
  float gust = 0.6 + 0.4 * sin(uTime * 0.23 + 1.7);
  return w * gust * vec3(0.016 * sin(ph) + 0.006 * sin(uTime * 2.3 - w * 7.0), 0.004 * sin(ph * 0.8 + 0.6), 0.011 * cos(ph * 0.9 + 0.3));
}`;

// The world a drop mirrors and looks through, as seen from the forest floor.
const ENV_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uCanopy;
uniform vec3 uGround;
vec3 env(vec3 d) {
  float y = d.y;
  float az = atan(d.z, d.x + 1e-5);
  // ragged crowns around the horizon, trunks below them, sky through gaps in the canopy above
  float edge = 0.3 + 0.08 * sin(az * 3.0 + 0.7) + 0.05 * sin(az * 7.0 + 2.1) + 0.03 * sin(az * 17.0 + 0.4);
  vec3 forest = mix(uHorizon, uCanopy, smoothstep(0.0, 0.2, y));
  forest *= 1.0 - 0.55 * smoothstep(0.55, 0.9, sin(az * 29.0 + 2.0 * sin(az * 4.0)));
  float gaps = sin(d.x * 9.0 + 2.0 * sin(d.z * 6.0)) * sin(d.z * 8.0 + 1.3 + 2.0 * sin(d.x * 5.0));
  vec3 sky = mix(uSky, uCanopy * 2.0, smoothstep(0.2, 0.55, gaps) * (1.0 - smoothstep(0.75, 0.97, y)));
  sky += uSunColor * 0.06 * pow(max(dot(d, uSunDir), 0.0), 8.0);
  vec3 c = mix(forest, sky, smoothstep(edge - 0.04, edge + 0.08, y));
  return mix(uGround, c, smoothstep(-0.14, 0.02, y));
}`;

function envUniforms() {
  return {
    uSunDir: { value: SUN_DIR },
    uSunColor: { value: sunHDR },
    uSky: { value: new THREE.Vector3(0.76, 0.92, 1.1) },
    uHorizon: { value: new THREE.Vector3(0.39, 0.47, 0.44) },
    uCanopy: { value: new THREE.Vector3(0.025, 0.04, 0.03) },
    uGround: { value: new THREE.Vector3(0.03, 0.045, 0.02) },
    uAmbient: { value: new THREE.Vector3(0.21, 0.26, 0.31) },
  };
}

function dropMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...envUniforms(),
      ...shadowUniforms,
      uTime: shared.uTime,
      uViewport: shared.uViewport,
      uMinPx: { value: DEW_TUNING.minPx },
      uScale: { value: 1 },
      uGlint: { value: DEW_TUNING.glint },
      uGlintW: { value: DEW_TUNING.glintWidth },
      uCaustic: { value: DEW_TUNING.caustic },
      uBow: { value: DEW_TUNING.bow },
      uFar: shared.uFar,
      uFarEnergy: { value: DEW_TUNING.farEnergy },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      ${WAFT_GLSL}
      attribute vec4 aDrop; // anchor (xyz), radius (m)
      attribute vec4 aAxis; // shape axis (xyz), shape: > 0 sessile lens, < 0 pendant pear
      attribute vec4 aInfo; // colour beneath (rgb), silk waft weight
      uniform vec2 uViewport;
      uniform float uMinPx;
      uniform float uScale;
      varying vec3 vN;
      varying vec3 vWP;
      varying vec3 vTint;
      varying float vVis;
      varying float vEnergy;
      varying float vRadPx;
      varying float vRnd;
      void main() {
        float r = aDrop.w * uScale;
        vec3 h3 = fract(aDrop.xyz * 97.3);
        h3 += dot(h3, h3.zyx + 31.32);
        vRnd = fract((h3.x + h3.y) * h3.z); // one random number per drop
        vec3 A = normalize(aAxis.xyz);
        float s = aAxis.w;
        vec3 q = position;
        float ct = q.y;
        float st = length(q.xz);
        vec3 lp;
        vec3 ln;
        float lift;
        if (s >= 0.0) {
          // sessile: an oblate lens, flatter below where it wets the surface
          float b = ct > 0.0 ? 1.0 - 0.3 * s : 1.0 - 0.6 * s;
          lp = vec3(q.x, ct * b, q.z);
          ln = vec3(q.x * b, ct, q.z * b);
          lift = (1.0 - 0.6 * s) * 0.82;
        } else {
          // pendant: a pear hanging from its tip, the neck drawn out above, the bulb below
          float p = -s;
          float up = step(0.0, ct);
          float k = mix(1.0 + 0.12 * p, 1.0 + 0.8 * p, up);
          float tp = 0.55 * p * up;
          float f = 1.0 - tp * ct * ct;
          lp = vec3(q.x * f, ct * k, q.z * f);
          ln = vec3(q.x * k, ct * f + 2.0 * tp * ct * st * st, q.z * k);
          lift = -(1.0 + 0.8 * p) * 0.94;
        }
        vec3 C = aDrop.xyz + A * (lift * r) + silkWaft(aInfo.w);
        vec4 mvC = viewMatrix * vec4(C, 1.0);
        float pxPerM = projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mvC.z, 1e-3);
        float radPx = r * pxPerM;
        // never smaller than ~uMinPx across: grow and dim instead of shimmering away
        float grow = max(1.0, 0.5 * uMinPx / max(radPx, 1e-5));
        vEnergy = 1.0 / (grow * grow);
        vRadPx = radPx * grow;
        vec3 ref = abs(A.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 X = normalize(cross(ref, A));
        vec3 Z = cross(X, A);
        mat3 M = mat3(X, A, Z);
        vec3 wp = C + M * lp * (r * grow);
        vN = normalize(M * ln);
        vWP = wp;
        vTint = aInfo.rgb;
        vVis = sunVisibility(C);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${ENV_GLSL}
      uniform vec3 uAmbient;
      uniform float uGlint;
      uniform float uGlintW;
      uniform float uCaustic;
      uniform float uBow;
      uniform float uFar;
      uniform float uFarEnergy;
      uniform float uStrength;
      varying float vRnd;
      varying vec3 vN;
      varying vec3 vWP;
      varying vec3 vTint;
      varying float vVis;
      varying float vEnergy;
      varying float vRadPx;
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWP);
        vec3 L = uSunDir;
        float ndv = clamp(dot(N, V), 1e-3, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        // grown drops keep 40 % of the lift close up, less from afar
        float energy = mix(1.0, vEnergy, mix(0.6, 1.0 - uFarEnergy, uFar));
        float radPx = max(vRadPx, 1e-3);

        // mirror: sky through the canopy, dark crowns and trunks toward the rim
        vec3 refl = env(reflect(-V, N));

        // lens: refract in, cross the drop (as a sphere), refract out on the far side
        vec3 Ti = refract(-V, N, 0.75);
        vec3 Q = normalize(N - 2.0 * dot(N, Ti) * Ti);
        vec3 E = refract(Ti, -Q, 1.333);
        if (dot(E, E) < 1e-4) E = reflect(Ti, -Q);
        // the tiny inverted world: the lit surface below, the bright misty forest where rays leave sideways
        vec3 sub = vTint * (uSunColor * vVis * 0.6 + uAmbient);
        vec3 below = mix(sub, uHorizon * 1.15, pow(clamp(1.0 + E.y, 0.0, 1.0), 4.0));
        vec3 through = mix(below, env(E), smoothstep(-0.04, 0.06, E.y)) * vec3(0.88, 0.96, 0.95);
        through *= mix(1.0, 0.1, pow(1.0 - ndv, 2.0)); // dark rim: grazing rays see the floor or reflect inside
        vec3 body = mix(through, refl, F);
        vec3 col = vec3(0.0);

        // where the sun lies across the drop, as seen from here
        vec3 Lp = L - V * dot(L, V);
        vec3 Ls = Lp / max(length(Lp), 1e-4);

        // sun glint on the sun side: at least ~1 px wide so it never flickers, energy kept
        vec3 H = normalize(L + V);
        float w = max(uGlintW, 0.9 / radPx);
        float lobe = exp(-2.0 * (1.0 - dot(N, H)) / (w * w));
        float Fh = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, H), 0.0, 1.0), 5.0);
        col += uSunColor * vVis * min(uGlint * (Fh / 0.02) * energy / (3.14159 * w * w), 80.0) * lobe;

        // caustic: the drop focuses the sun onto its far inner side; blue focuses tighter (a warm fringe)
        vec3 Nc = normalize(V - Ls * 0.75);
        float wc = max(0.3, 0.9 / radPx);
        vec3 spot = exp(-2.0 * (1.0 - dot(N, Nc)) / (wc * wc * vec3(1.25, 1.0, 0.8)));
        float back = mix(0.45, 1.6, smoothstep(-0.7, 0.6, dot(V, -L))); // brightest when backlit
        col += uSunColor * vVis * uCaustic * back * (1.0 - F) * spot * energy;

        // dewbow: sunlight reflected once inside leaves at 42° (primary), twice at 51° (secondary, reversed)
        float cvl = dot(V, L);
        vec3 d1 = (vec3(cvl) - vec3(0.7396, 0.747, 0.7558)) / 0.011;
        vec3 d2 = (vec3(cvl) - vec3(0.6428, 0.6259, 0.605)) / 0.014;
        vec3 bow = exp(-d1 * d1) + 0.42 * exp(-d2 * d2);
        float side = smoothstep(-0.1, 0.7, dot(N, -Ls)) * smoothstep(0.1, 0.6, 1.0 - ndv);
        side = mix(side, 1.0, 1.0 - smoothstep(1.0, 3.0, radPx));
        col += uSunColor * vVis * uBow * bow * side * energy;

        // pulling back, drops lose their bodies one by one: a far drop shows only where it glints
        if (vRnd < uFar) {
          if (dot(col, vec3(0.2126, 0.7152, 0.0722)) < 0.35) discard;
          body = vec3(0.0);
        }
        gl_FragColor = vec4((body + col) * uStrength, 1.0);
      }`,
  });
}

function silkMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shadowUniforms,
      uTime: shared.uTime,
      uViewport: shared.uViewport,
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: sunHDR },
      uAmbient: { value: new THREE.Vector3(0.21, 0.26, 0.31) },
      uWidth: { value: DEW_TUNING.silkWidth },
      uGlint: { value: DEW_TUNING.silkGlint },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      ${WAFT_GLSL}
      attribute vec3 aTangent;
      attribute float aSide;
      attribute vec2 aWaft; // weight, d(weight)/d(arc length)
      uniform vec2 uViewport;
      uniform float uWidth;
      varying vec3 vWP;
      varying vec3 vT;
      varying float vCover;
      varying float vSide;
      varying float vVis;
      void main() {
        vec3 wp = position + silkWaft(aWaft.x);
        // the sway bends the thread: fold its slope into the tangent
        vec3 T = normalize(aTangent + (silkWaft(aWaft.x + 0.01) - silkWaft(aWaft.x)) * (aWaft.y / 0.01));
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vec3 tv = mat3(viewMatrix) * T;
        vec2 sdir = tv.xy * (-mv.z) + mv.xy * tv.z; // the thread's direction on screen
        float sl = length(sdir);
        sdir = sl > 1e-6 ? sdir / sl : vec2(1.0, 0.0);
        float pxPerM = projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mv.z, 1e-3);
        float wPx = uWidth * pxPerM;
        float drawPx = max(wPx, 1.3);
        vCover = wPx / drawPx; // a few microns of silk cover a sliver of a pixel
        mv.xy += vec2(-sdir.y, sdir.x) * aSide * 0.5 * drawPx / pxPerM;
        vWP = wp;
        vT = T;
        vSide = aSide;
        vVis = sunVisibility(wp);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform float uGlint;
      uniform float uStrength;
      varying vec3 vWP;
      varying vec3 vT;
      varying float vCover;
      varying float vSide;
      varying float vVis;
      void main() {
        vec3 T = normalize(vT);
        vec3 V = normalize(cameraPosition - vWP);
        // a thin cylinder mirrors the sun into a cone around itself: bright only where the eye sits on that cone
        float c = dot(T, uSunDir) + dot(T, V);
        float cone = exp(-c * c / 0.0016) + 0.12 * exp(-c * c / 0.04);
        // silk diffracts: the flash breaks into faint colours along the line
        float hue = dot(T, V) * 4.0 + dot(vWP, vec3(23.0, 17.0, 29.0));
        vec3 irid = 0.65 + 0.35 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
        float fwd = pow(max(dot(-V, uSunDir), 0.0), 4.0);
        vec3 col = uSunColor * vVis * (cone * uGlint * irid + 0.6 + 2.5 * fwd) + uAmbient * 0.3;
        float across = 1.0 - vSide * vSide;
        gl_FragColor = vec4(col * vCover * across * uStrength, 1.0);
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function frostMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shadowUniforms,
      uTime: shared.uTime,
      uViewport: shared.uViewport,
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: sunHDR },
      uAmbient: { value: new THREE.Vector3(0.21, 0.26, 0.31) },
      uMinPx: { value: DEW_TUNING.frostMinPx },
      uGrowth: { value: 1 },
      uSparkle: { value: DEW_TUNING.sparkle },
      uFar: shared.uFar,
      uFarEnergy: { value: DEW_TUNING.farEnergy },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      ${WAFT_GLSL}
      attribute vec4 aSite; // base (xyz), tuft size (m)
      attribute vec4 aAxis; // growth axis (xyz), spin about it
      attribute float aWaft;
      uniform vec2 uViewport;
      uniform float uMinPx;
      uniform float uGrowth;
      varying vec3 vN;
      varying vec3 vWP;
      varying vec2 vUv;
      varying float vVis;
      varying float vEnergy;
      varying float vSeed;
      void main() {
        vec3 A = normalize(aAxis.xyz);
        vec3 ref = abs(A.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 X = normalize(cross(ref, A));
        vec3 Z = cross(X, A);
        float cs = cos(aAxis.w);
        float sn = sin(aAxis.w);
        vec3 Xr = X * cs + Z * sn;
        mat3 M = mat3(Xr, A, cross(Xr, A));
        vec3 base = aSite.xyz + silkWaft(aWaft);
        float size = aSite.w * uGrowth;
        vec4 mvB = viewMatrix * vec4(base, 1.0);
        float px = size * projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mvB.z, 1e-3);
        float grow = max(1.0, uMinPx / max(px, 1e-5));
        vEnergy = 1.0 / (grow * grow);
        vec3 wp = base + M * position * (size * grow);
        vN = M * normal;
        vWP = wp;
        vUv = uv;
        vVis = sunVisibility(base);
        vSeed = fract(aAxis.w * 7.13 + aSite.x * 31.7 + aSite.z * 17.3);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform float uSparkle;
      uniform float uFar;
      uniform float uFarEnergy;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vWP;
      varying vec2 vUv;
      varying float vVis;
      varying float vEnergy;
      varying float vSeed;
      vec2 hash2(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
      }
      void main() {
        vec3 V = normalize(cameraPosition - vWP);
        vec3 N = normalize(vN);
        if (dot(N, V) < 0.0) N = -N; // thin plates mirror from both faces
        // glitter: every plate is a stack of tiny facets, each tilted its own way
        vec2 h = hash2(floor(vUv * vec2(2.0, 5.0)) + vSeed * 97.0) - 0.5;
        vec3 t1 = normalize(cross(N, abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 t2 = cross(N, t1);
        vec3 Nf = normalize(N + (t1 * h.x + t2 * h.y) * 0.7);
        vec3 H = normalize(uSunDir + V);
        float F = 0.018 + 0.982 * pow(1.0 - clamp(dot(V, H), 0.0, 1.0), 5.0);
        float g = pow(max(dot(Nf, H), 0.0), 160.0);
        vec3 spark = uSunColor * vVis * g * F * uSparkle;
        // white rime: light scattered inside the ice, a little warmer toward the sun
        float wrap = 0.45 + 0.55 * max(dot(N, uSunDir), 0.0);
        vec3 diff = vec3(0.78, 0.84, 0.92) * (uSunColor * vVis * wrap * 0.32 + uAmbient);
        float energy = mix(1.0, vEnergy, mix(0.5, 1.0 - uFarEnergy, uFar));
        // from afar a tuft is only there while it sparkles
        if (fract(vSeed * 13.7) < uFar) {
          if (dot(spark * energy, vec3(0.2126, 0.7152, 0.0722)) < 0.35) discard;
          diff = vec3(0.0);
        }
        gl_FragColor = vec4((diff + spark) * energy * uStrength, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

function moteMaterial(shared, fit) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shadowUniforms,
      uTime: shared.uTime,
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: sunHDR },
      uCenter: { value: new THREE.Vector3(PATCH.center.x, 0, PATCH.center.y) },
      uHalf: { value: new THREE.Vector2(0.75, 0.5) }, // wrap box (x, z): screen-right ≈ +x, screen-up ≈ −z
      uOrigin: { value: PATCH.center.clone() },
      uG0: { value: new THREE.Vector3(fit[0], fit[1], fit[2]) },
      uG1: { value: new THREE.Vector3(fit[3], fit[4], fit[5]) },
      uPatch: { value: new THREE.Vector4(PATCH.center.x, PATCH.center.y, PATCH.u.x, PATCH.u.y) },
      uPatchHalf: { value: new THREE.Vector2(PATCH.halfL, PATCH.halfW) },
      uPx: { value: 1000 },
      uFocus: { value: 0.85 },
      uBokeh: { value: DEW_TUNING.moteBokeh },
      uBright: { value: DEW_TUNING.moteBright },
      uGain: { value: DEW_TUNING.moteGain },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uCenter;
      uniform vec2 uHalf;
      uniform vec2 uOrigin;
      uniform vec3 uG0;
      uniform vec3 uG1;
      uniform vec4 uPatch;
      uniform vec2 uPatchHalf;
      uniform float uPx;
      uniform float uFocus;
      uniform float uBokeh;
      uniform float uBright;
      uniform float uGain;
      uniform float uStrength;
      varying float vI;
      varying float vBokeh;
      varying vec3 vTint;
      void main() {
        vec3 s = position; // 0 … 1
        float k = aSeed;
        float t = uTime;
        // a faint breeze plus lazy wandering; the field is fixed in the world and wraps around the view
        vec2 wander = vec2(sin(t * 0.13 + k * 40.0) + 0.5 * sin(t * 0.31 + k * 11.0), cos(t * 0.11 + k * 23.0) + 0.5 * cos(t * 0.27 + k * 17.0)) * 0.025;
        vec2 xz = uOrigin + (s.xz * 2.0 - 1.0) * uHalf + vec2(0.005, -0.003) * t + wander;
        vec2 rel = mod(xz - uCenter.xz + uHalf, 2.0 * uHalf) - uHalf;
        xz = uCenter.xz + rel;
        vec2 d = xz - uOrigin;
        float ground = uG0.x + uG0.y * d.x + uG0.z * d.y + uG1.x * d.x * d.x + uG1.y * d.x * d.y + uG1.z * d.y * d.y;
        float h = 0.03 + 0.37 * pow(s.y, 1.6) + 0.015 * sin(t * 0.17 + k * 31.0) + 0.006 * sin(t * 0.9 + k * 7.0);
        vec3 wp = vec3(xz.x, ground + h, xz.y);

        vec2 e = abs(rel) / uHalf;
        float fade = (1.0 - smoothstep(0.75, 1.0, e.x)) * (1.0 - smoothstep(0.75, 1.0, e.y));
        vec2 pd = xz - uPatch.xy;
        vec2 pu = vec2(dot(pd, uPatch.zw), dot(pd, vec2(-uPatch.w, uPatch.z)));
        fade *= 1.0 - smoothstep(uPatchHalf.x - 0.3, uPatchHalf.x, abs(pu.x));
        fade *= 1.0 - smoothstep(uPatchHalf.y - 0.3, uPatchHalf.y, abs(pu.y));

        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float dist = max(-mv.z, 0.03);
        fade *= smoothstep(0.08, 0.2, dist);

        // pollen and spores scatter mostly forward, but some light comes back from every grain
        float cosT = dot(normalize(wp - cameraPosition), uSunDir);
        float g = 0.55;
        float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
        float phase = 0.35 + 0.25 * hg;
        float twinkle = 0.7 + 0.3 * sin(t * (1.3 + 2.0 * k) + k * 50.0);

        // small and sharp at the focus distance, big soft discs close to the lens
        float sizeM = mix(0.00025, 0.0007, fract(k * 7.31));
        float px = sizeM * uPx / dist;
        float coc = uBokeh * abs(1.0 / dist - 1.0 / max(uFocus, 0.05));
        float drawPx = clamp(max(max(px, coc), 1.6), 1.6, 64.0);
        float area = max(px, 1.2);
        vBokeh = smoothstep(3.0, 10.0, coc);
        vI = uStrength * sunVisibilitySoft(wp) * phase * twinkle * fade * uBright * pow(area * area / (drawPx * drawPx), uGain);
        vTint = mix(vec3(1.0, 0.9, 0.62), vec3(1.0), step(0.6, fract(k * 3.7)));
        gl_PointSize = drawPx;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor;
      varying float vI;
      varying float vBokeh;
      varying vec3 vTint;
      void main() {
        if (vI < 1e-4) discard;
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r = length(q);
        if (r > 1.0) discard;
        float core = exp(-r * r * 3.5);
        float disc = (1.0 - smoothstep(0.82, 1.0, r)) * (0.7 + 0.3 * smoothstep(0.4, 0.95, r));
        gl_FragColor = vec4(uSunColor * vTint * vI * mix(core, disc, vBokeh), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// ── assembly ────────────────────────────────────────────────
function instanced(base, attrs, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const [k, v] of Object.entries(base.attributes)) g.setAttribute(k, v);
  for (const [k, [arr, size]] of Object.entries(attrs)) g.setAttribute(k, new THREE.InstancedBufferAttribute(arr, size));
  g.instanceCount = count;
  return g;
}

// deterministic Fisher–Yates
function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const _dir = new THREE.Vector3();

export function buildDew(ctx = {}) {
  const quality = ctx.quality ?? { tier: 'medium', plants: 0.7 };
  const tier = TIERS[quality.tier] ?? TIERS.medium;
  const plants = quality.plants ?? 0.7;
  const nMoss = Math.round(DEW_TUNING.mossDrops * plants);
  const nLeaf = Math.round(DEW_TUNING.leafDrops * plants);
  const nMotes = Math.round(DEW_TUNING.motes * plants);

  const group = new THREE.Group();
  group.name = 'flyover-dew';
  const shared = { uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1280, 720) }, uFar: { value: 0 } };

  const dropBase = dropGeometry(tier.segs, tier.rings);
  const frostBase = frostGeometry(tier.blades);
  const dropTris = dropBase.index.count / 3;
  const frostTris = frostBase.index.count / 3;

  const drops = new THREE.Mesh(new THREE.BufferGeometry(), dropMaterial(shared));
  drops.name = 'dew-drops';
  drops.frustumCulled = false;
  const frost = new THREE.Mesh(new THREE.BufferGeometry(), frostMaterial(shared));
  frost.name = 'dew-frost';
  frost.frustumCulled = false;
  const silk = new THREE.Mesh(new THREE.BufferGeometry(), silkMaterial(shared));
  silk.name = 'dew-silk';
  silk.frustumCulled = false;
  silk.renderOrder = 2;

  const seeds = moteSeeds(nMotes);
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(seeds.pos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds.k, 1));
  const motes = new THREE.Points(moteGeo, moteMaterial(shared, groundFit()));
  motes.name = 'dew-motes';
  motes.frustumCulled = false;
  motes.renderOrder = 3;
  group.add(drops, frost, silk, motes);

  const layout = { silkBeads: 0, dropTotal: 0, farDrops: 0, silkFrost: 0, frostTotal: 0, farFrost: 0, silkTris: 0, silkLength: 0, silkSlack: 0 };
  const season = { frost: 0, wet: 1, silk: 1, motes: 1 };
  const stats = { drawCalls: 4, triangles: 0, instances: 0 };
  let fallback = null;

  const vis = { drops: [], dropR: [], frost: [], frostS: [] };
  function setSites({ mossTips, leafSites, silk: silkOverride } = {}) {
    const rng = new RNG(6060);
    const useMoss = Array.isArray(mossTips) && mossTips.length ? mossTips : (fallback ??= makeFallback()).moss;
    const useLeaf = Array.isArray(leafSites) && leafSites.length ? leafSites : (fallback ??= makeFallback()).leaf;
    const mossPick = pickWeighted(useMoss, nMoss, rng, siteWeight);
    const leafPick = pickWeighted(useLeaf, nLeaf, rng, siteWeight);

    const anchors = silkOverride?.from && silkOverride?.to ? { from: silkOverride.from.clone(), to: silkOverride.to.clone() } : silkAnchors(leafSites ?? []);
    const s = buildSilk(anchors, { beadStep: tier.beadStep });

    // Buffer order decides what a shorter instance count keeps: first the largest drops (all that is left from
    // afar), then everything else shuffled, silk beads included, so a partial count thins evenly.
    const field = [...mossPick.map((p) => ['moss', mossDrop(p, rng)]), ...leafPick.map((p) => ['leaf', Object.assign(leafDrop(p, rng), { site: p })])];
    const frosted = field.map(([kind, d]) => frostFromDrop(d, kind, rng));
    const nDropFar = Math.max(6, Math.round((field.length + s.beads.length) * DEW_TUNING.farKeep));
    const nFrostFar = Math.max(6, Math.round((frosted.length + s.frost.length) * DEW_TUNING.farKeep));
    const byDrop = field.map((f) => f[1]).sort((a, b) => b.r - a.r);
    const byFrost = frosted.slice().sort((a, b) => b.size - a.size);
    const dropList = [...shuffle(byDrop.slice(0, nDropFar), rng), ...shuffle([...byDrop.slice(nDropFar), ...s.beads], rng)];
    const frostList = [...shuffle(byFrost.slice(0, nFrostFar), rng), ...shuffle([...byFrost.slice(nFrostFar), ...s.frost], rng)];

    const pd = packDrops(dropList);
    drops.geometry.dispose();
    drops.geometry = instanced(dropBase, { aDrop: [pd.aDrop, 4], aAxis: [pd.aAxis, 4], aInfo: [pd.aInfo, 4] }, pd.count);
    const pf = packFrost(frostList);
    frost.geometry.dispose();
    frost.geometry = instanced(frostBase, { aSite: [pf.aSite, 4], aAxis: [pf.aAxis, 4], aWaft: [pf.aWaft, 1] }, pf.count);
    silk.geometry.dispose();
    silk.geometry = silkGeometry(s.lines);

    Object.assign(layout, {
      silkBeads: s.beads.length,
      dropTotal: pd.count,
      farDrops: Math.min(nDropFar, pd.count),
      silkFrost: s.frost.length,
      frostTotal: pf.count,
      farFrost: Math.min(nFrostFar, pf.count),
      silkTris: silk.geometry.index.count / 3,
      silkLength: s.length,
      silkSlack: s.slack,
      moss: mossPick.length,
      leaf: leafPick.length,
    });
    // remember which leaf each drop and rime tuft sits on: a leaf that is not out yet (or already fallen) keeps none
    vis.drops = dropList.map((d) => d.site ?? null);
    vis.dropR = dropList.map((d) => d.r);
    vis.frost = frostList.map((f) => f.site ?? null);
    vis.frostS = frostList.map((f) => f.size);
    applySiteVis();
    refreshCounts(0);
  }

  // Plants set `vis` on their dew sites each season (0 … 1, leaf grown and still there); hide what rests on air.
  function applySiteVis() {
    const on = (s) => !s || s.vis === undefined || s.vis > 0.85;
    const dA = drops.geometry.getAttribute('aDrop');
    const fA = frost.geometry.getAttribute('aSite');
    let dirty = false;
    vis.drops.forEach((s, i) => {
      const r = on(s) ? vis.dropR[i] : 0;
      if (dA.array[i * 4 + 3] !== r) (dA.array[i * 4 + 3] = r), (dirty = true);
    });
    if (dirty) dA.needsUpdate = true;
    dirty = false;
    vis.frost.forEach((s, i) => {
      const r = on(s) ? vis.frostS[i] : 0;
      if (fA.array[i * 4 + 3] !== r) (fA.array[i * 4 + 3] = r), (dirty = true);
    });
    if (dirty) fA.needsUpdate = true;
  }

  function makeFallback() {
    return { moss: fallbackMossTips(Math.round(nMoss * 1.6)), leaf: fallbackLeafSites(Math.round(nLeaf * 1.6)) };
  }

  // How much of the buffers to draw at this distance: everything up to farStart, then a steep (exponential)
  // fall to the farKeep share of largest drops at farEnd, nothing beyond ~20 m.
  function lodShare(total, keep, far, dist) {
    if (total <= 0) return 0;
    const k = Math.min(1, keep / total);
    return Math.pow(k, far) * (1 - smoothstep(12, 20, dist));
  }

  // instance counts from distance (LOD) and season
  function refreshCounts(dist) {
    const far = smoothstep(DEW_TUNING.farStart, DEW_TUNING.farEnd, dist);
    shared.uFar.value = far;
    const wetK = Math.pow(season.wet, 0.6);
    const silkOn = season.silk > 0.01 && dist < 25;
    const nDrops = Math.round(layout.dropTotal * lodShare(layout.dropTotal, layout.farDrops, far, dist) * wetK);
    const nFrost = Math.round(layout.frostTotal * lodShare(layout.frostTotal, layout.farFrost, far, dist) * Math.pow(season.frost, 0.6));
    if (drops.geometry.isInstancedBufferGeometry) {
      drops.geometry.instanceCount = nDrops;
      frost.geometry.instanceCount = nFrost;
    }
    // the silk beads live in the drop buffer: on frosty mornings they vanish with the dew and rime takes over
    drops.visible = season.wet > 0.02 && nDrops > 0;
    frost.visible = season.frost > 0.02 && nFrost > 0;
    silk.visible = silkOn;
    const nm = motes.visible ? nMotes : 0;
    stats.drawCalls = [drops, frost, silk, motes].filter((m) => m.visible).length;
    stats.triangles = (drops.visible ? nDrops * dropTris : 0) + (frost.visible ? nFrost * frostTris : 0) + (silk.visible ? layout.silkTris : 0);
    stats.instances = (drops.visible ? nDrops : 0) + (frost.visible ? nFrost : 0) + nm;
  }

  function applySeason(sp, v) {
    Object.assign(season, dewState(sp, v));
    const du = drops.material.uniforms;
    // the world a drop sees follows the season's sky, haze and snow
    const hs = sp.hemiSky ?? [0.58, 0.7, 0.84];
    const hi = sp.hemiI ?? 0.82;
    const sky = sp.sky ?? [1, 1, 1];
    const fog = sp.fog ?? [0.3, 0.36, 0.34];
    const snow = sp.snow ?? 0;
    du.uSky.value.set(0.76 * sky[0], 0.92 * sky[1], 1.1 * sky[2]);
    du.uHorizon.value.set(fog[0] * 1.3, fog[1] * 1.3, fog[2] * 1.3);
    du.uCanopy.value.set(0.025, 0.04, 0.03).multiplyScalar(1 + 2 * snow);
    du.uGround.value.set(0.03, 0.045, 0.02).lerp(new THREE.Vector3(0.3, 0.32, 0.36), snow);
    for (const m of [drops, silk, frost]) m.material.uniforms.uAmbient.value.set(hs[0] * hi * 0.45, hs[1] * hi * 0.45, hs[2] * hi * 0.45);
    // drops shrink a little as the dew thins; rime thickens with the cold
    du.uScale.value = 0.6 + 0.4 * smoothstep(0, 1, season.wet);
    frost.material.uniforms.uGrowth.value = 0.55 + 0.45 * season.frost;
    silk.material.uniforms.uStrength.value = season.silk;
    motes.material.uniforms.uStrength.value = season.motes;
    applySiteVis();
  }

  function update(dt, time, state = {}) {
    const cam = state.camera ?? ctx.camera;
    shared.uTime.value = time;
    if (ctx.renderer && typeof ctx.renderer.getDrawingBufferSize === 'function') ctx.renderer.getDrawingBufferSize(shared.uViewport.value);
    const near = state.near ?? 1;
    const dist = state.dist ?? 0;
    motes.visible = near > 0.001 && dist < DEW_TUNING.farEnd && season.motes > 0.01 && !!cam;
    refreshCounts(dist);
    if (!cam || !motes.visible) return;

    const mu = motes.material.uniforms;
    const vpH = shared.uViewport.value.y;
    mu.uPx.value = cam.projectionMatrix.elements[5] * vpH * 0.5;
    // focus on the ground the camera looks at; the motes drift in a box centred there
    cam.getWorldDirection(_dir);
    const p = cam.position;
    const above = Math.max(0.05, p.y - heroHeightAt(p.x, p.z));
    const down = Math.max(0.2, -_dir.y);
    const hit = Math.min(above / down, 1.6);
    mu.uFocus.value = clamp(above / down, 0.3, Math.max(0.3, dist || 3));
    mu.uCenter.value.set(p.x + _dir.x * hit, 0, p.z + _dir.z * hit);
    mu.uStrength.value = season.motes * near * (1 - shared.uFar.value);
  }

  setSites({});
  applySeason({ dew: 1, snow: 0, dust: 1 }, 1.5);

  return {
    group,
    update,
    applySeason,
    setSites,
    stats,
    /** Current hoarfrost (0 … 1) and liquid dew (0 … 1), for modules that want to whiten or wet their surfaces. */
    get frost() {
      return season.frost;
    },
    get wet() {
      return season.wet;
    },
    layout,
  };
}
