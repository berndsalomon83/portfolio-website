import * as THREE from 'three';
import { RNG, fbm3 } from '../lib/random.js';
import { MeshData, addTube } from '../lib/geometry.js';
import { rockMaterial, barkMaterial } from './materials.js';
import { heightAt } from './terrain.js';
import { SAPLING, distToPath } from './layout.js';
import { trunkTest, scatterNearPath, distToSightline, distToCameraEnd } from './scatter.js';

// Things lying on the forest floor: glacial boulders, fallen logs, twigs, cones and mushrooms.

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ── Boulders: displaced cube-sphere, normals from the continuous surface (no seams) ──
function rockGeometry(seed, res, scale) {
  const rng = new RNG(seed);
  const o = [rng.float(0, 50), rng.float(0, 50), rng.float(0, 50)];
  const surf = (d) => {
    let r = 1 + fbm3(d.x * 0.9 + o[0], d.y * 0.9 + o[1], d.z * 0.9 + o[2], 3) * 0.42;
    r += fbm3(d.x * 3.2 + o[2], d.y * 3.2 + o[0], d.z * 3.2 + o[1], 3) * 0.08;
    r -= Math.abs(fbm3(d.x * 6 + o[1], d.y * 6 + o[2], d.z * 6 + o[0], 2)) * 0.035;
    const p = d.clone().multiplyScalar(r).multiply(scale);
    if (p.y < -0.15 * scale.y) p.y = -0.15 * scale.y + (p.y + 0.15 * scale.y) * 0.35;
    return p;
  };
  const faces = [
    [v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)],
    [v3(-1, 0, 0), v3(0, 0, 1), v3(0, 1, 0)],
    [v3(0, 1, 0), v3(1, 0, 0), v3(0, 0, -1)],
    [v3(0, -1, 0), v3(1, 0, 0), v3(0, 0, 1)],
    [v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)],
    [v3(0, 0, -1), v3(-1, 0, 0), v3(0, 1, 0)],
  ];
  const pos = [];
  const nor = [];
  const idx = [];
  const e = 1e-3;
  const dirAt = (n, u, w, a, b) => n.clone().addScaledVector(u, a).addScaledVector(w, b).normalize();
  for (const [n, u, w] of faces) {
    const base = pos.length / 3;
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        const a = (i / res) * 2 - 1;
        const b = (j / res) * 2 - 1;
        const p = surf(dirAt(n, u, w, a, b));
        const pa = surf(dirAt(n, u, w, a + e, b)).sub(p);
        const pb = surf(dirAt(n, u, w, a, b + e)).sub(p);
        const nn = v3().crossVectors(pa, pb).normalize();
        if (nn.dot(p) < 0) nn.negate();
        pos.push(p.x, p.y, p.z);
        nor.push(nn.x, nn.y, nn.z);
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = base + j * (res + 1) + i;
        const b = a + 1;
        const c = a + res + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  // make sure triangles face outward
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const pc = new THREE.Vector3();
  const ix = g.index.array;
  for (let t = 0; t < ix.length; t += 3) {
    pa.fromArray(pos, ix[t] * 3);
    pb.fromArray(pos, ix[t + 1] * 3);
    pc.fromArray(pos, ix[t + 2] * 3);
    const fn = v3().crossVectors(pb.clone().sub(pa), pc.clone().sub(pa));
    if (fn.dot(pa) < 0) {
      const tmp = ix[t + 1];
      ix[t + 1] = ix[t + 2];
      ix[t + 2] = tmp;
    }
  }
  g.computeBoundingSphere();
  return g;
}

// ── Pine cone: spiral scales via radius modulation + vertex colour ──
function coneGeometry() {
  const segs = 28;
  const rings = 22;
  const L = 0.05;
  const pos = [];
  const col = [];
  const idx = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.7) * (1 - 0.35 * t);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const s1 = Math.sin(a * 5 + t * 30);
      const s2 = Math.sin(-a * 8 + t * 48);
      const bump = Math.max(0, s1 * s2);
      const r = 0.013 * prof * (1 + 0.32 * bump);
      pos.push(Math.cos(a) * r, t * L, Math.sin(a) * r);
      const k = 0.55 + 0.6 * bump;
      col.push(0.22 * k, 0.12 * k, 0.06 * k);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      const b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.rotateZ(Math.PI / 2);
  g.translate(L * 0.5, 0.009, 0);
  return g;
}

