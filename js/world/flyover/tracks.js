import * as THREE from 'three';
import * as CFG from './config.js';
import { RNG, noise2, smoothstep, clamp } from '../../lib/random.js';
import { shadowUniforms } from '../details.js';
import { SUN_DIR } from '../layout.js';

// Winter stories in the snow: a red squirrel bounded in from the pines, sat at its cone table and left again;
// an older squirrel track, half filled by fresh snow; two tits gleaned the spilled seeds, one flew off and
// brushed the snow with its wings.
//
// Each print is a decal lying on the snow: a baked height field (atlas, eight tiles) traced with parallax,
// self-shadowed toward the sun and darkened where less sky reaches into the hollow. The decal does not paint
// a colour: it multiplies whatever snow is drawn underneath (floor, or snow-filled moss shells) by the ratio
// "lit dent / lit flat snow", so it always matches the snow's own shading. A small pull toward the camera
// along the view ray (same pixel, nearer depth) lets it win over snow-filled moss shells up to 7 cm thick.
// One draw call for everything.

// ── tuning knobs ────────────────────────────────────────────
export const TRACKS = {
  show: [0.42, 0.62], // sp.snow over which the tracks fade in (matches the ground turning white); hidden below 0.4
  depth: [0.5, 1.0], // print depth multiplier from thin to deep snow (sp.snow 0.5 → 0.95)
  squirrelDepth: 0.017, // m, a fresh bounding print in powder
  birdDepth: 0.011, // m, scale of the bird tiles (their toes are baked shallower)
  bias: 0.07, // m the decals are pulled toward the camera (snow-filled moss shells reach ~6 cm)
  groupGap: [0.36, 0.58], // m between bounding groups in the open (closer near the cone site)
  oldAge: 0.7, // 0 fresh … 1 filled in: the older track
  maxDist: 9, // m beyond which the decals are not drawn
  debris: 0, // flat scale-and-seed decals round the table (0: litter's winter midden lies there in 3D)
};

const SIZE = 128; // texels per tile
// physical tile sizes (mm, along travel × across)
const TILES = {
  frontBound: { i: 0, w: 70, h: 50 },
  frontPlant: { i: 1, w: 70, h: 50 },
  hindBound: { i: 2, w: 100, h: 64 },
  hindSit: { i: 3, w: 100, h: 64 },
  birdA: { i: 4, w: 50, h: 50 },
  birdB: { i: 5, w: 50, h: 50 },
  wings: { i: 6, w: 110, h: 110 },
  debris: { i: 7, w: 70, h: 70 },
};

/**
 * Top of the snow at world (x, z) for season snow s (0 … 1). The one place the tracks ask.
 * If config.js exports snowTopAt(x, z, snow) (shared by floor, moss and plants), that wins; until then the snow is
 * drawn on the floor itself, i.e. on heroHeightAt (plants sink into it instead, by 0.1 m · smoothstep(0.08, 1, s)).
 */
export function snowTopAt(x, z, snow = 1) {
  return typeof CFG.snowTopAt === 'function' ? CFG.snowTopAt(x, z, snow) : CFG.heroHeightAt(x, z);
}

// ── baking the height atlas (pure CPU) ──────────────────────
// Tile texels: R = height (0.5 = snow level, 0 = full print depth, 1 = as high above), G = "something here"
// mask (dilated, lets the shader skip flat snow), B = debris tone (dark seed … pale wing), A = debris cover.
// Shapes are precomputed once per tile (no trig, no allocation per texel); `c, s` = cos, sin of the rotation.
const sdEllipse = (x, z, cx, cz, rx, rz, c = 1, s = 0) => {
  const px = (x - cx) * c + (z - cz) * s;
  const pz = -(x - cx) * s + (z - cz) * c;
  const qx = px / rx;
  const qz = pz / rz;
  return (Math.sqrt(qx * qx + qz * qz) - 1) * (rx < rz ? rx : rz);
};
const sdCapsule = (x, z, ax, az, bx, bz, r) => {
  const dx = bx - ax;
  const dz = bz - az;
  let t = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x - ax - dx * t;
  const ez = z - az - dz * t;
  return Math.sqrt(ex * ex + ez * ez) - r;
};
const smin = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
};
// a print wall: 0 outside (d > edge), 1 at the bottom (d < -soft)
const wall = (d, edge = 1.0, soft = 2.8) => smoothstep(edge, -soft, d);
const deg = (a) => (a * Math.PI) / 180;

// what one texel holds
const FO = { h: 0, tone: 0, cover: 0 };

