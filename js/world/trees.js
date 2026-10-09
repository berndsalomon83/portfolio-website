import * as THREE from 'three';
import { RNG, fbm2 } from '../lib/random.js';
import { MeshData, addTube, addCard } from '../lib/geometry.js';
import { foliageMaterial, barkMaterial } from './materials.js';
import { heightAt } from './terrain.js';
import { SAPLING, FOREST_RADIUS, distToPath } from './layout.js';

// Procedural Scots pine, Norway spruce and silver birch.
// Each species is generated as a handful of template trees (near + far LOD) that are instanced across the forest.

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const deg = THREE.MathUtils.degToRad;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

function makeSpine(rng, H, wobble, lean) {
  const a1 = rng.float(0, 6.28);
  const a2 = rng.float(0, 6.28);
  const a3 = rng.float(0, 6.28);
  const f1 = rng.float(0.35, 0.7);
  const f2 = rng.float(1.2, 2.2);
  const ld = rng.float(0, 6.28);
  const raw = (y) => {
    const t = Math.max(0, y) / H;
    return [
      Math.sin(t * f1 * 6.28 + a1) * wobble + Math.sin(t * f2 * 6.28 + a2) * wobble * 0.3 + Math.cos(ld) * lean * t * t,
      Math.cos(t * f1 * 6.28 + a3) * wobble + Math.cos(t * f2 * 6.28 + a1) * wobble * 0.3 + Math.sin(ld) * lean * t * t,
    ];
  };
  const o = raw(0);
  return (y) => {
    const r = raw(y);
    return v3(r[0] - o[0], y, r[1] - o[1]);
  };
}

function rootMod(rng, flareH = 0.32, amount = 0.38) {
  const n = rng.int(4, 6);
  const ph = rng.float(0, 6.28);
  return (i, a, p) => {
    const k = Math.exp(-Math.max(p.y + 0.35, 0) / flareH);
    return 1 + amount * k * Math.pow(Math.max(0, Math.sin(a * n + ph)), 2) + 0.04 * Math.sin(a * 13 + ph) * k;
  };
}

function branchPath(start, dir, L, segs, bend) {
  const pts = [start.clone()];
  const d = dir.clone();
  let p = start.clone();
  for (let i = 1; i <= segs; i++) {
    bend(d, i / segs);
    d.normalize();
    p = p.clone().addScaledVector(d, L / segs);
    pts.push(p);
  }
  return pts;
}

function along(pts, u) {
  const f = clamp(u, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i].clone().lerp(pts[i + 1], f - i);
}

function tangent(pts, u) {
  const f = clamp(u, 0, 1) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i + 1].clone().sub(pts[i]).normalize();
}

function perpendicular(axis, rng) {
  const r = v3(rng.float(-1, 1), rng.float(-1, 1), rng.float(-1, 1));
  r.addScaledVector(axis, -r.dot(axis));
  if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
  return r.normalize();
}

function rotY(v, a) {
  return v.clone().applyAxisAngle(UP, a);
}

// Normals of foliage cards bent toward a crown volume → soft, volumetric shading instead of flat planes.
function crownNormal(center, k = 0.72, squash = 1) {
  return (p, face) => {
    const s = v3(p.x - center.x, (p.y - center.y) * squash, p.z - center.z).normalize();
    const sgn = Math.sign(face.dot(s)) || 1;
    return face.clone().multiplyScalar(sgn * (1 - k)).addScaledVector(s, k).normalize();
  };
}

