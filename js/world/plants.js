import * as THREE from 'three';
import { RNG } from '../lib/random.js';
import { MeshData, addCard, addStrip } from '../lib/geometry.js';
import { foliageMaterial } from './materials.js';
import { heightAt, normalAt } from './terrain.js';
import { SAPLING } from './layout.js';
import { trunkTest, scatterNearPath, scatterDisc, distToSightline, distToCameraEnd } from './scatter.js';

// The forest floor: blåbärsris (blueberry), lingon, ferns, wavy hair-grass and feather-moss tufts.

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const upNormal = (k = 0.6) => (p, face) => {
  const sgn = face.y < 0 ? -1 : 1;
  return face.clone().multiplyScalar(sgn * (1 - k)).addScaledVector(UP, k).normalize();
};

function shrub(rng, w, h, cards = 4) {
  const md = new MeshData();
  md.cards = [];
  const a0 = rng.float(0, Math.PI);
  for (let i = 0; i < cards; i++) {
    const a = a0 + (i / cards) * Math.PI + rng.float(-0.2, 0.2);
    const right = v3(Math.cos(a), 0, Math.sin(a));
    const up = v3(rng.float(-0.12, 0.12), 1, rng.float(-0.12, 0.12)).normalize();
    const off = v3(rng.float(-0.05, 0.05), -0.02, rng.float(-0.05, 0.05));
    const t = rng.float(0.62, 1.0);
    const cw = w * rng.float(0.85, 1.15);
    const ch = h * rng.float(0.85, 1.15);
    addCard(md, off, up, right, cw, ch, {
      color: [t, t, t * 0.95],
      normal: upNormal(0.55),
      swayFn: (cy) => cy,
      h: 1,
    });
    md.cards.push({ base: off, up, right, w: cw, h: ch, normal: v3().crossVectors(right, up).normalize() });
  }
  return md;
}

// Dew drops sitting on real leaf pixels of the instanced shrubs within `radius` of `center`.
function shrubDew(rng, mesh, cards, alphaAt, center, radius, perCard = 3) {
  const out = [];
  if (!mesh || !alphaAt) return out;
  const m = new THREE.Matrix4();
  const p = v3();
  const pos = v3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    pos.setFromMatrixPosition(m);
    if (Math.hypot(pos.x - center.x, pos.z - center.y) > radius) continue;
    for (const c of cards) {
      for (let k = 0; k < perCard; k++) {
        const u = rng.next();
        const v = rng.next();
        if (alphaAt(u, v) < 0.6) continue;
        p.copy(c.base).addScaledVector(c.right, (u - 0.5) * c.w).addScaledVector(c.up, v * c.h).addScaledVector(c.normal, 0.003);
        p.applyMatrix4(m);
        out.push([p.x, p.y, p.z, rng.float(0.0008, 0.0019)]);
      }
    }
  }
  return out;
}

function fern(rng) {
  const md = new MeshData();
  const n = rng.int(7, 11);
  const a0 = rng.float(0, Math.PI * 2);
  for (let f = 0; f < n; f++) {
    const az = a0 + (f / n) * Math.PI * 2 + rng.float(-0.25, 0.25);
    const L = rng.float(0.55, 0.85);
    const el0 = THREE.MathUtils.degToRad(rng.float(58, 76));
    const droop = THREE.MathUtils.degToRad(rng.float(70, 110));
    const dirH = v3(Math.cos(az), 0, Math.sin(az));
    const right = v3(-Math.sin(az), 0, Math.cos(az));
    const twist = rng.float(-0.25, 0.25);
    const centers = [];
    const rights = [];
    const widths = [];
    const vs = [];
    const segs = 9;
    let p = v3(rng.float(-0.03, 0.03), 0, rng.float(-0.03, 0.03));
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      centers.push(p.clone());
      const r = right.clone().applyAxisAngle(dirH, twist * s);
      rights.push(r);
      widths.push(L * 0.32);
      vs.push(s);
      const el = el0 - droop * Math.pow(s, 1.3);
      const d = dirH.clone().multiplyScalar(Math.cos(el)).add(v3(0, Math.sin(el), 0));
      p = p.clone().addScaledVector(d, L / segs);
    }
    const t = rng.float(0.85, 1.12);
    addStrip(md, centers, rights, widths, vs, {
      color: [t, t, t * 0.92],
      swayFn: (i) => i / segs,
      normalFn: (i, c, n) => {
        const sgn = n.y < 0 ? -1 : 1;
        return n.clone().multiplyScalar(sgn * 0.5).addScaledVector(UP, 0.5).normalize();
      },
      h: 1,
    });
  }
  return md;
}

