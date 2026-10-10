import * as THREE from 'three';
import { heightAt } from '../terrain.js';
import { fbm2, noise2, smoothstep } from '../../lib/random.js';

// The flyover: between "Experience" and "Contact" the camera tips straight down and glides about two metres
// low over the forest floor, then rises and finds the seedling. This file is the shared contract between the
// flyover modules (camera, floor surface, litter, moss & lichen, plants & fungi, life, dew & light): where the
// glide runs, which patch of ground gets the close-up detail, where things grow, and what season it is.
//
// Coordinates: world metres, y up, the walk heads toward -Z. The patch has its own frame:
//   u — along the glide (−PATCH.halfL … +PATCH.halfL, increasing in the direction of travel)
//   v — across it (−PATCH.halfW … +PATCH.halfW, +v is to the camera's right while it travels)
// Looking straight down, screen-up is +u and screen-right is +v.
//
// Every module exports  build<Name>(ctx) → { group, update(dt, time, state), applySeason(sp, v), stats }
//   ctx   = world.ctx: { scene, camera, sun, surfaces, foliage, noise, trees, eco, quality, renderer }
//   state = { camera, dist (camera → patch centre, m), near (0 … 1, 1 when the camera is within ~2.5 m), look }
//   sp    = blended season params from seasons.js (sp.snow, sp.dew, sp.litter, sp.leaves, sp.<group>.color …)
//   v     = continuous season value (0 = 1 March, 1 = 1 June, 2 = 1 September, 3 = 1 December, wraps at 4)
//   stats = { drawCalls, triangles, instances }
// world.js adds `group` to the scene, hides it when the camera is far away, and calls update/applySeason.

// ── the glide ───────────────────────────────────────────────
export const FLY = {
  // Placed where the canopy lets the most morning sun through (measured from the sun's shadow map: about 30 % of
  // the floor here lies in sunflecks, against about 9 % on the walking line). The flecks run as long streaks
  // almost parallel to the glide, because the sun stands nearly straight ahead.
  start: new THREE.Vector2(0.134, -10.3), // camera footprint where the top-down glide begins
  end: new THREE.Vector2(0.266, -12.3), // … and where it ends (≈ 2 m further along the walk)
  altitude: 0.85, // camera height above the ground while looking straight down
  fov: 45, // vertical field of view during the glide (degrees)
};

// ── the hero patch: the ground the camera sees from above ──
const dir = new THREE.Vector2().subVectors(FLY.end, FLY.start).normalize();
export const PATCH = {
  center: new THREE.Vector2().addVectors(FLY.start, FLY.end).multiplyScalar(0.5),
  u: dir.clone(), // unit vector along the glide (x, z)
  v: new THREE.Vector2(-dir.y, dir.x), // unit vector across it (x, z), to the camera's right
  halfL: 1.9, // half length along u (m)
  halfW: 1.0, // half width along v (m)
  fade: 0.35, // detail fades out over this band at the border (m)
};
// `v` above points to the camera's right: travelling toward -Z (dir ≈ (0.07, -1)), right is +X.
if (PATCH.v.x < 0) PATCH.v.negate();

/** World (x, z) → patch frame { u, v }. */
export function toPatch(x, z) {
  const dx = x - PATCH.center.x;
  const dz = z - PATCH.center.y;
  return { u: dx * PATCH.u.x + dz * PATCH.u.y, v: dx * PATCH.v.x + dz * PATCH.v.y };
}

/** Patch frame (u, v) → world { x, z }. */
export function fromPatch(u, v) {
  return {
    x: PATCH.center.x + PATCH.u.x * u + PATCH.v.x * v,
    z: PATCH.center.y + PATCH.u.y * u + PATCH.v.y * v,
  };
}

/** 1 deep inside the patch, easing to 0 at its border (over PATCH.fade metres). */
export function patchFade(x, z) {
  const { u, v } = toPatch(x, z);
  const du = PATCH.halfL - Math.abs(u);
  const dv = PATCH.halfW - Math.abs(v);
  return smoothstep(0, PATCH.fade, Math.min(du, dv));
}