// A paw: pads + toes + claws with depth fractions, entry drag behind, toe drag and spray ahead, a crumbly rim.
function paw(x, z, P) {
  if (x < P.box[0] || x > P.box[1] || z < -P.box[2] || z > P.box[2]) return 0;
  // crumbled edges: the wall wanders at the scale of snow clumping (≈ 5 mm), with a little grain on top
  const jx = x + 1.0 * noise2(x * 0.18 + P.seed, z * 0.18) + 0.25 * noise2(x * 0.6, z * 0.6 + P.seed);
  const jz = z + 1.0 * noise2(x * 0.18, z * 0.18 - P.seed) + 0.25 * noise2(x * 0.6 - P.seed, z * 0.6);
  let dAll = 1e3;
  let depth = 0;
  for (let i = 0; i < P.pads.length; i++) {
    const p = P.pads[i];
    const d = sdEllipse(jx, jz, p.cx, p.cz, p.rx, p.rz);
    dAll = smin(dAll, d, 2.0);
    depth = Math.max(depth, p.f * wall(d));
  }
  for (let i = 0; i < P.toes.length; i++) {
    const t = P.toes[i];
    // the toe pad, and a narrower, shallower stalk back toward the palm
    const dP = sdEllipse(jx, jz, t.cx, t.cz, t.rx, t.rz, t.ca, t.sa);
    const dS = sdCapsule(jx, jz, t.sx, t.sz, t.cx, t.cz, t.stalk);
    dAll = smin(dAll, Math.min(dP, dS + 0.8), 1.4);
    depth = Math.max(depth, t.f * wall(dP, 0.8, 2.0), 0.45 * t.f * wall(dS, 0.4, 1.2));
    // claw: a narrow slit just beyond the pad
    const dC = sdCapsule(x, z, t.kx, t.kz, t.ex, t.ez, 0.5);
    depth = Math.max(depth, 0.42 * t.f * wall(dC, 0.4, 0.9));
    dAll = Math.min(dAll, dC + 0.6);
    // exit: the claw flicks a short furrow forward
    if (P.toeDrag) depth = Math.max(depth, 0.14 * wall(sdCapsule(x, z, t.ex, t.ez, t.gx, t.gz, 0.75), 0.5, 1.0));
  }
  // entry: the foot came in from behind, low, and dragged a ramp into the snow
  if (P.entry) {
    const E = P.entry;
    const dE = sdCapsule(jx, jz, E.x0, 0, E.x0 - E.len, 0, E.r);
    const along = clamp((E.x0 - x) / E.len, 0, 1);
    depth = Math.max(depth, 0.55 * (1 - along) ** 1.4 * wall(dE, 1.0, 2.5));
    dAll = smin(dAll, dE + along * 3, 3.0);
  }
  let h = -depth;
  // the displaced snow: a low ridge round the hole, higher where the foot pushed, broken into crumbs
  if (dAll > -1 && dAll < 9) {
    const front = P.spray ? smoothstep(-5, 15, x - P.spray.x0) : 0.5;
    const band = Math.exp(-(((dAll - 2.4) / 2.4) ** 2));
    h += (0.05 + 0.08 * front) * band * (0.7 + 0.6 * (0.5 + 0.5 * noise2(x * 0.25 + P.seed, z * 0.25)));
    // a few chunks broken off the edge, mostly where the foot pushed
    h += 0.55 * Math.max(0, noise2(x * 0.38 + P.seed, z * 0.38 - P.seed) - 0.62) * Math.exp(-(((dAll - 3.0) / 2.6) ** 2)) * (0.4 + 0.6 * front);
  }
  // spray: clods thrown ahead on take-off
  if (P.spray) {
    const C = P.spray.clods;
    for (let i = 0; i < C.length; i += 4) {
      const dx = x - C[i];
      const dz = z - C[i + 1];
      const d2 = (dx * dx + dz * dz) / (C[i + 2] * C[i + 2]);
      if (d2 < 1) h += C[i + 3] * (1 - d2) ** 1.5;
    }
  }
  return h;
}

function squirrelPaw(kind, rng) {
  const seed = rng.float(0, 100);
  const pads = [];
  const toes = [];
  const pad = (cx, cz, rx, rz, f) => pads.push({ cx, cz, rx, rz, f });
  const toe = (tx, a, dist, r0, rx, rz, stalk, f, claw, drag) => {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const cx = tx + ca * dist;
    const cz = sa * dist;
    const kx = cx + ca * (rx + 0.4);
    const kz = cz + sa * (rx + 0.4);
    const ex = kx + ca * claw;
    const ez = kz + sa * claw;
    toes.push({ ca, sa, cx, cz, rx, rz, stalk, f, sx: tx + ca * r0, sz: sa * r0, kx, kz, ex, ez, drag });
  };
  if (kind === 'front') {
    // front foot (left, 3 cm): a rounded palm, two carpal pads behind, four toe pads in an arc (outer first)
    const ox = -2;
    pad(ox, 0, 6.0, 7.0, 1.0);
    pad(ox - 8, -3.4, 3.0, 2.8, 0.85);
    pad(ox - 7.5, 3.6, 2.6, 2.4, 0.8);
    for (const [a, dist] of [[-46, 11], [-15, 12.5], [15, 12.5], [42, 10.5]]) {
      toe(ox, deg(a + rng.float(-5, 5)), dist * rng.float(0.94, 1.06), 5.5, 3.0, 2.3, 1.1, 0.85, rng.float(2.0, 3.0), rng.float(0.6, 1.4));
    }
    return { pads, toes, seed, ox, box: [-36, 36, 20] };
  }
  // hind foot (left, 5 cm): long sole with the heel, five slender toes spread like a hand (inner toe shortest)
  const ox = 2;
  pad(ox - 7, 0, 13, 6.2, 1.0);
  pad(ox + 4, 0, 5.5, 7.5, 0.95);
  for (const [a, dist] of [[-50, 12], [-21, 16], [0, 17], [21, 16], [48, 10]]) {
    toe(ox + 5, deg(a + rng.float(-6, 6)), dist * rng.float(0.94, 1.06), 4, 3.2, 2.2, 1.6, 0.8, rng.float(2.8, 4.0), rng.float(0.6, 1.4));
  }
  return { pads, toes, seed, ox, box: [-50, 50, 28] };
}

function birdFoot(cx, cz, rot, rng, side) {
  const toes = [];
  for (const [a0, len0] of [[-30, 10.5], [0, 12.5], [30, 10.5], [180, 8.5]]) {
    const a = deg(a0 * side + rng.float(-6, 6)) + rot;
    const len = len0 * rng.float(0.92, 1.08);
    const ex = cx + Math.cos(a) * len;
    const ez = cz + Math.sin(a) * len;
    toes.push({ ex, ez, cx2: ex + Math.cos(a) * 1.8, cz2: ez + Math.sin(a) * 1.8 });
  }
  return { cx, cz, toes };
}
function birdField(x, z, feet) {
  let depth = 0;
  let dAll = 1e3;
  for (let i = 0; i < feet.length; i++) {
    const f = feet[i];
    if (Math.abs(x - f.cx) > 17 || Math.abs(z - f.cz) > 17) continue;
    for (let k = 0; k < f.toes.length; k++) {
      const t = f.toes[k];
      const d = sdCapsule(x, z, f.cx, f.cz, t.ex, t.ez, 0.85);
      const dc = sdCapsule(x, z, t.ex, t.ez, t.cx2, t.cz2, 0.4);
      depth = Math.max(depth, 0.42 * wall(d, 0.5, 1.2), 0.25 * wall(dc, 0.3, 0.6));
      dAll = Math.min(dAll, d);
    }
    const dk = Math.sqrt((x - f.cx) ** 2 + (z - f.cz) ** 2) - 1.6; // the "palm" where the toes meet
    depth = Math.max(depth, 0.45 * wall(dk, 0.5, 1.2));
  }
  return -depth + (dAll < 8 ? 0.05 * Math.exp(-(((dAll - 1.4) / 1.3) ** 2)) : 0);
}