// ─────────────────────────────────────────────────────────────
// Scots pine (tall, bare lower trunk, flaky orange top, clumpy crown)
// ─────────────────────────────────────────────────────────────
export function buildPine(seed, near) {
  const rng = new RNG(seed);
  const bark = new MeshData();
  const leaves = new MeshData();
  const H = rng.float(19, 25);
  const r0 = rng.float(0.17, 0.23);
  const crownStart = H * rng.float(0.6, 0.7);
  const crownH = H - crownStart;
  const at = makeSpine(rng, H, 0.1, rng.float(0.15, 0.6));
  const trunkR = (y) => {
    const t = clamp(Math.max(0, y) / H, 0, 1);
    return Math.max(0.028, r0 * Math.pow(1 - t, 0.72)) * (1 + 0.5 * Math.exp(-Math.max(y + 0.2, 0) / 0.35));
  };
  const rings = near ? 30 : 9;
  const tp = [];
  const tr = [];
  for (let i = 0; i <= rings; i++) {
    const y = -0.4 + (H + 0.4) * Math.pow(i / rings, 1.35);
    tp.push(at(y));
    tr.push(trunkR(y));
  }
  addTube(bark, tp, tr, {
    radial: near ? 14 : 6,
    uRepeat: near ? 3 : 2,
    vScale: 1.2,
    h: (i, p) => Math.max(0, p.y) / H,
    radiusMod: near ? rootMod(rng) : undefined,
  });

  const crownC = at(crownStart + crownH * 0.55);
  const Lmax = rng.float(2.4, 3.4);
  const swayAt = (p) => clamp(Math.hypot(p.x - crownC.x, p.z - crownC.z) / 3, 0, 1);
  const nf = crownNormal(crownC, 0.7, 1.4);
  const shade = (p) => {
    const rr = Math.hypot(p.x - crownC.x, p.z - crownC.z) / (Lmax * 0.9);
    const vy = (p.y - crownStart) / crownH;
    const ao = clamp(0.42 + 0.42 * rr + 0.25 * vy, 0.35, 1.1);
    const t = rng.float(0.9, 1.08);
    return [ao * t, ao * t * rng.float(0.97, 1.03), ao * t * rng.float(0.9, 1.0)];
  };
  const TUFT = [0, 0, 0.5, 1];
  const SPRAY = [0.5, 0, 1, 1];
  const crossed = (base, ax, size, uv, p) => {
    const r1 = perpendicular(ax, rng);
    const r2 = v3().crossVectors(ax, r1).normalize();
    const col = shade(p);
    const sw = swayAt(p);
    addCard(leaves, base, ax, r1, size, size, { color: col, normal: nf, sway: sw, h: 1, uv });
    addCard(leaves, base, ax, r2, size, size, { color: col, normal: nf, sway: sw, h: 1, uv });
  };
  const clump = (c, axisDir, scale, n) => {
    for (let i = 0; i < n; i++) {
      const p = c.clone().add(v3(rng.float(-1, 1), rng.float(-0.6, 0.8), rng.float(-1, 1)).multiplyScalar(0.25 * scale));
      const ax = axisDir
        .clone()
        .multiplyScalar(0.55)
        .add(v3(rng.float(-0.45, 0.45), 0.55 + rng.float(-0.2, 0.35), rng.float(-0.45, 0.45)))
        .normalize();
      const size = rng.float(0.5, 0.75) * scale;
      crossed(p.clone().addScaledVector(ax, -size * 0.12), ax, size, TUFT, p);
    }
  };
  // branchlet sprays carry the bulk of the crown
  const sprays = (pts, L, scale, from = 0.3) => {
    for (let u = from; u <= 0.98; u += (near ? 0.42 : 0.7) / Math.max(L, 0.5)) {
      const p = along(pts, u);
      const tg = tangent(pts, u);
      const ax = tg
        .clone()
        .add(v3(rng.float(-0.35, 0.35), 0.55 + rng.float(-0.15, 0.3), rng.float(-0.35, 0.35)))
        .normalize();
      const size = rng.float(1.0, 1.35) * scale;
      crossed(p.clone().addScaledVector(ax, -size * 0.08), ax, size, SPRAY, p);
    }
  };

  const nPrim = near ? rng.int(18, 26) : rng.int(12, 15);
  for (let k = 0; k < nPrim; k++) {
    const t = (k + rng.float(0.1, 0.9)) / nPrim;
    const y = crownStart + (crownH - 0.5) * Math.pow(t, 0.9);
    const az = k * 2.39996 + rng.float(-0.5, 0.5);
    const prof = t < 0.55 ? 0.72 + (0.28 * t) / 0.55 : 1 - 0.78 * Math.pow((t - 0.55) / 0.45, 1.3);
    const L = Lmax * prof * rng.float(0.75, 1.1);
    const el = deg(lerp(-8, 38, t) + rng.float(-10, 10));
    const dir = v3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const tpnt = at(y);
    const start = tpnt.clone().addScaledVector(v3(dir.x, 0, dir.z).normalize(), trunkR(y) * 0.3);
    const segs = near ? 5 : 2;
    const bpts = branchPath(start, dir, L, segs, (d, s) => {
      d.y += 0.1 + 0.12 * s;
      d.x += rng.float(-0.12, 0.12);
      d.z += rng.float(-0.12, 0.12);
    });
    const rb = clamp(trunkR(y) * 0.5 * Math.sqrt(L / Lmax), 0.016, 0.075);
    if (near || L > 1.4) {
      addTube(bark, bpts, bpts.map((_, i) => rb * (1 - (0.8 * i) / segs) + 0.004), {
        radial: near ? 5 : 3,
        vScale: 0.6,
        h: () => 0.95,
        sway: (i, p) => swayAt(p),
      });
    }
    const tips = [{ p: bpts[bpts.length - 1], d: tangent(bpts, 1), s: 1 }];
    sprays(bpts, L, near ? 1 : 1.55, 0.35);
    if (near) {
      const nSub = rng.int(2, 4);
      for (let s = 0; s < nSub; s++) {
        const u = rng.float(0.35, 0.85);
        const bp = along(bpts, u);
        const sd = rotY(dir, rng.sign() * rng.float(0.6, 1.2));
        sd.y += 0.35;
        sd.normalize();
        const sl = L * rng.float(0.3, 0.5);
        const spts = branchPath(bp, sd, sl, 3, (d) => {
          d.y += 0.15;
        });
        addTube(bark, spts, spts.map((_, i) => rb * 0.45 * (1 - (0.7 * i) / 3) + 0.003), {
          radial: 3,
          vScale: 0.5,
          h: () => 0.95,
          sway: (i, p) => swayAt(p),
        });
        sprays(spts, sl, 0.85, 0.5);
        tips.push({ p: spts[3], d: tangent(spts, 1), s: 0.85 });
      }
    }
    for (const tip of tips) clump(tip.p, tip.d, tip.s * (near ? 1 : 1.7), near ? rng.int(3, 5) : 2);
  }
  clump(at(H), UP, near ? 1.1 : 1.7, near ? 5 : 3);
  sprays([at(H - 1.6), at(H)], 1.6, near ? 1 : 1.5, 0.2);

  // dead stubs on the bare trunk
  if (near) {
    const n = rng.int(4, 9);
    for (let i = 0; i < n; i++) {
      const y = rng.float(2.5, crownStart);
      const az = rng.float(0, 6.28);
      const d = v3(Math.cos(az), rng.float(-0.25, 0.05), Math.sin(az)).normalize();
      const p0 = at(y);
      const L = rng.float(0.12, 0.45);
      addTube(bark, [p0, p0.clone().addScaledVector(d, L)], [0.022, 0.01], { radial: 4, vScale: 0.5, h: () => 0.3 });
    }
  }
  return { bark, leaves, H };
}