/** True inside the patch rectangle grown by `margin` metres. */
export function inPatch(x, z, margin = 0) {
  const { u, v } = toPatch(x, z);
  return Math.abs(u) <= PATCH.halfL + margin && Math.abs(v) <= PATCH.halfW + margin;
}

// ── shared ground height ────────────────────────────────────
// The close-up floor is a little lumpier than the terrain: humus, root bumps, a sunken old stump hollow.
// Every module places things on heroHeightAt so nothing floats or sinks.
export function microRelief(x, z) {
  const lumps = fbm2(x * 2.6 + 31.7, z * 2.6 - 8.3, 3) * 0.022; // humus swells
  const fine = noise2(x * 11.0 - 4.1, z * 11.0 + 2.9) * 0.004; // crumbs and needle mats
  // an old pine root running diagonally under the moss
  const { u, v } = toPatch(x, z);
  const rootLine = v - (0.42 * u - 0.15) - 0.06 * Math.sin(u * 2.3);
  const root = 0.026 * Math.exp(-(rootLine * rootLine) / (2 * 0.035 * 0.035)) * smoothstep(-1.6, -0.9, u) * smoothstep(1.2, 0.5, u);
  return lumps + fine + root;
}

export function heroHeightAt(x, z) {
  return heightAt(x, z) + microRelief(x, z) * patchFade(x, z);
}