// Take-off: the bird crouched, sprang, and its primaries brushed the snow in a fan on both sides.
function wingField(x, z, feet, W) {
  let depth = 0.26 * wall(sdEllipse(x, z, 0, 0, 9, 6.5), 0.8, 3); // the body pressed down for the jump
  for (let i = 0; i < W.length; i++) {
    // each primary: a short, slightly bent stroke from the wrist outward, its tip digging in deepest
    const f = W[i];
    const d = Math.min(sdCapsule(x, z, f.ox, f.oz, f.mx, f.mz, 0.9), sdCapsule(x, z, f.mx, f.mz, f.ex, f.ez, 0.7));
    if (d > 1) continue;
    const t = clamp(Math.sqrt((x - f.ox) ** 2 + (z - f.oz) ** 2) / f.len, 0, 1);
    depth = Math.max(depth, (0.08 + 0.24 * t * t) * f.k * wall(d, 0.5, 0.9));
  }
  return Math.min(-depth, birdField(x, z, feet));
}
function wingFeathers(rng) {
  const W = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 7; k++) {
      if (k > 0 && rng.chance(0.15)) continue; // not every feather touched the snow
      const a = deg(84 + k * 12 + rng.float(-4, 4)) * side; // from straight out to well behind
      const len = (22 + 14 * (1 - k / 6)) * rng.float(0.8, 1.15); // the outer primaries are the longest
      const bend = side * rng.float(0.5, 2.0);
      const ox = 3 + Math.cos(a) * 7;
      const oz = side * 9 + Math.sin(a) * 7;
      const ex = ox + Math.cos(a) * len;
      const ez = oz + Math.sin(a) * len;
      W.push({ ox, oz, ex, ez, mx: (ox + ex) * 0.5 - Math.sin(a) * bend, mz: (oz + ez) * 0.5 + Math.cos(a) * bend, len, k: rng.float(0.6, 1.0) });
    }
  }
  return W;
}

function debrisField(x, z, items) {
  FO.h = 0;
  FO.tone = 0;
  FO.cover = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (Math.abs(x - it.x) > 9 || Math.abs(z - it.z) > 9) continue;
    let d = sdEllipse(x, z, it.x, it.z, it.rx, it.rz, it.c, it.s);
    if (it.kind === 'scale') d += 0.6 * Math.abs(noise2(x * 0.5 + it.x, z * 0.5));
    const c = smoothstep(0.35, -0.35, d);
    if (c > FO.cover * 0.999) {
      FO.tone = it.tone;
      FO.cover = Math.max(FO.cover, c);
      FO.h = Math.max(FO.h, it.hh * c);
    }
  }
  return FO;
}

/** Bakes the eight tiles into an RGBA8 atlas (4 × 2 tiles of SIZE²). Pure; returns { data, width, height }. */
export function bakeTrackAtlas(seed = 31) {
  const out = { data: new Uint8Array(SIZE * 4 * SIZE * 2 * 4), width: SIZE * 4, height: SIZE * 2 };
  for (const _ of bakeTiles(seed, out.data)) void _;
  return out;
}