function lathe(points, segs = 32) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segs);
}

function chanterelle(rng) {
  const s = rng.float(0.8, 1.2);
  const g = lathe(
    [
      [0.0001, 0],
      [0.007, 0.0],
      [0.008, 0.012],
      [0.011, 0.026],
      [0.019, 0.036],
      [0.03, 0.044],
      [0.036, 0.047],
      [0.034, 0.042],
      [0.026, 0.045],
      [0.012, 0.043],
      [0.0001, 0.04],
    ],
    40,
  );
  const p = g.attributes.position;
  const ph = rng.float(0, 6);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r > 0.018) {
      const a = Math.atan2(z, x);
      const w = Math.sin(a * 5 + ph) * 0.004 + Math.sin(a * 9 + ph * 2) * 0.002;
      const k = (r - 0.018) / 0.018;
      p.setY(i, p.getY(i) + w * k);
      p.setX(i, x * (1 + w * k * 6));
      p.setZ(i, z * (1 + w * k * 6));
    }
  }
  g.computeVertexNormals();
  g.scale(s, s, s);
  return g;
}

function flyAgaric(rng, open = 1) {
  const group = new THREE.Group();
  const s = rng.float(0.9, 1.15);
  const stemMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.82, 0.8, 0.72), roughness: 0.7 });
  const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.62, 0.035, 0.015), roughness: 0.32 });
  const wartMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.88, 0.85, 0.76), roughness: 0.8 });
  const H = 0.1 * s;
  const stem = new THREE.Mesh(
    lathe([
      [0.0001, 0],
      [0.016, 0],
      [0.014, 0.01],
      [0.011, H * 0.5],
      [0.012, H * 0.72],
      [0.022, H * 0.74],
      [0.012, H * 0.78],
      [0.01, H],
      [0.0001, H],
    ]),
    stemMat,
  );
  const capR = 0.055 * s;
  const capGeo = new THREE.SphereGeometry(capR, 40, 20, 0, Math.PI * 2, 0, Math.PI * (0.32 + 0.18 * (1 - open)));
  capGeo.scale(1, 0.55 + 0.35 * (1 - open), 1);
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.y = H - capR * 0.25;
  const under = new THREE.Mesh(new THREE.CircleGeometry(capR * Math.sin(Math.PI * 0.32) * 0.98, 32), stemMat);
  under.rotation.x = Math.PI / 2;
  under.position.y = H + capR * 0.02;
  const warts = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0045, 8, 6).scale(1, 0.5, 1), wartMat, 34);
  const d = new THREE.Object3D();
  for (let i = 0; i < 34; i++) {
    const th = rng.float(0, Math.PI * 2);
    const ph = Math.acos(1 - rng.next() * (1 - Math.cos(Math.PI * 0.28)));
    const nrm = v3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
    d.position.set(nrm.x * capR, nrm.y * capR * (0.55 + 0.35 * (1 - open)), nrm.z * capR).add(cap.position);
    d.quaternion.setFromUnitVectors(UP, nrm);
    d.scale.setScalar(rng.float(0.6, 1.3));
    d.updateMatrix();
    warts.setMatrixAt(i, d.matrix);
  }
  group.add(stem, cap, under, warts);
  for (const m of group.children) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  return group;
}