// ─────────────────────────────────────────────────────────────
// Norway spruce (conical, whorled, hanging "comb" twigs, dead lower branches with beard lichen)
// ─────────────────────────────────────────────────────────────
export function buildSpruce(seed, near, young = false) {
  const rng = new RNG(seed);
  const bark = new MeshData();
  const leaves = new MeshData();
  const comb = new MeshData();
  const lichen = new MeshData();
  const H = young ? rng.float(3.2, 8.5) : rng.float(17, 25);
  const r0 = young ? H * 0.012 : rng.float(0.2, 0.27);
  const live = young ? rng.float(0.1, 0.35) : H * rng.float(0.22, 0.36);
  const at = makeSpine(rng, H, 0.05, rng.float(0.05, 0.2));
  const trunkR = (y) => {
    const t = clamp(Math.max(0, y) / H, 0, 1);
    return Math.max(0.02, r0 * Math.pow(1 - t, 0.95)) * (1 + 0.42 * Math.exp(-Math.max(y + 0.2, 0) / 0.3));
  };
  const rings = near ? 28 : 8;
  const tp = [];
  const tr = [];
  for (let i = 0; i <= rings; i++) {
    const y = -0.4 + (H + 0.4) * Math.pow(i / rings, 1.3);
    tp.push(at(y));
    tr.push(trunkR(y));
  }
  addTube(bark, tp, tr, {
    radial: near ? 12 : 6,
    uRepeat: near ? 3 : 2,
    vScale: 1.2,
    h: (i, p) => Math.max(0, p.y) / H,
    radiusMod: near ? rootMod(rng, 0.3, 0.3) : undefined,
  });

  const axisAt = (y) => at(y);
  const swayAt = (p) => {
    const a = axisAt(p.y);
    return clamp(Math.hypot(p.x - a.x, p.z - a.z) / 2.5, 0, 1);
  };
  const nf = (p, face) => {
    const a = axisAt(p.y);
    const radial = v3(p.x - a.x, 0, p.z - a.z);
    if (radial.lengthSq() < 1e-6) radial.set(1, 0, 0);
    radial.normalize().multiplyScalar(0.8).add(v3(0, 0.55, 0)).normalize();
    const sgn = Math.sign(face.dot(radial)) || 1;
    return face.clone().multiplyScalar(sgn * 0.3).addScaledVector(radial, 0.7).normalize();
  };

  // dead lower twigs
  if (near && !young) {
    for (let y = 1.7; y < live; y += rng.float(0.45, 0.75)) {
      const n = rng.int(2, 3);
      for (let b = 0; b < n; b++) {
        const az = rng.float(0, 6.28);
        const L = rng.float(0.35, 0.6) + 0.8 * (y / live);
        const el = deg(rng.float(-38, -12));
        const dir = v3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        const pts = branchPath(at(y), dir, L, 3, (d) => {
          d.x += rng.float(-0.2, 0.2);
          d.z += rng.float(-0.2, 0.2);
        });
        addTube(bark, pts, [0.016, 0.011, 0.007, 0.003], { radial: 3, vScale: 0.4, h: () => 0.25, sway: (i, p) => swayAt(p) * 0.3 });
        if (rng.chance(0.35)) {
          const p = along(pts, rng.float(0.4, 0.9));
          const hang = rng.float(0.18, 0.45);
          const right = perpendicular(UP, rng);
          addCard(lichen, p.clone().add(v3(0, -hang, 0)), UP, right, hang * 0.32, hang, { color: [1, 1, 1], sway: 0.8, h: 1 });
        }
      }
    }
  }

  const Lmax = young ? H * rng.float(0.2, 0.26) : rng.float(2.0, 2.8);
  let whorl = 0;
  for (let y = live; y < H - 0.35; y += near ? rng.float(0.34, 0.46) : rng.float(0.75, 0.95)) {
    const t = (y - live) / (H - live);
    const nB = near ? rng.int(4, 6) : 4;
    const az0 = rng.float(0, 6.28);
    whorl++;
    for (let b = 0; b < nB; b++) {
      const az = az0 + (b * 6.283) / nB + rng.float(-0.3, 0.3);
      const L = Lmax * Math.pow(1 - t, 0.95) * rng.float(0.8, 1.1) + 0.3;
      const el = deg(lerp(-22, 25, Math.pow(t, 0.8)) + rng.float(-6, 6));
      const dir = v3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      const start = at(y).addScaledVector(v3(dir.x, 0, dir.z).normalize(), trunkR(y) * 0.3);
      const segs = near ? 5 : 2;
      const lr = L / Lmax;
      const bpts = branchPath(start, dir, L, segs, (d, s) => {
        d.y += s < 0.6 ? -0.07 * lr : 0.2;
      });
      if ((near && L > 0.8) || (!near && L > 1.8)) {
        const rb = 0.012 + 0.03 * lr;
        addTube(bark, bpts, bpts.map((_, i) => rb * (1 - (0.75 * i) / segs) + 0.003), {
          radial: near ? 4 : 3,
          vScale: 0.5,
          h: () => 0.9,
          sway: (i, p) => swayAt(p),
        });
      }
      const step = near ? 0.24 : 0.4;
      for (let u = 0.1; u <= 1.0; u += step / L) {
        const p = along(bpts, u);
        const tg = tangent(bpts, u);
        const len = rng.float(0.7, 1.0) * Math.min(1, 0.5 + L * 0.3) * (near ? 1 : young ? 1.4 : 1.7) * (young ? 0.8 : 1);
        const ao = clamp(0.3 + 0.68 * Math.pow(u, 0.8), 0, 1) * (0.78 + 0.3 * t) * rng.float(0.9, 1.08);
        const layers = rng.chance(near ? 0.55 : 0.4) ? 2 : 1;
        for (let l = 0; l < layers; l++) {
          const right = v3().crossVectors(tg, UP);
          if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
          right.normalize().applyAxisAngle(tg, l === 0 ? rng.float(-0.35, 0.35) : rng.sign() * rng.float(0.6, 1.0));
          const up = tg.clone().addScaledVector(UP, -0.15 * u + (l ? 0.15 : 0)).normalize();
          const wid = len * rng.float(0.8, 1.0);
          const c = ao * (l ? 0.85 : 1);
          addCard(leaves, p.clone().addScaledVector(up, -len * 0.25), up, right, wid, len, {
            color: [c, c, c * 0.96],
            normal: nf,
            sway: swayAt(p),
            h: 1,
          });
        }
        if (near && t < 0.85 && L > 0.9 && u > 0.25 && rng.chance(0.7)) {
          const hang = rng.float(0.35, 0.7) * Math.min(1, L / 1.6);
          const hr = v3(tg.x, 0, tg.z).normalize();
          const c2 = ao * 0.82;
          addCard(comb, p.clone().add(v3(0, -hang + 0.05, 0)), UP, hr, rng.float(0.5, 0.8), hang, {
            color: [c2, c2, c2],
            normal: nf,
            sway: swayAt(p),
            h: 1,
          });
        }
      }
    }
  }
  void whorl;
  for (let i = 0; i < 3; i++) {
    const ax = v3(rng.float(-0.1, 0.1), 1, rng.float(-0.1, 0.1)).normalize();
    addCard(leaves, at(H - 1.0), ax, perpendicular(ax, rng), 0.45, 1.1, { color: [1, 1, 1], normal: nf, sway: 0.5, h: 1 });
  }
  return { bark, leaves, comb, lichen, H };
}