// The same bake one tile per step, so the page can do it in slices while it loads.
function* bakeTiles(seed, data) {
  const rng = new RNG(seed);
  const W = SIZE * 4;
  const hgt = new Float32Array(SIZE * SIZE);
  const extra = new Float32Array(SIZE * SIZE * 2);
  const any = new Uint8Array(SIZE * SIZE);
  const rows = new Uint8Array(SIZE * SIZE);
  const heightOnly = (h) => {
    FO.h = h;
    FO.tone = 0;
    FO.cover = 0;
    return FO;
  };
  for (const [name, T] of Object.entries(TILES)) {
    let field;
    if (name.startsWith('front') || name.startsWith('hind')) {
      const front = name.startsWith('front');
      const P = squirrelPaw(front ? 'front' : 'hind', rng);
      const back = front ? P.ox - 12 : P.ox - 20;
      if (name.endsWith('Bound')) {
        P.entry = { x0: back + 3, len: rng.float(10, 16), r: front ? 5.5 : 6.5 };
        P.toeDrag = rng.float(3, 5);
        for (const t of P.toes) {
          t.gx = t.ex + P.toeDrag * t.drag;
          t.gz = t.ez + t.sa * P.toeDrag * 0.3;
        }
        const tipX = front ? P.ox + 17 : P.ox + 27;
        const clods = [];
        for (let k = 0; k < 8; k++) clods.push(tipX + rng.float(2, 11), rng.float(-13, 13), rng.float(0.9, 2.2), rng.float(0.05, 0.13));
        P.spray = { x0: tipX - 6, clods };
      } else if (name === 'hindSit') {
        // sitting: the whole sole down, heel deepest
        P.pads[0] = { cx: P.ox - 9, cz: 0, rx: 15.5, rz: 6.5, f: 1.0 };
      }
      field = (x, z) => heightOnly(paw(x, z, P));
    } else if (name.startsWith('bird')) {
      const stagger = name === 'birdB' ? rng.float(3, 6) : rng.float(-1.5, 1.5);
      const feet = [birdFoot(-stagger / 2, -8.5, deg(rng.float(-8, 4)), rng, -1), birdFoot(stagger / 2, 8.5, deg(rng.float(-4, 8)), rng, 1)];
      field = (x, z) => heightOnly(birdField(x, z, feet));
    } else if (name === 'wings') {
      const feet = [birdFoot(-7, -5, 0, rng, -1), birdFoot(-7, 5, 0, rng, 1)];
      const Wf = wingFeathers(rng);
      field = (x, z) => heightOnly(wingField(x, z, feet, Wf));
    } else {
      // fresh spruce scales and seeds the squirrel dropped on top of the snow (seeds with their pale wings)
      const items = [];
      const item = (kind, x, z, rx, rz, a, tone, hh) => items.push({ kind, x, z, rx, rz, c: Math.cos(a), s: Math.sin(a), tone, hh });
      for (let k = 0; k < 3; k++) item('scale', rng.float(-22, 22), rng.float(-22, 22), rng.float(6, 7.5), rng.float(5, 6), rng.float(0, 6.3), rng.float(0.3, 0.42), 0.09);
      for (let k = 0; k < 4; k++) {
        const x = rng.float(-25, 25);
        const z = rng.float(-25, 25);
        const a = rng.float(0, 6.3);
        item('wing', x + Math.cos(a) * 5, z + Math.sin(a) * 5, 5.5, 2.6, a, 0.85, 0.03);
        item('seed', x, z, 2.2, 1.5, a, 0.05, 0.08);
      }
      field = (x, z) => debrisField(x, z, items);
    }
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const x = ((i + 0.5) / SIZE - 0.5) * T.w;
        const z = ((j + 0.5) / SIZE - 0.5) * T.h;
        // keep a flat margin so the tile edge (and atlas bleeding) is plain snow
        const edge = Math.min(i, j, SIZE - 1 - i, SIZE - 1 - j);
        const fade = smoothstep(1, 6, edge);
        const f = field(x, z);
        const k = j * SIZE + i;
        hgt[k] = clamp(f.h * fade, -1, 1);
        extra[k * 2] = f.tone;
        extra[k * 2 + 1] = f.cover * fade;
      }
    }
    // mask: anything here, dilated by 5 texels so parallax never steps off it (separable: rows, then columns)
    const ox = (T.i % 4) * SIZE;
    const oy = Math.floor(T.i / 4) * SIZE;
    for (let k = 0; k < SIZE * SIZE; k++) any[k] = Math.abs(hgt[k]) > 0.004 || extra[k * 2 + 1] > 0.01 ? 1 : 0;
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        let m = 0;
        for (let a = Math.max(0, i - 5); a <= Math.min(SIZE - 1, i + 5) && !m; a++) m = any[j * SIZE + a];
        rows[j * SIZE + i] = m;
      }
    }
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        let m = 0;
        for (let b = Math.max(0, j - 5); b <= Math.min(SIZE - 1, j + 5) && !m; b++) m = rows[b * SIZE + i];
        const k = j * SIZE + i;
        const o = ((oy + j) * W + ox + i) * 4;
        data[o] = Math.round(clamp(0.5 + 0.5 * hgt[k], 0, 1) * 255);
        data[o + 1] = m * 255;
        data[o + 2] = Math.round(clamp(extra[k * 2], 0, 1) * 255);
        data[o + 3] = Math.round(clamp(extra[k * 2 + 1], 0, 1) * 255);
      }
    }
    yield name;
  }
}

// ── the stories (patch frame) ───────────────────────────────
// Things that stay above deep snow and must not get a print drawn over them (the decals are pulled toward
// the camera, so they would): cones, the hero twig, shrubs, the mound, and litter's gnawed cores.
const AVOID = ['pineCone', 'spruceCone', 'lichenTwig', 'bilberry', 'lingon', 'anthill'];
const SQUIRREL_SITE = { u: -0.28, v: 0.44 }; // litter's summer cone table
const CORES = { u: -0.29, v: 0.43, r: 0.07 }; // the cores on it (visible until the snow is deep)
// litter's fresh winter midden on the snow beside it (litter.js winterSet: centre SQUIRREL + (−0.03, −0.1)):
// three stripped cores lying on top of the snow (u, v, keep-out r), and the scales round them
const MIDDEN = { u: -0.31, v: 0.34 };
const WINTER_CORES = [[-0.28, 0.36, 0.06], [-0.36, 0.31, 0.06], [-0.24, 0.28, 0.06]];
const PATHS = {
  // in from the pine behind the hero twig (patch u 2.5, v -1.4), diagonally under the glide, below the lingon
  squirrelIn: [[1.66, -0.78], [1.32, -0.6], [1.0, -0.45], [0.62, -0.27], [0.3, -0.1], [0.05, 0.02], [-0.12, 0.09], [-0.24, 0.13]],
  // and out toward the pine on the right (patch u 1.2, v 4.1)
  squirrelOut: [[-0.13, 0.52], [-0.11, 0.64], [-0.05, 0.78]],
  // an older visit, days ago: softened and half filled by new snow
  squirrelOld: [[-1.2, -0.78], [-1.0, -0.35], [-0.86, 0.05], [-0.93, 0.45], [-0.88, 0.78]],
};

function curve(points) {
  const c = new THREE.SplineCurve(points.map(([u, v]) => new THREE.Vector2(u, v)));
  c.arcLengthDivisions = 1000;
  return c;
}

/**
 * Where every print goes. Returns [{ tile, u, v, heading, depth (m), mirror (±1), age, group }] in the patch frame.
 * Pure and deterministic.
 */