function grassTuft(rng) {
  const md = new MeshData();
  const n = rng.int(16, 26);
  for (let b = 0; b < n; b++) {
    const az = rng.float(0, Math.PI * 2);
    const L = rng.float(0.18, 0.42);
    const lean = rng.float(0.15, 0.6);
    const dirH = v3(Math.cos(az), 0, Math.sin(az));
    const right = v3(-Math.sin(az), 0, Math.cos(az));
    const centers = [];
    const rights = [];
    const widths = [];
    const vs = [];
    let p = v3(rng.float(-0.04, 0.04), 0, rng.float(-0.04, 0.04));
    const segs = 4;
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      centers.push(p.clone());
      rights.push(right);
      widths.push(0.007 * (1 - s * 0.85));
      vs.push(s);
      const el = Math.PI / 2 - lean * (0.3 + s * 1.4);
      p = p.clone().addScaledVector(dirH.clone().multiplyScalar(Math.cos(el)).add(v3(0, Math.sin(el), 0)), L / segs);
    }
    const dry = rng.next();
    addStrip(md, centers, rights, widths, vs, {
      colorFn: (i) => {
        const s = i / segs;
        const base = [0.05, 0.1, 0.02];
        const tip = dry > 0.8 ? [0.36, 0.32, 0.13] : [0.2, 0.28, 0.06];
        return base.map((c, k) => c + (tip[k] - c) * s);
      },
      swayFn: (i) => i / segs,
      normalFn: () => UP,
      h: 1,
    });
  }
  return md;
}

// A single leaf-litter card lying flat on the ground.
function litterCard() {
  const md = new MeshData();
  addCard(md, v3(0, 0.004, 0.11), v3(0, 0, -1), v3(1, 0, 0), 0.22, 0.22, { color: [1, 1, 1], normal: () => UP, sway: 0, h: 0 });
  return md;
}

function mossTuft(rng) {
  const md = new MeshData();
  const a0 = rng.float(0, Math.PI);
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i / 3) * Math.PI;
    const up = v3(rng.float(-0.3, 0.3), 1, rng.float(-0.3, 0.3)).normalize();
    const t = rng.float(0.85, 1.1);
    addCard(md, v3(0, -0.01, 0), up, v3(Math.cos(a), 0, Math.sin(a)), 0.075, 0.055, {
      color: [t, t, t],
      normal: upNormal(0.75),
      swayFn: (cy) => cy * 0.5,
      h: 1,
    });
  }
  return md;
}