export function buildProps({ surfaces, foliage, trees, quality }) {
  const group = new THREE.Group();
  group.name = 'props';
  const rng = new RNG(777);
  const S = SAPLING;
  const nearTrunk = trunkTest(trees);
  const shadows = quality.shadows;

  // ── rocks ──
  const rockMat = rockMaterial({ rock: surfaces.rock, moss: surfaces.moss, mossBias: 0.05 });
  const rockMatMossy = rockMaterial({ rock: surfaces.rock, moss: surfaces.moss, mossBias: 0.28 });
  const hero = new THREE.Mesh(rockGeometry(5, quality.tier === 'low' ? 24 : 48, v3(1.15, 0.8, 0.95)), rockMatMossy);
  hero.position.set(S.x - 1.9, heightAt(S.x - 1.9, S.y - 1.5) - 0.28, S.y - 1.5);
  hero.rotation.y = 0.6;
  const rocks = [hero];
  const rockPts = scatterNearPath(rng, 26, 9, (x, z) => !nearTrunk(x, z, 1.2) && distToPath(x, z) > 1.6 && distToSightline(x, z) > 1.2);
  rockPts.forEach(([x, z], i) => {
    const sc = rng.float(0.25, 0.9);
    const geo = rockGeometry(100 + i, 18, v3(sc * rng.float(0.9, 1.4), sc * rng.float(0.5, 0.85), sc * rng.float(0.9, 1.3)));
    const m = new THREE.Mesh(geo, i % 3 === 0 ? rockMat : rockMatMossy);
    m.position.set(x, heightAt(x, z) - sc * 0.22, z);
    m.rotation.y = rng.float(0, 6.28);
    rocks.push(m);
  });
  for (const r of rocks) {
    r.castShadow = shadows;
    r.receiveShadow = shadows;
    group.add(r);
  }

  // ── surface roots of the trees nearest the walk ──
  {
    const coniferMd = new MeshData();
    const birchMd = new MeshData();
    const hosts = trees.filter((t) => t.near && t.species !== 'young' && t.species !== 'youngBirch' && distToPath(t.x, t.z) < 9);
    for (const t of hosts) {
      const md = t.species === 'birch' ? birchMd : coniferMd;
      const r0 = (t.species === 'spruce' ? 0.23 : t.species === 'birch' ? 0.19 : 0.2) * t.scale;
      const n = rng.int(3, 6);
      const a0 = rng.float(0, 6.28);
      for (let i = 0; i < n; i++) {
        const az = a0 + (i / n) * 6.283 + rng.float(-0.35, 0.35);
        const dir = v3(Math.cos(az), 0, Math.sin(az));
        const L = rng.float(0.7, 2.2) * t.scale;
        const pts = [];
        const rad = [];
        const segs = 6;
        for (let k = 0; k <= segs; k++) {
          const s = k / segs;
          const wob = rng.float(-0.08, 0.08) * s;
          const px = t.x + dir.x * (r0 * 0.6 + L * s) + wob;
          const pz = t.z + dir.z * (r0 * 0.6 + L * s) - wob;
          const rr = (0.07 + 0.05 * (r0 / 0.2)) * (1 - 0.8 * s) + 0.015;
          const lift = rr * (0.55 - 0.95 * s);
          pts.push(v3(px, heightAt(px, pz) + lift, pz));
          rad.push(rr * (1 + 0.15 * Math.sin(s * 9 + az)));
        }
        addTube(md, pts, rad, { radial: 7, uRepeat: 1, vScale: 0.5, h: () => 0.02, radiusMod: (k, a) => 1 - 0.3 * Math.abs(Math.sin(a)) });
      }
    }
    const rootMatC = barkMaterial({ texA: surfaces.pineLower, texB: surfaces.spruce, mixAt: 2, footMoss: 1, topMoss: 0.5, wind: false, normalScale: 1.3 });
    const rootMatB = barkMaterial({ texA: surfaces.birchBase, texB: surfaces.birch, mixAt: 2, footMoss: 1, topMoss: 0.4, wind: false });
    for (const [md, mat] of [[coniferMd, rootMatC], [birchMd, rootMatB]]) {
      if (!md.count) continue;
      const m = new THREE.Mesh(md.build(), mat);
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      group.add(m);
    }
  }

  // ── snags: dead pines with the bark gone and the tops broken off ──
  {
    const md = new MeshData();
    const spots = [[-5.6, -4.6, 11], [6.4, -13.8, 9], [-4.6, 11.0, 13], [7.5, 2.5, 10]];
    for (const [x, z, H] of spots) {
      if (nearTrunk(x, z, 1.0)) continue;
      const y0 = heightAt(x, z) - 0.3;
      const pts = [];
      const rad = [];
      const rings = 12;
      const lean = [rng.float(-0.04, 0.04), rng.float(-0.04, 0.04)];
      for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        pts.push(v3(x + lean[0] * H * t * t, y0 + H * t, z + lean[1] * H * t * t));
        rad.push(Math.max(0.05, 0.24 * Math.pow(1 - t, 0.8)) * (1 + 0.5 * Math.exp((-t * H) / 0.4)));
      }
      addTube(md, pts, rad, { radial: 12, uRepeat: 2, vScale: 1.5, h: () => 0.5, radiusMod: (i, a, p) => 1 + (p.y - y0 > H - 0.5 ? 0.5 * Math.abs(Math.sin(a * 3)) : 0) });
      for (let k = 0; k < 7; k++) {
        const t = rng.float(0.3, 0.95);
        const p0 = pts[Math.floor(t * rings)];
        const az = rng.float(0, 6.28);
        const d = v3(Math.cos(az), rng.float(-0.2, 0.3), Math.sin(az)).normalize();
        addTube(md, [p0.clone(), p0.clone().addScaledVector(d, rng.float(0.2, 0.7))], [0.04, 0.012], { radial: 4, vScale: 0.5, h: () => 0.5 });
      }
    }
    const snag = new THREE.Mesh(md.build(), barkMaterial({ texA: surfaces.deadwood, texB: surfaces.deadwood, mixAt: 2, footMoss: 0.3, topMoss: 0.1, wind: false, normalScale: 1.5 }));
    snag.castShadow = shadows;
    snag.receiveShadow = shadows;
    group.add(snag);
  }

  // ── fallen logs (half bark, half grey deadwood, moss on top) ──
  const logMat = barkMaterial({ texA: surfaces.spruce, texB: surfaces.deadwood, mixAt: 0.5, mixWidth: 0.25, footMoss: 0, topMoss: 1, wind: false, normalScale: 1.4 });
  const capMat = new THREE.MeshStandardMaterial({ map: foliage.woodEnd, roughness: 0.9 });
  const logs = [
    [S.x + 0.75, S.y - 0.35, S.x + 4.6, S.y - 2.9, 0.19],
    [2.7, -7.2, 6.8, -11.6, 0.24],
    [-2.8, -3.5, -6.5, 0.5, 0.21],
  ];
  const logMd = new MeshData();
  for (const [x0, z0, x1, z1, r] of logs) {
    const pts = [];
    const rad = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      pts.push(v3(x, heightAt(x, z) + r * 0.62, z));
      rad.push(r * (1 - 0.15 * t) * (1 + 0.04 * Math.sin(t * 17)));
    }
    // smooth the resting line so the log does not follow every hummock
    for (let it = 0; it < 3; it++) for (let i = 1; i < n; i++) pts[i].y = Math.max(pts[i].y, (pts[i - 1].y + pts[i + 1].y) / 2);
    addTube(logMd, pts, rad, { radial: 18, uRepeat: 3, vScale: 1.2, h: () => 0.5, color: [1, 1, 1] });
    for (const [end, dirSign] of [[0, -1], [n, 1]]) {
      const p = pts[end];
      const tg = pts[Math.min(n, end + 1)].clone().sub(pts[Math.max(0, end - 1)]).normalize().multiplyScalar(dirSign);
      const capm = new THREE.Mesh(new THREE.CircleGeometry(rad[end] * 0.97, 24), capMat);
      capm.position.copy(p);
      capm.quaternion.setFromUnitVectors(v3(0, 0, 1), tg);
      capm.castShadow = shadows;
      capm.receiveShadow = shadows;
      group.add(capm);
    }
  }
  const logMesh = new THREE.Mesh(logMd.build(), logMat);
  logMesh.castShadow = shadows;
  logMesh.receiveShadow = shadows;
  group.add(logMesh);

  // ── cut stump ──
  {
    const x = -1.7;
    const z = -6.2;
    const y = heightAt(x, z);
    const md = new MeshData();
    const pts = [v3(x, y - 0.2, z), v3(x, y + 0.1, z), v3(x, y + 0.36, z)];
    addTube(md, pts, [0.36, 0.3, 0.28], { radial: 22, uRepeat: 3, vScale: 1.2, h: () => 0.1 });
    const stump = new THREE.Mesh(md.build(), barkMaterial({ texA: surfaces.pineLower, texB: surfaces.pineLower, mixAt: 2, footMoss: 0, topMoss: 0.6, wind: false }));
    const top = new THREE.Mesh(new THREE.CircleGeometry(0.28, 28), capMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(x, y + 0.361, z);
    for (const m of [stump, top]) {
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      group.add(m);
    }
  }

  // ── dead twigs and fallen branches ──
  const twigMd = new MeshData();
  const twigPts = scatterNearPath(rng, Math.round(220 * quality.plants + 30), 6, (x, z) => distToCameraEnd(x, z) > 0.6 && distToSightline(x, z) > 0.15);
  for (const [dx, dz] of [[0.5, 0.9], [-0.4, 1.3], [0.9, 0.2]]) twigPts.push([S.x + dx, S.y + dz]);
  for (const [x, z] of twigPts) {
    const L = rng.float(0.25, 1.3);
    const a = rng.float(0, 6.28);
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const px = x + d.x * L * (i / 4) + rng.float(-0.03, 0.03);
      const pz = z + d.z * L * (i / 4) + rng.float(-0.03, 0.03);
      pts.push(v3(px, heightAt(px, pz) + 0.012, pz));
    }
    const r = rng.float(0.006, 0.018) * (0.6 + L * 0.4);
    addTube(twigMd, pts, pts.map((_, i) => r * (1 - i * 0.18)), { radial: 4, vScale: 0.5, h: () => 0.5 });
    for (let k = 0; k < rng.int(0, 3); k++) {
      const p0 = pts[rng.int(1, 3)];
      const sd = d.clone().applyAxisAngle(UP, rng.sign() * rng.float(0.5, 1.0));
      sd.y = rng.float(0.05, 0.35);
      sd.normalize();
      const p1 = p0.clone().addScaledVector(sd, L * rng.float(0.15, 0.35));
      addTube(twigMd, [p0, p1], [r * 0.6, r * 0.25], { radial: 3, vScale: 0.5, h: () => 0.5 });
    }
  }
  const twigs = new THREE.Mesh(
    twigMd.build(),
    barkMaterial({ texA: surfaces.deadwood, texB: surfaces.spruce, mixAt: 0.5, mixWidth: 0.4, footMoss: 0, topMoss: 0.15, wind: false }),
  );
  twigs.castShadow = shadows;
  twigs.receiveShadow = shadows;
  group.add(twigs);

  // ── pine cones ──
  const coneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const conePts = scatterNearPath(rng, Math.round(650 * quality.plants + 80), 5, (x, z) => (nearTrunk(x, z, 4) ? 1 : 0.25) * (distToCameraEnd(x, z) > 0.4 ? 1 : 0));
  for (const [dx, dz] of [[0.25, 0.75], [-0.3, 0.55], [0.15, 1.2], [-0.6, 1.0]]) conePts.push([S.x + dx, S.y + dz]);
  const cones = new THREE.InstancedMesh(coneGeometry(), coneMat, conePts.length);
  const dmy = new THREE.Object3D();
  conePts.forEach(([x, z], i) => {
    dmy.position.set(x, heightAt(x, z) - 0.004, z);
    dmy.rotation.set(rng.float(-0.25, 0.25), rng.float(0, 6.28), rng.float(-0.2, 0.2));
    dmy.scale.setScalar(rng.float(0.75, 1.2));
    dmy.updateMatrix();
    cones.setMatrixAt(i, dmy.matrix);
  });
  cones.castShadow = shadows;
  cones.receiveShadow = shadows;
  group.add(cones);

  // ── pebbles and small stones ──
  {
    const variants = [0, 1, 2].map((i) => rockGeometry(300 + i, 8, v3(1, 0.7, 0.9)));
    const pts = scatterNearPath(rng, Math.round(170 * quality.plants + 40), 6, (x, z) => !nearTrunk(x, z, 0.3) && distToCameraEnd(x, z) > 0.5 && distToSightline(x, z) > 0.2);
    for (let v = 0; v < 3; v++) {
      const list = pts.filter((_, i) => i % 3 === v);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(variants[v], v === 1 ? rockMatMossy : rockMat, list.length);
      list.forEach(([x, z], i) => {
        const sc = rng.float(0.03, 0.11);
        dmy.position.set(x, heightAt(x, z) - sc * 0.3, z);
        dmy.rotation.set(rng.float(-0.3, 0.3), rng.float(0, 6.28), rng.float(-0.3, 0.3));
        dmy.scale.set(sc * rng.float(0.8, 1.5), sc * rng.float(0.5, 0.9), sc * rng.float(0.8, 1.3));
        dmy.updateMatrix();
        mesh.setMatrixAt(i, dmy.matrix);
      });
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      group.add(mesh);
    }
  }

  // ── boletes (karljohan): fat pale stems under brown caps ──
  {
    const bCap = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.36, 0.17, 0.06), roughness: 0.45 });
    const bStem = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.78, 0.7, 0.52), roughness: 0.85 });
    const spots = [[S.x - 0.9, S.y + 1.25, 1.0], [S.x - 1.05, S.y + 1.4, 0.7], [S.x + 1.3, S.y + 0.95, 0.9], [2.0, -9.6, 1.1], [1.9, -9.45, 0.75], [-0.3, -5.2, 1.0], [2.6, -3.4, 0.9]];
    for (const [x, z, sc] of spots) {
      const H = 0.075;
      const stem = new THREE.Mesh(lathe([[0.0001, 0], [0.028, 0], [0.03, H * 0.3], [0.024, H * 0.75], [0.02, H], [0.0001, H]], 24), bStem);
      const cap = new THREE.Mesh(lathe([[0.0001, H * 0.85], [0.04, H * 0.85], [0.052, H * 0.95], [0.05, H * 1.1], [0.036, H * 1.3], [0.015, H * 1.42], [0.0001, H * 1.45]], 32), bCap);
      const g = new THREE.Group();
      g.add(stem, cap);
      g.position.set(x, heightAt(x, z) - 0.008, z);
      g.rotation.set(rng.float(-0.1, 0.1), rng.float(0, 6), rng.float(-0.1, 0.1));
      g.scale.setScalar(sc);
      for (const m of g.children) {
        m.castShadow = shadows;
        m.receiveShadow = shadows;
      }
      group.add(g);
    }
  }

  // ── mushrooms: kantareller in the moss, a pair of flugsvampar by the boulder ──
  const chantMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.72, 0.34, 0.025), roughness: 0.6 });
  for (const [dx, dz, ry] of [[0.42, 0.62, 0.3], [0.55, 0.5, 1.4], [0.33, 0.78, 2.2], [0.62, 0.72, 0.9], [-1.15, 1.05, 0.1]]) {
    const m = new THREE.Mesh(chanterelle(rng), chantMat);
    const x = S.x + dx;
    const z = S.y + dz;
    m.position.set(x, heightAt(x, z) - 0.006, z);
    m.rotation.set(rng.float(-0.12, 0.12), ry, rng.float(-0.12, 0.12));
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    group.add(m);
  }
  for (const [dx, dz, open, sc] of [[-0.95, -0.75, 1, 1.0], [-1.12, -0.6, 0.35, 0.7]]) {
    const m = flyAgaric(rng, open);
    const x = S.x + dx;
    const z = S.y + dz;
    m.position.set(x, heightAt(x, z) - 0.008, z);
    m.rotation.set(rng.float(-0.06, 0.06), rng.float(0, 6), rng.float(-0.06, 0.06));
    m.scale.setScalar(sc);
    group.add(m);
  }

  return { group, logs, hero };
}