export function trackLayout(seed = 77) {
  const rng = new RNG(seed);
  const out = [];
  let gid = 0; // bounding groups are kept or dropped as a whole
  const put = (tile, u, v, heading, depth, mirror, age, group, g = -1) => out.push({ tile, u, v, heading, depth, mirror, age, group, gid: g });
  const cu = new THREE.Vector2();
  const ct = new THREE.Vector2();

  // A bounding group: the small front feet close together behind, the big hind feet landing ahead and wide.
  const bound = (u, v, th, depth, age, group, sit = false) => {
    const c = Math.cos(th);
    const s = Math.sin(th);
    const at = (x, z) => [u + (c * x - s * z) / 1000, v + (s * x + c * z) / 1000];
    const st = rng.float(-6, 6);
    // tiles are left feet: mirror +1 on the left (−z), −1 on the right; feet toe out a little
    const feet = sit
      ? [['hindSit', -6, -21, 1, deg(-6)], ['hindSit', -4, 21, -1, deg(6)], ['frontPlant', 46, -12, 1, 0], ['frontPlant', 44, 13, -1, 0]]
      : [['frontBound', -34 + st, -13, 1, deg(rng.float(-6, 4))], ['frontBound', -38 - st, 12, -1, deg(rng.float(-4, 6))], ['hindBound', 38 + rng.float(-4, 4), -37, 1, deg(-9)], ['hindBound', 35 + rng.float(-4, 4), 38, -1, deg(9)]];
    gid++;
    for (const [tile, x, z, mirror, turn] of feet) {
      const [pu, pv] = at(x + rng.float(-3, 3), z + rng.float(-3, 3));
      put(tile, pu, pv, th + turn, depth * rng.float(0.85, 1.1), mirror, age, group, gid);
    }
  };

  const walk = (pts, gap, depth, age, group, { first = 0.05, last = 0 } = {}) => {
    const c = curve(pts);
    const L = c.getLength();
    let s = first;
    while (s < L - last) {
      const f = s / L;
      c.getPointAt(f, cu);
      c.getTangentAt(f, ct);
      // slower and shorter bounds as it nears its midden
      const near = Math.hypot(cu.x - MIDDEN.u, cu.y - MIDDEN.v);
      bound(cu.x, cu.y, Math.atan2(ct.y, ct.x) + rng.float(-0.08, 0.08), depth, age, group);
      s += rng.float(gap[0], gap[1]) * (0.55 + 0.45 * smoothstep(0.1, 0.6, near));
    }
  };

  const D = TRACKS.squirrelDepth;
  walk(PATHS.squirrelIn, TRACKS.groupGap, D, 0, 'squirrel');
  // at the midden: it sat facing the cones (a spot clear of all three), shuffled round toward the far pine, went
  bound(-0.328, 0.171, Math.atan2(MIDDEN.v - 0.171, MIDDEN.u + 0.328), D * 1.1, 0, 'squirrel', true);
  bound(-0.15, 0.4, 1.25, D, 0, 'squirrel');
  walk(PATHS.squirrelOut, TRACKS.groupGap, D, 0, 'squirrel', { first: 0.02 });
  walk(PATHS.squirrelOld, [0.42, 0.62], D * 0.75, TRACKS.oldAge, 'old');

  // keep clear of whatever still stands above the snow, and of the floor's border band (rad: decal half size)
  const clearAt = (u, v, rad) => {
    if (Math.abs(u) > CFG.PATCH.halfL - 0.22 || Math.abs(v) > CFG.PATCH.halfW - 0.2) return false;
    if (Math.hypot(u - CORES.u, v - CORES.v) < CORES.r + rad * 0.6) return false;
    for (const [cu0, cv0, cr] of WINTER_CORES) if (Math.hypot(u - cu0, v - cv0) < cr + rad * 0.6) return false;
    for (const name of AVOID) {
      const s = CFG.SPOTS[name];
      if (s && Math.hypot(u - s.u, v - s.v) < s.r + rad * 0.6) return false;
    }
    return true;
  };
  const halfSize = (tile) => (Math.max(TILES[tile].w, TILES[tile].h) * 0.5) / 1000;
  const ok = (d) => clearAt(d.u, d.v, halfSize(d.tile));

  // two tits gleaning seeds round the midden, in short hops that go round the cores; one takes off
  const birdR = halfSize('birdA');
  for (let b = 0; b < 2; b++) {
    let u = MIDDEN.u + (b ? 0.17 : -0.17);
    let v = MIDDEN.v + (b ? 0.0 : 0.06);
    let th = rng.float(0, Math.PI * 2);
    const hops = b ? 12 : 10;
    for (let k = 0; k < hops; k++) {
      put(rng.chance(0.5) ? 'birdA' : 'birdB', u, v, th, TRACKS.birdDepth * rng.float(0.85, 1.1), rng.sign(), 0, 'bird');
      // wander, drawn back toward the seeds, never onto a core
      const toU = MIDDEN.u - u;
      const toV = MIDDEN.v - v;
      const want = Math.atan2(toV, toU);
      const pull = Math.hypot(toU, toV) > 0.2 ? Math.atan2(Math.sin(want - th), Math.cos(want - th)) * 0.6 : 0;
      for (let tries = 0; tries < 10; tries++) {
        const nth = th + pull + rng.float(-0.9, 0.9) * (1 + tries * 0.3);
        const hop = rng.float(0.055, 0.095);
        const nu = u + Math.cos(nth) * hop;
        const nv = v + Math.sin(nth) * hop;
        if (clearAt(nu, nv, birdR) || tries === 9) {
          th = nth;
          u = nu;
          v = nv;
          break;
        }
      }
    }
    if (b === 1) {
      // the take-off: just ahead of the last hop, wherever there is room for the wings
      const wr = halfSize('wings');
      for (let tries = 0; tries < 12; tries++) {
        const a = th + tries * 0.55;
        const wu = u + Math.cos(a) * 0.05;
        const wv = v + Math.sin(a) * 0.05;
        if (clearAt(wu, wv, wr)) {
          put('wings', wu, wv, a, TRACKS.birdDepth, 1, 0, 'bird');
          break;
        }
      }
    }
  }
  // what they came for: scales and seeds the squirrel dropped round its table (off by default: litter's midden)
  for (let k = 0; k < TRACKS.debris; k++) {
    const a = (k / TRACKS.debris) * Math.PI * 2 + rng.float(-0.6, 0.6); // spread round, never the same patch twice
    const r = rng.float(0.11, 0.15);
    put('debris', CORES.u + Math.cos(a) * r, CORES.v + Math.sin(a) * r, rng.float(0, 6.3), 0.01, 1, 0, 'debris');
  }

  const dropped = new Set(out.filter((d) => d.gid >= 0 && !ok(d)).map((d) => d.gid));
  return out.filter((d) => (d.gid >= 0 ? !dropped.has(d.gid) : ok(d)));
}