function instanced(md, material, points, rng, { scale = [0.8, 1.2], sink = 0.02, tilt = 0.12, followNormal = 0.4, castShadow = false, receiveShadow = true } = {}) {
  if (!points.length) return null;
  const geo = md.build();
  const mesh = new THREE.InstancedMesh(geo, material, points.length);
  const dummy = new THREE.Object3D();
  const n = v3();
  const q = new THREE.Quaternion();
  points.forEach(([x, z, s0], i) => {
    const s = (s0 ?? 1) * rng.float(scale[0], scale[1]);
    dummy.position.set(x, heightAt(x, z) - sink * s, z);
    normalAt(x, z, 0.1, n);
    n.lerp(UP, 1 - followNormal).normalize();
    q.setFromUnitVectors(UP, n);
    dummy.quaternion.copy(q);
    dummy.rotateY(rng.float(0, Math.PI * 2));
    dummy.rotateX(rng.float(-tilt, tilt));
    dummy.rotateZ(rng.float(-tilt, tilt));
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  if (material.userData.depth) mesh.customDepthMaterial = material.userData.depth;
  return mesh;
}

export function buildPlants({ foliage, trees, eco, quality }) {
  const group = new THREE.Group();
  group.name = 'plants';
  const rng = new RNG(4242);
  const nearTrunk = trunkTest(trees);
  const k = quality.plants;
  const S = SAPLING;
  const dS = (x, z) => Math.hypot(x - S.x, z - S.y);
  const shadows = quality.shadows;
  const add = (m) => m && group.add(m);

  // ── blueberry ──
  const berryMat = foliageMaterial({ map: foliage.blueberry, wind: 'plant', height: 0.32, trans: [0.5, 0.65, 0.22], key: 'berry', season: 'berry' });
  const berryPts = scatterNearPath(rng, Math.round(12000 * k), 13, (x, z) => {
    if (nearTrunk(x, z, 0.25) || dS(x, z) < 0.55 || distToCameraEnd(x, z) < 1.0) return false;
    if (distToSightline(x, z) < 0.35) return false;
    const e = eco.ecoAt(x, z);
    return 0.15 + e.berry * 0.85 + e.moss * 0.2;
  });
  const dewTargets = [];
  for (let v = 0; v < 2; v++) {
    const md = shrub(rng, 0.42, 0.34, 4);
    const m = instanced(md, berryMat, berryPts.filter((_, i) => i % 2 === v), rng, { scale: [0.75, 1.25], castShadow: false });
    add(m);
    if (m) dewTargets.push([m, md.cards, foliage.blueberry]);
  }

  // ── lingon ──
  const lingMat = foliageMaterial({ map: foliage.lingon, wind: 'plant', height: 0.2, trans: [0.45, 0.55, 0.2], key: 'lingon', season: 'lingon' });
  const lingPts = scatterNearPath(rng, Math.round(2600 * k), 7, (x, z) => {
    if (nearTrunk(x, z, 0.2) || dS(x, z) < 0.45 || distToCameraEnd(x, z) < 0.7 || distToSightline(x, z) < 0.3) return false;
    const e = eco.ecoAt(x, z);
    return 0.2 + e.moss * (1 - e.berry) * 0.8;
  });
  // a few lingon plants right beside the sapling for colour
  for (const [dx, dz] of [[0.55, 0.35], [-0.5, 0.25], [0.35, -0.55], [-0.75, -0.3], [0.9, -0.1]]) lingPts.push([S.x + dx, S.y + dz, 0.9]);
  {
    const md = shrub(rng, 0.26, 0.2, 3);
    const m = instanced(md, lingMat, lingPts, rng, { scale: [0.75, 1.2] });
    add(m);
    if (m) dewTargets.push([m, md.cards, foliage.lingon]);
  }

  // ── ferns ──
  const fernMats = foliage.fern.map((map, i) => foliageMaterial({ map, wind: 'plant', height: 0.6, trans: [0.7, 0.8, 0.28], power: 3, key: `fern${i}`, season: 'fern' }));
  const fernPts = scatterNearPath(rng, Math.round(300 * k), 9, (x, z) => {
    if (nearTrunk(x, z, 0.4) || dS(x, z) < 1.1 || distToCameraEnd(x, z) < 1.7 || distToSightline(x, z) < 0.8) return false;
    const e = eco.ecoAt(x, z);
    return 0.2 + e.damp * 0.8 + e.moss * 0.2;
  });
  for (const [dx, dz, s] of [[1.6, 0.6, 1.1], [-1.35, 0.25, 1.0], [0.8, -1.6, 1.15], [-0.7, -2.0, 0.95], [2.3, -1.0, 1.05], [-2.2, -0.9, 1.1]]) {
    fernPts.push([S.x + dx, S.y + dz, s]);
  }
  for (let v = 0; v < 2; v++) {
    add(instanced(fern(rng), fernMats[v], fernPts.filter((_, i) => i % 2 === v), rng, { scale: [0.8, 1.2], tilt: 0.08, castShadow: shadows }));
  }

  // ── wavy hair-grass ──
  const grassMat = foliageMaterial({ map: null, wind: 'plant', height: 0.35, trans: [1.2, 1.1, 0.5], a2c: false, alphaTest: 0, power: 3, key: 'grass', season: 'grass' });
  const grassPts = scatterNearPath(rng, Math.round(1700 * k), 8, (x, z) => {
    if (nearTrunk(x, z, 0.3) || dS(x, z) < 0.5 || distToCameraEnd(x, z) < 0.6 || distToSightline(x, z) < 0.25) return false;
    const e = eco.ecoAt(x, z);
    return 0.12 + (1 - e.berry) * 0.5;
  });
  add(instanced(grassTuft(rng), grassMat, grassPts, rng, { scale: [0.7, 1.3], tilt: 0.1 }));

  // ── feather-moss tufts: the fluffy 3D surface of the close-up ──
  const mossMat = foliageMaterial({ map: foliage.moss, wind: 'plant', height: 0.06, trans: [0.32, 0.4, 0.1], key: 'moss', season: 'moss' });
  const cx = (S.x + 1.3) / 2;
  const cz = (S.y - 15) / 2;
  const mossPts = scatterDisc(rng, Math.round(14000 * k), cx, cz - 0.5, 5.5, (x, z) => {
    if (nearTrunk(x, z, 0.12) || dS(x, z) < 0.07) return false;
    const e = eco.ecoAt(x, z);
    return 0.25 + e.moss * 0.75;
  }).concat(
    scatterNearPath(rng, Math.round(5000 * k), 3.5, (x, z) => {
      if (nearTrunk(x, z, 0.12)) return false;
      return eco.ecoAt(x, z).moss;
    }),
  );
  add(instanced(mossTuft(rng), mossMat, mossPts, rng, { scale: [0.7, 1.5], sink: 0.012, tilt: 0.25, followNormal: 0.8 }));

  // ── fallen birch leaves, thickest under the birches ──
  const litterMat = foliageMaterial({ map: foliage.litter, wind: 'plant', height: 0.05, trans: [0.35, 0.3, 0.1], key: 'litter' });
  const birches = trees.filter((t) => t.species === 'birch' || t.species === 'youngBirch');
  const birchNear = (x, z) => {
    let w = 0;
    for (const b of birches) {
      const d2 = (b.x - x) ** 2 + (b.z - z) ** 2;
      if (d2 < 36) w += (b.species === 'birch' ? 1 : 0.4) * Math.exp(-d2 / 14);
    }
    return Math.min(1, w);
  };
  const litterPts = scatterNearPath(rng, Math.round(3600 * k), 9, (x, z) => {
    if (nearTrunk(x, z, 0.1) || dS(x, z) < 0.3 || distToCameraEnd(x, z) < 0.35) return false;
    return 0.06 + 0.94 * birchNear(x, z);
  });
  add(instanced(litterCard(), litterMat, litterPts, rng, { scale: [0.7, 1.3], sink: 0, tilt: 0.2, followNormal: 1.0 }));

  // ── dew on the leaves of the shrubs the camera ends up among ──
  const leafDew = [];
  if (quality.leafDew) {
    const center = new THREE.Vector2(S.x, S.y + 0.4);
    for (const [mesh, cards, tex] of dewTargets) leafDew.push(...shrubDew(rng, mesh, cards, tex.userData.alphaAt, center, 3.4, 3));
  }

  return { group, mossPoints: mossPts, grassPoints: grassPts, leafDew };
}