// ─────────────────────────────────────────────────────────────
// Silver birch (white trunk, ascending limbs, weeping twigs of small leaves)
// ─────────────────────────────────────────────────────────────
export function buildBirch(seed, near) {
  const rng = new RNG(seed);
  const bark = new MeshData();
  const leaves = new MeshData();
  const H = rng.float(14, 19);
  const r0 = rng.float(0.11, 0.16);
  const crownStart = H * rng.float(0.42, 0.55);
  const at = makeSpine(rng, H, 0.14, rng.float(0.4, 1.3));
  const trunkR = (y) => {
    const t = clamp(Math.max(0, y) / H, 0, 1);
    return Math.max(0.018, r0 * Math.pow(1 - t, 0.85)) * (1 + 0.35 * Math.exp(-Math.max(y + 0.2, 0) / 0.3));
  };
  const rings = near ? 26 : 8;
  const tp = [];
  const tr = [];
  for (let i = 0; i <= rings; i++) {
    const y = -0.4 + (H + 0.4) * Math.pow(i / rings, 1.3);
    tp.push(at(y));
    tr.push(trunkR(y));
  }
  addTube(bark, tp, tr, {
    radial: near ? 12 : 6,
    uRepeat: 2,
    vScale: 1.2,
    h: (i, p) => Math.max(0, p.y) / H,
    radiusMod: near ? rootMod(rng, 0.25, 0.25) : undefined,
  });

  const crownC = at(crownStart + (H - crownStart) * 0.55);
  const swayAt = (p) => clamp(Math.hypot(p.x - crownC.x, p.z - crownC.z) / 3, 0, 1);
  const nf = crownNormal(crownC, 0.7, 1.2);
  const hangCard = (p, scale) => {
    const hang = rng.float(0.6, 0.95) * scale;
    const w = rng.float(0.5, 0.72) * scale;
    const right = perpendicular(UP, rng);
    right.y = 0;
    right.normalize();
    const rr = Math.hypot(p.x - crownC.x, p.z - crownC.z) / 3.5;
    const ao = clamp(0.5 + 0.45 * rr + 0.1 * ((p.y - crownStart) / (H - crownStart)), 0.4, 1.1) * rng.float(0.9, 1.08);
    const tilt = UP.clone().add(v3(rng.float(-0.25, 0.25), 0, rng.float(-0.25, 0.25))).normalize();
    addCard(leaves, p.clone().addScaledVector(tilt, -hang + 0.06), tilt, right, w, hang, {
      color: [ao, ao, ao * 0.95],
      normal: nf,
      swayFn: (cy) => clamp(swayAt(p) * 0.6 + (1 - cy) * 0.7, 0, 1.3),
      h: 1,
    });
  };

  const nPrim = near ? rng.int(10, 15) : 8;
  for (let k = 0; k < nPrim; k++) {
    const t = (k + rng.float(0.1, 0.9)) / nPrim;
    const y = crownStart + (H * 0.97 - crownStart) * t;
    const az = k * 2.39996 + rng.float(-0.4, 0.4);
    const L = rng.float(2.6, 4.2) * (1 - 0.55 * t);
    const el = deg(lerp(40, 68, t) + rng.float(-8, 8));
    const dir = v3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const start = at(y).addScaledVector(v3(dir.x, 0, dir.z).normalize(), trunkR(y) * 0.3);
    const segs = near ? 6 : 3;
    const bpts = branchPath(start, dir, L, segs, (d, s) => {
      d.y -= 0.05 + 0.2 * s * s;
      d.x += rng.float(-0.1, 0.1);
      d.z += rng.float(-0.1, 0.1);
    });
    const rb = clamp(trunkR(y) * 0.45, 0.012, 0.05);
    addTube(bark, bpts, bpts.map((_, i) => rb * (1 - (0.8 * i) / segs) + 0.003), {
      radial: near ? 5 : 3,
      vScale: 0.6,
      h: () => 0.5,
      sway: (i, p) => swayAt(p),
    });
    const sc = near ? 1 : 1.7;
    for (let u = 0.35; u <= 1.0; u += (near ? 0.3 : 0.6) / L) {
      hangCard(along(bpts, u), sc);
      if (near && rng.chance(0.5)) hangCard(along(bpts, u).add(v3(rng.float(-0.2, 0.2), 0.05, rng.float(-0.2, 0.2))), sc * 0.85);
    }
    if (near) {
      const nSec = rng.int(2, 4);
      for (let s = 0; s < nSec; s++) {
        const bp = along(bpts, rng.float(0.3, 0.8));
        const sd = rotY(v3(dir.x, 0.25, dir.z).normalize(), rng.sign() * rng.float(0.5, 1.1));
        const sl = rng.float(0.8, 1.6);
        const spts = branchPath(bp, sd, sl, 3, (d, q) => {
          d.y -= 0.25 * q;
        });
        addTube(bark, spts, [rb * 0.4, rb * 0.3, rb * 0.2, 0.002], { radial: 3, vScale: 0.4, h: () => 0.5, sway: (i, p) => swayAt(p) });
        for (let u = 0.3; u <= 1.0; u += 0.33 / sl) hangCard(along(spts, u), 0.9);
      }
    }
  }
  return { bark, leaves, H };
}