// ── shaders ─────────────────────────────────────────────────
const TRACK_VERT = /* glsl */ `
attribute vec4 aTrack;  // tile, depth (m), mirror (±1), age (0 fresh … 1 filled in)
uniform vec3 uSunDir;
uniform float uBias;
varying vec2 vUv;
varying vec3 vView;     // to the camera, in tile space (x along the track, y up, z across), metres
varying vec3 vWP;
flat varying vec3 vSun;
flat varying vec3 vUpT; // world up in tile space
flat varying vec4 vTrack;
flat varying vec2 vSize;
void main() {
  mat4 M = modelMatrix * instanceMatrix;
  vec4 wp = M * vec4( position, 1.0 );
  vec3 F = M[ 0 ].xyz;
  vec3 N = normalize( M[ 1 ].xyz );
  vec3 R = M[ 2 ].xyz;
  vSize = vec2( length( F ), length( R ) );
  F /= vSize.x;
  R /= vSize.y;
  float m = aTrack.z;
  vec3 toCam = cameraPosition - wp.xyz;
  vView = vec3( dot( toCam, F ), dot( toCam, N ), dot( toCam, R ) * m );
  vSun = vec3( dot( uSunDir, F ), dot( uSunDir, N ), dot( uSunDir, R ) * m );
  vUpT = vec3( F.y, N.y, R.y * m );
  vUv = vec2( uv.x, m > 0.0 ? uv.y : 1.0 - uv.y );
  vTrack = aTrack;
  vWP = wp.xyz;
  // pulled toward the camera along its own view ray: the same pixel, a nearer depth
  float d = length( toCam );
  vec3 biased = wp.xyz + toCam / max( d, 1e-4 ) * min( uBias, d * 0.5 );
  gl_Position = projectionMatrix * viewMatrix * vec4( biased, 1.0 );
}
`;

const TRACK_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tTracks;
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
uniform vec3 uSunE;
uniform vec3 uSkyE;
uniform vec3 uGroundE;
uniform float uOn;
uniform float uDepthK;
uniform float uFar;
varying vec2 vUv;
varying vec3 vView;
varying vec3 vWP;
flat varying vec3 vSun;
flat varying vec3 vUpT;
flat varying vec4 vTrack;
flat varying vec2 vSize;

vec2 gTile;   // atlas offset of this tile
vec2 gDx;     // uv derivatives (for mip selection under parallax)
vec2 gDy;
float gLod;   // extra blur for old, filled-in prints