export function heroNormalAt(x, z, e = 0.01, out = new THREE.Vector3()) {
  const hx = heroHeightAt(x + e, z) - heroHeightAt(x - e, z);
  const hz = heroHeightAt(x, z + e) - heroHeightAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// ── who grows where (patch frame, metres) ───────────────────
// Low things carpet the glide line; taller plants stand off to the sides so they rise past the camera.
// Each module keeps out of the others' spots (radius r) unless the spot says it may share.
export const SPOTS = {
  // plants & fungi
  // Fern spots cover the ground footprint (crown, old stipe bases, last year's fronds); the fronds themselves
  // arch in over the glide line up to ~0.42 m from the crown, at least 5 cm above the ground outside the spot.
  fernLeft: { u: -0.76, v: -0.54, r: 0.16, owner: 'plants' }, // lady-fern clump
  fernRight: { u: 0.98, v: 0.5, r: 0.16, owner: 'plants' }, // narrow buckler-fern clump (holds the silk thread)
  fiddleheadsA: { u: -0.255, v: 0.085, r: 0.06, owner: 'plants' }, // hero: young lady-fern crown in the sun pool, beside the ant trail, in view on phones too
  fiddleheadsB: { u: 0.09, v: -0.145, r: 0.06, owner: 'plants' }, // young buckler-fern crown under the glide line
  bilberry: { u: -1.35, v: 0.42, r: 0.3, owner: 'plants' },
  lingon: { u: 0.15, v: 0.3, r: 0.22, owner: 'plants' },
  twinflower: { u: 1.15, v: -0.3, r: 0.25, owner: 'plants' }, // Linnaea borealis, a creeping mat
  woodSorrel: { u: -0.97, v: -0.22, r: 0.11, owner: 'plants' }, // in the shade, as Oxalis likes it
  chanterelles: { u: 0.45, v: -0.12, r: 0.12, owner: 'plants' },
  // the lucky mushrooms, seen as the camera tips down (the spots hold the stems; the caps overhang the moss)
  flyAgaric: { u: -0.95, v: 0.41, r: 0.07, owner: 'plants' }, // a mature cap, a younger domed one and a button, in a sun fleck
  flyAgaricB: { u: -0.05, v: 0.6, r: 0.05, owner: 'plants' }, // a single fine specimen, first seen as the tip-down begins
  // moss & lichen (moss carpets cover most of the patch anyway; these are the special bits)
  reindeerLichen1: { u: 1.5, v: 0.35, r: 0.22, owner: 'moss' },
  reindeerLichen2: { u: -0.7, v: 0.55, r: 0.16, owner: 'moss' },
  haircapMoss: { u: 0.55, v: 0.62, r: 0.18, owner: 'moss', shares: ['plants'] },
  // litter & debris
  pineCone: { u: -0.45, v: 0.08, r: 0.06, owner: 'litter' },
  spruceCone: { u: 1.05, v: 0.12, r: 0.08, owner: 'litter' },
  lichenTwig: { u: 0.9, v: -0.8, r: 0.28, owner: 'litter' }, // a fallen pine twig, 60 cm, with beard lichen
  barkFlakes: { u: -0.75, v: 0.05, r: 0.16, owner: 'litter' },
  // life
  anthill: { u: -1.75, v: -0.85, r: 0.22, owner: 'life' }, // edge of a red wood ant mound, mostly outside the frame
  beetle: { u: 0.05, v: -0.4, r: 0.05, owner: 'life' },
  ladybird: { u: 0.18, v: 0.31, r: 0.02, owner: 'life', shares: ['plants'] }, // sits on a lingon leaf
  spider: { u: 0.35, v: -0.42, r: 0.1, owner: 'life' }, // a wolf spider's hunting ground
  // dew & light
  silkThread: { u: 0.7, v: 0.2, r: 0.3, owner: 'dew', shares: ['plants', 'moss', 'litter'] }, // a dewy spider line between fern and twig
};

/** The ant trail: from the mound across the glide line, under the camera. Patch frame points. */
export const ANT_TRAIL = [
  [-1.75, -0.85],
  [-1.2, -0.55],
  [-0.6, -0.2],
  [-0.1, 0.02],
  [0.5, 0.1],
  [1.1, 0.0],
  [1.7, 0.18],
  [2.3, 0.3],
];

/** Distance to the nearest spot of another module (Infinity if none). Use it to keep out of each other's way. */
export function clearOfOthers(u, v, owner) {
  let best = Infinity;
  for (const s of Object.values(SPOTS)) {
    if (s.owner === owner || (s.shares && s.shares.includes(owner))) continue;
    best = Math.min(best, Math.hypot(u - s.u, v - s.v) - s.r);
  }
  return best;
}

// ── the calendar ────────────────────────────────────────────
// Month of the year (1 = 1 January … 12.97 = end of December) from the season value.
export function monthOf(v) {
  const m = 3 + 3 * (((v % 4) + 4) % 4);
  return m > 13 ? m - 12 : m;
}

// Smooth 0 … 1 window over months [a, b] with soft edges (ramp, in months), wrapping over New Year.
function windowMonths(m, a, b, ramp = 0.35) {
  const inside = (x) => smoothstep(a - ramp, a + ramp, x) * (1 - smoothstep(b - ramp, b + ramp, x));
  return Math.max(inside(m), inside(m + 12), inside(m - 12));
}

/**
 * What the forest floor is doing at season value v (Värmland, ~59° N). All weights 0 … 1.
 * Snow comes from the season params (sp.snow), not from here, so the slider and the snow always agree.
 */
export function phenology(v) {
  const m = monthOf(v);
  return {
    month: m,
    croziers: windowMonths(m, 5.4, 8.3, 0.4), // fern fiddleheads unfurling, late May – August (lady fern keeps sending up new croziers)
    fernFronds: windowMonths(m, 5.9, 10.6, 0.5), // open fronds (colour handled by the 'fern' season group)
    bilberryFlowers: windowMonths(m, 5.1, 6.2, 0.25),
    bilberries: windowMonths(m, 7.3, 9.0, 0.3), // ripe blue-black berries
    lingonFlowers: windowMonths(m, 6.0, 7.0, 0.25), // pale pink bells
    lingonUnripe: windowMonths(m, 7.0, 8.4, 0.3),
    lingonberries: windowMonths(m, 8.4, 11.2, 0.35), // ripe red, some hang on under the snow
    twinflowers: windowMonths(m, 6.5, 7.8, 0.25),
    woodSorrelFlowers: windowMonths(m, 5.0, 6.3, 0.25),
    chanterelles: windowMonths(m, 7.5, 10.3, 0.4),
    flyAgaric: windowMonths(m, 7.0, 10.6, 0.4), // fly agarics (lucky mushrooms) from July through October
    ants: windowMonths(m, 4.0, 10.0, 0.5), // active on warm days
    beetles: windowMonths(m, 5.0, 9.5, 0.5),
    freshBirchLeaves: windowMonths(m, 9.4, 11.2, 0.4), // newly fallen yellow leaves (older litter stays all year)
  };
}