// ─────────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────────
export function placeTrees(quality) {
  const rng = new RNG(2026);
  const trees = [];
  const cell = 4;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const tooClose = (x, z, r) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = grid.get(`${gx + a},${gz + b}`);
        if (!list) continue;
        for (const t of list) if ((t.x - x) ** 2 + (t.z - z) ** 2 < r * r) return true;
      }
    }
    return false;
  };
  const add = (species, x, z, scale) => {
    const t = { species, x, z, y: heightAt(x, z) - 0.06, scale, rot: rng.float(0, Math.PI * 2), tiltX: rng.float(-0.025, 0.025), tiltZ: rng.float(-0.025, 0.025) };
    t.near = distToPath(x, z) < quality.nearRadius;
    trees.push(t);
    const k = key(x, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  };

  // hand-placed trees that frame the canopy view and the clearing with the sapling
  const S = SAPLING;
  const manual = [
    ['pine', -2.3, 3.8, 1.06],
    ['pine', 2.9, 1.4, 1.12],
    ['birch', 2.4, 6.0, 1.0],
    ['pine', -3.3, -1.0, 1.0],
    ['spruce', -6.0, 7.0, 1.0],
    ['pine', 4.6, 8.8, 1.05],
    ['birch', -2.6, 9.0, 0.95],
    ['pine', S.x - 2.8, S.y - 2.4, 1.14],
    ['spruce', S.x + 3.8, S.y - 3.6, 1.0],
    ['birch', S.x - 1.6, S.y - 5.6, 0.95],
    ['pine', S.x + 1.3, S.y - 7.8, 1.0],
    ['spruce', S.x - 5.5, S.y + 1.0, 0.95],
    ['pine', 4.4, -12.2, 1.15],
    ['pine', S.x + 2.7, S.y + 1.6, 1.05],
    ['spruce', S.x + 4.8, S.y + 0.2, 1.0],
    ['pine', S.x - 2.6, S.y + 3.6, 1.0],
    ['spruce', S.x - 4.2, S.y - 3.2, 1.05],
  ];
  for (const [sp, x, z, s] of manual) add(sp, x, z, s);

  const R = FOREST_RADIUS;
  let attempts = 0;
  while (trees.length < quality.trees && attempts < 60000) {
    attempts++;
    const r = R * Math.sqrt(rng.next());
    const a = rng.next() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r - 6;
    const stand = fbm2(x * 0.028 + 5, z * 0.028 - 2, 3);
    let sp = stand > 0.16 ? 'spruce' : 'pine';
    if (rng.chance(stand < -0.1 ? 0.2 : 0.08)) sp = 'birch';
    const minD = { pine: 3.0, spruce: 3.3, birch: 2.6 }[sp];
    const dp = distToPath(x, z);
    if (dp < (sp === 'spruce' ? 4.6 : 2.1)) continue;
    if (Math.hypot(x - S.x, z - S.y) < 3.6) continue;
    if (tooClose(x, z, minD)) continue;
    add(sp, x, z, rng.float(0.86, 1.12));
  }

  // young spruces filling the understory — the layered look of a Swedish forest
  const youngTarget = trees.length + Math.round(quality.trees * 0.28);
  attempts = 0;
  while (trees.length < youngTarget && attempts < 40000) {
    attempts++;
    const r = (R - 8) * Math.sqrt(rng.next());
    const a = rng.next() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r - 6;
    if (distToPath(x, z) < 3.2) continue;
    if (Math.hypot(x - S.x, z - S.y) < 3.4) continue;
    if (tooClose(x, z, 1.9)) continue;
    add('young', x, z, rng.float(0.8, 1.2));
  }
  return trees;
}