float trackH( vec2 uv ) {
  uv = clamp( uv, vec2( 0.004 ), vec2( 0.996 ) );
  vec2 a = ( gTile + uv ) * vec2( 0.25, 0.5 );
  float h = gLod > 0.0 ? textureLod( tTracks, a, gLod ).r : textureGrad( tTracks, a, gDx, gDy ).r;
  return h * 2.0 - 1.0;
}
float trackSunVis( vec3 wp ) {
  if ( uHasShadow < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( wp, 1.0 );
  sc.xyz /= sc.w;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
  // 2 × 2 bilinear PCF, close to the soft shadows the snow itself gets
  vec2 ts = vec2( textureSize( tShadow, 0 ) );
  vec2 st = sc.xy * ts - 0.5;
  vec2 f = fract( st );
  vec2 b = ( floor( st ) + 0.5 ) / ts;
  float s00 = step( sc.z - 0.002, unpackRGBAToDepth( textureLod( tShadow, b, 0.0 ) ) );
  float s10 = step( sc.z - 0.002, unpackRGBAToDepth( textureLod( tShadow, b + vec2( 1.0, 0.0 ) / ts, 0.0 ) ) );
  float s01 = step( sc.z - 0.002, unpackRGBAToDepth( textureLod( tShadow, b + vec2( 0.0, 1.0 ) / ts, 0.0 ) ) );
  float s11 = step( sc.z - 0.002, unpackRGBAToDepth( textureLod( tShadow, b + vec2( 1.0, 1.0 ) / ts, 0.0 ) ) );
  return mix( mix( s00, s10, f.x ), mix( s01, s11, f.x ), f.y );
}
vec3 trackHemi( vec3 n ) {
  return mix( uGroundE, uSkyE, 0.5 * dot( n, vUpT ) + 0.5 );
}

void main() {
  float tile = floor( vTrack.x + 0.5 );
  gTile = vec2( mod( tile, 4.0 ), floor( tile / 4.0 ) );
  gDx = dFdx( vUv ) * vec2( 0.25, 0.5 );
  gDy = dFdy( vUv ) * vec2( 0.25, 0.5 );
  float age = vTrack.w;
  gLod = age > 0.0 ? 2.2 * age + log2( max( max( length( gDx ), length( gDy ) ) * 512.0, 1.0 ) ) : -1.0;
  // flat snow here (dilated mask): nothing to do
  vec2 au = ( gTile + clamp( vUv, vec2( 0.004 ), vec2( 0.996 ) ) ) * vec2( 0.25, 0.5 );
  if ( textureLod( tTracks, au, 0.0 ).g < 0.5 && textureGrad( tTracks, au, gDx, gDy ).g < 0.02 ) discard;

  float D = vTrack.y * uDepthK * ( 1.0 - 0.45 * age ); // print depth (m); new snow fills old prints
  float top = 0.35 * vTrack.y;                        // the decal plane: just above the highest rim
  vec2 S = vSize;
  vec3 V = normalize( vView );
  vec3 L = normalize( vSun );

  // parallax: walk down the view ray from the decal plane until it meets the height field (y up)
  vec3 p = vec3( ( vUv.x - 0.5 ) * S.x, top, ( vUv.y - 0.5 ) * S.y );
  float isFar = uFar;
  vec2 uv = vUv;
  float hHit = trackH( uv ) * D;
  if ( isFar < 0.5 ) {
    vec3 dir = -V / max( V.y, 0.3 );
    float span = top + D;
    float prevGap = top - trackH( uv ) * D;
    vec3 q = p;
    const int STEPS = 12;
    for ( int i = 1; i <= STEPS; i++ ) {
      vec3 qn = p + dir * span * ( float( i ) / float( STEPS ) );
      vec2 un = vec2( qn.x / S.x, qn.z / S.y ) + 0.5;
      float hn = trackH( un ) * D;
      float gap = qn.y - hn;
      if ( gap <= 0.0 ) {
        float t = prevGap / max( prevGap - gap, 1e-6 );
        q = mix( q, qn, t );
        break;
      }
      q = qn;
      prevGap = gap;
    }
    uv = vec2( q.x / S.x, q.z / S.y ) + 0.5;
    hHit = trackH( uv ) * D;
  }

  // the surface normal from the height field
  vec2 e = vec2( 1.0 / 128.0, 0.0 );
  float hx = ( trackH( uv + e.xy ) - trackH( uv - e.xy ) ) * D / ( 2.0 * e.x * S.x );
  float hz = ( trackH( uv + e.yx ) - trackH( uv - e.yx ) ) * D / ( 2.0 * e.x * S.y );
  vec3 n = normalize( vec3( -hx, 1.0, -hz ) );

  // self-shadow: march toward the sun; the walls on its side shade the floor of the print
  float sh = 1.0;
  if ( isFar < 0.5 && L.y > 0.05 ) {
    vec3 o = vec3( ( uv.x - 0.5 ) * S.x, hHit + 0.0002, ( uv.y - 0.5 ) * S.y );
    float reach = ( top - hHit ) / L.y;
    for ( int i = 1; i <= 6; i++ ) {
      float t = reach * ( float( i ) / 6.0 );
      vec3 r = o + L * t;
      float hr = trackH( vec2( r.x / S.x, r.z / S.y ) + 0.5 ) * D;
      sh = min( sh, 1.0 - clamp( ( hr - r.y ) / 0.001, 0.0, 1.0 ) ); // 1 mm penumbra (snow is translucent)
    }
  }
  // how much sky the hollow still sees: depth, and the crease against a blurred field
  float dep = clamp( -hHit / max( D, 1e-5 ), 0.0, 1.0 );
  vec2 ab = ( gTile + clamp( uv, vec2( 0.004 ), vec2( 0.996 ) ) ) * vec2( 0.25, 0.5 );
  float hBlur = textureLod( tTracks, ab, 3.0 ).r * 2.0 - 1.0;
  float crease = clamp( ( hBlur * D - hHit ) / max( D, 1e-5 ), 0.0, 1.0 );
  float ao = clamp( 1.0 - 0.38 * dep - 0.5 * crease, 0.35, 1.0 );

  // the sun on the snow here (tree shadows), the same for the flat reference and the dent
  float vis = trackSunVis( vWP );
  vec3 sun = uSunE * vis;
  vec3 flatL = sun * max( L.y, 0.0 ) + trackHemi( vec3( 0.0, 1.0, 0.0 ) );
  vec3 dentL = sun * sh * max( dot( n, L ), 0.0 ) + trackHemi( n ) * ao;
  // light scattered through the thin walls and bounced off the sunlit side: the blue glow inside a print
  dentL += sun * max( L.y, 0.0 ) * dep * ( vec3( 0.03, 0.075, 0.13 ) + 0.12 * ( 1.0 - sh ) * vec3( 0.75, 0.8, 0.9 ) );
  vec3 ratio = dentL / max( flatL, vec3( 1e-4 ) );
  // compacted snow at the bottom: a touch greyer and bluer
  ratio *= mix( vec3( 1.0 ), vec3( 0.9, 0.94, 1.0 ), dep );

  // fresh seeds, wings and scales lying on top
  vec4 tex = textureGrad( tTracks, ( gTile + clamp( uv, vec2( 0.004 ), vec2( 0.996 ) ) ) * vec2( 0.25, 0.5 ), gDx, gDy );
  if ( tex.a > 0.004 ) {
    float tone = tex.b;
    vec3 alb = mix( vec3( 0.025, 0.016, 0.01 ), vec3( 0.36, 0.25, 0.14 ), smoothstep( 0.0, 0.95, tone ) );
    alb = mix( alb, vec3( 0.2, 0.085, 0.035 ), smoothstep( 0.2, 0.35, tone ) * smoothstep( 0.55, 0.4, tone ) );
    ratio = mix( ratio, ratio * alb / vec3( 0.74, 0.77, 0.82 ), tex.a );
  }

  ratio = mix( vec3( 1.0 ), clamp( ratio, 0.0, 3.0 ), uOn );
  gl_FragColor = vec4( ratio, 1.0 );
}
`;

// ── the mesh ────────────────────────────────────────────────
/**
 * Tracks in the snow. Returns { mesh, update(dt, time, state), applySeason(sp, v), setSnowTop(fn), stats, layout,
 * whenReady, ready }. `mesh` is one InstancedMesh (one draw call); hidden while sp.snow < 0.42 and until the atlas
 * has finished baking (in the background, a few frames after build).
 */
export function buildTracks(ctx = {}) {
  const layout = trackLayout();
  const data = new Uint8Array(SIZE * 4 * SIZE * 2 * 4);
  const tex = new THREE.DataTexture(data, SIZE * 4, SIZE * 2, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  // the atlas bakes in slices of ~8 ms while the page loads (≈ 0.1–0.25 s of work in all); tracks show once it is done
  let ready = false;
  const baking = bakeTiles(31, data);
  const whenReady = new Promise((resolve) => {
    const slice = () => {
      const t0 = performance.now();
      for (;;) {
        if (baking.next().done) {
          tex.needsUpdate = true;
          ready = true;
          resolve();
          return;
        }
        if (performance.now() - t0 > 8) break;
      }
      setTimeout(slice, 0);
    };
    setTimeout(slice, 0);
  });

  // a unit quad in the xz plane, facing up, uv along x (travel) and z (across)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, 0.5], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 1, 1], 2));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  const n = layout.length;
  const aTrack = new Float32Array(n * 4);
  layout.forEach((d, i) => {
    aTrack.set([TILES[d.tile].i, d.depth, d.mirror, d.age], i * 4);
  });
  geo.setAttribute('aTrack', new THREE.InstancedBufferAttribute(aTrack, 4));

  const U = {
    tTracks: { value: tex },
    tShadow: shadowUniforms.tShadow,
    uShadowMatrix: shadowUniforms.uShadowMatrix,
    uHasShadow: shadowUniforms.uHasShadow,
    uSunDir: { value: SUN_DIR.clone() },
    uSunE: { value: new THREE.Vector3(2.4, 2.45, 2.6) },
    uSkyE: { value: new THREE.Vector3(0.56, 0.65, 0.81) },
    uGroundE: { value: new THREE.Vector3(0.27, 0.29, 0.32) },
    uOn: { value: 0 },
    uDepthK: { value: 1 },
    uBias: { value: TRACKS.bias },
    uFar: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: TRACK_VERT,
    fragmentShader: TRACK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.InstancedMesh(geo, material, n);
  mesh.name = 'life-tracks';
  mesh.renderOrder = -1; // before other transparent things (dust, flakes) so they stay on top
  mesh.visible = false;

  // place every decal on the snow, its plane just above the highest rim
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const F = new THREE.Vector3();
  const N = new THREE.Vector3();
  const R = new THREE.Vector3();
  const P = new THREE.Vector3();
  let placedFor = -1;
  let surface = snowTopAt; // replaced by setSnowTop when the floor publishes its draped snow
  let snowDependent = typeof CFG.snowTopAt === 'function';
  const place = (snow) => {
    box.makeEmpty();
    layout.forEach((d, i) => {
      const T = TILES[d.tile];
      const x = CFG.PATCH.center.x + CFG.PATCH.u.x * d.u + CFG.PATCH.v.x * d.v;
      const z = CFG.PATCH.center.y + CFG.PATCH.u.y * d.u + CFG.PATCH.v.y * d.v;
      // deep snow smooths the ground: a broad normal
      const e = 0.05;
      const hx = surface(x + e, z, snow) - surface(x - e, z, snow);
      const hz = surface(x, z + e, snow) - surface(x, z - e, snow);
      N.set(-hx, 2 * e, -hz).normalize();
      const c = Math.cos(d.heading);
      const s = Math.sin(d.heading);
      F.set(CFG.PATCH.u.x * c + CFG.PATCH.v.x * s, 0, CFG.PATCH.u.y * c + CFG.PATCH.v.y * s);
      F.addScaledVector(N, -F.dot(N)).normalize();
      R.crossVectors(F, N);
      P.set(x, surface(x, z, snow), z).addScaledVector(N, 0.35 * d.depth + 0.0008);
      m4.makeBasis(F.multiplyScalar(T.w / 1000), N, R.multiplyScalar(T.h / 1000)).setPosition(P);
      mesh.setMatrixAt(i, m4);
      box.expandByPoint(P);
    });
    mesh.instanceMatrix.needsUpdate = true;
    box.expandByScalar(0.12);
    mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    placedFor = snow;
  };
  place(1);

  // the lights as they are drawn this frame
  let hemi = null;
  const findHemi = () => {
    if (hemi || !ctx.scene) return;
    ctx.scene.traverse((o) => {
      if (!hemi && o.isHemisphereLight) hemi = o;
    });
  };
  const stats = { drawCalls: 0, triangles: 0, instances: n, decals: n, squirrel: 0, birds: 0 };
  for (const d of layout) {
    if (d.group === 'squirrel' || d.group === 'old') stats.squirrel++;
    if (d.group === 'bird') stats.birds++;
  }
  let snowNow = 0;

  return {
    mesh,
    layout,
    stats,
    whenReady, // resolves once the atlas is baked
    get ready() {
      return ready;
    },
    update(dt, time, state = {}) {
      const on = U.uOn.value > 0.002;
      const dist = state.dist ?? 0;
      mesh.visible = ready && on && dist < TRACKS.maxDist;
      stats.drawCalls = mesh.visible ? 1 : 0;
      stats.triangles = mesh.visible ? n * 2 : 0;
      if (!mesh.visible) return;
      // close-up parallax and self-shadow only while the camera is near; beyond, plain shaded dents
      U.uFar.value = (state.near ?? 1) > 0.02 ? 0 : 1;
      const sun = ctx.sun;
      if (sun) {
        U.uSunE.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity);
        if (sun.target) U.uSunDir.value.subVectors(sun.position, sun.target.position).normalize();
      }
      findHemi();
      if (hemi) {
        U.uSkyE.value.set(hemi.color.r, hemi.color.g, hemi.color.b).multiplyScalar(hemi.intensity);
        U.uGroundE.value.set(hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b).multiplyScalar(hemi.intensity);
      }
    },
    applySeason(sp) {
      const snow = sp?.snow ?? 0;
      snowNow = snow;
      U.uOn.value = smoothstep(TRACKS.show[0], TRACKS.show[1], snow);
      U.uDepthK.value = TRACKS.depth[0] + (TRACKS.depth[1] - TRACKS.depth[0]) * smoothstep(0.5, 0.95, snow);
      if (sp?.sun && !ctx.sun) {
        U.uSunE.value.set(sp.sun[0], sp.sun[1], sp.sun[2]).multiplyScalar(sp.sunI);
        U.uSkyE.value.set(sp.hemiSky[0], sp.hemiSky[1], sp.hemiSky[2]).multiplyScalar(sp.hemiI);
        U.uGroundE.value.set(sp.hemiGround[0], sp.hemiGround[1], sp.hemiGround[2]).multiplyScalar(sp.hemiI);
      }
      // a shared snow surface that rises with the snow: follow it (only when the snow has really changed)
      if (snowDependent && U.uOn.value > 0 && Math.abs(snow - placedFor) > 0.01) place(snow);
      mesh.visible = mesh.visible && U.uOn.value > 0.002;
    },
    /**
     * Follow a shared snow surface: fn(x, z, snow) → world y of the snow's top (e.g. heroHeightAt + the floor's
     * draped lift). The decals are re-placed now and whenever the snow changes by more than 1 %.
     */
    setSnowTop(fn) {
      if (typeof fn !== 'function') return;
      surface = fn;
      snowDependent = true;
      place(snowNow > 0.4 ? snowNow : 1);
    },
    get snow() {
      return snowNow;
    },
  };
}