// ─────────────────────────────────────────────────────────────
// Instancing
// ─────────────────────────────────────────────────────────────
export function buildForest({ trees, surfaces, foliage, quality }) {
  const group = new THREE.Group();
  group.name = 'forest';

  const pineBark = barkMaterial({ texA: surfaces.pineLower, texB: surfaces.pineUpper, mixAt: 0.52, mixWidth: 0.07, scaleB: [0.6, 1.4], height: 22 });
  const spruceBark = barkMaterial({ texA: surfaces.spruce, texB: surfaces.spruce, mixAt: 2, height: 21 });
  const birchBark = barkMaterial({ texA: surfaces.birchBase, texB: surfaces.birch, mixAt: 0.07, mixWidth: 0.035, scaleB: [1, 1], height: 16, footMoss: 0.6 });

  const pineLeaf = foliage.pine.map((map, i) => foliageMaterial({ map, height: 22, trans: [0.9, 0.85, 0.45], key: `pine${i}`, season: 'conifer' }));
  const spruceLeaf = foliage.spruce.map((map, i) => foliageMaterial({ map, height: 21, trans: [0.65, 0.8, 0.35], key: `spruce${i}`, season: 'conifer' }));
  const combLeaf = foliageMaterial({ map: foliage.spruceComb, height: 21, trans: [0.6, 0.75, 0.32], key: 'comb', season: 'conifer' });
  const lichenMat = foliageMaterial({ map: foliage.lichen, height: 21, trans: [0.9, 0.95, 0.8], power: 3, key: 'lichen' });
  const birchLeaf = foliage.birch.map((map, i) => foliageMaterial({ map, height: 16, trans: [1.25, 1.1, 0.35], power: 3, key: `birch${i}`, season: 'birch', lossPerCard: true }));

  const variants = {
    pine: { near: quality.tier === 'low' ? 2 : 4, far: 2, build: buildPine, bark: pineBark, leaf: (i) => pineLeaf[i % 2] },
    spruce: { near: quality.tier === 'low' ? 2 : 3, far: 2, build: buildSpruce, bark: spruceBark, leaf: (i) => spruceLeaf[i % 2] },
    birch: { near: 2, far: 1, build: buildBirch, bark: birchBark, leaf: (i) => birchLeaf[i % 2] },
    young: { near: quality.tier === 'low' ? 2 : 3, far: 2, build: (seed, near) => buildSpruce(seed, near, true), bark: spruceBark, leaf: (i) => spruceLeaf[(i + 1) % 2] },
  };

  const stats = { instances: 0, triangles: 0 };
  const dummy = new THREE.Object3D();

  for (const [species, v] of Object.entries(variants)) {
    for (const near of [true, false]) {
      const list = trees.filter((t) => t.species === species && t.near === near);
      const nTemplates = near ? v.near : v.far;
      for (let ti = 0; ti < nTemplates; ti++) {
        const inst = list.filter((_, i) => i % nTemplates === ti);
        if (!inst.length) continue;
        const tpl = v.build(1000 + ti * 37 + (near ? 0 : 500) + species.length * 101, near);
        const parts = [
          [tpl.bark, v.bark],
          [tpl.leaves, v.leaf(ti)],
        ];
        if (tpl.comb && tpl.comb.count) parts.push([tpl.comb, combLeaf]);
        if (tpl.lichen && tpl.lichen.count) parts.push([tpl.lichen, lichenMat]);
        // only trees that can throw shade into the (camera-following) shadow map are drawn into it
        const reach = quality.shadowExtent + 14;
        const casters = inst.filter((t) => distToPath(t.x, t.z) < reach);
        const others = inst.filter((t) => distToPath(t.x, t.z) >= reach);
        for (const [md, mat] of parts) {
          if (!md.count) continue;
          const geo = md.build();
          for (const [set, cast] of [
            [casters, true],
            [others, false],
          ]) {
            if (!set.length) continue;
            const mesh = new THREE.InstancedMesh(geo, mat, set.length);
            set.forEach((t, i) => {
              dummy.position.set(t.x, t.y, t.z);
              dummy.rotation.set(t.tiltX, t.rot, t.tiltZ);
              dummy.scale.setScalar(t.scale);
              dummy.updateMatrix();
              mesh.setMatrixAt(i, dummy.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.castShadow = quality.shadows && cast;
            mesh.receiveShadow = quality.shadows;
            if (mat.userData.depth) mesh.customDepthMaterial = mat.userData.depth;
            group.add(mesh);
          }
          stats.triangles += (geo.index.count / 3) * inst.length;
        }
        stats.instances += inst.length;
      }
    }
  }
  return { group, stats };
}
