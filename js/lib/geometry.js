import * as THREE from 'three';

// A growable vertex soup that turns into an indexed BufferGeometry.
// Every vertex carries: position, normal, uv, color (tint / AO), aSway (wind weight), aH (normalised height).
export class MeshData {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.sway = [];
    this.h = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(p, n, u, v, c, sway = 0, h = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.sway.push(sway);
    this.h.push(h);
    return this.count - 1;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute('aH', new THREE.Float32BufferAttribute(this.h, 1));
    const Index = this.count > 65535 ? THREE.Uint32BufferAttribute : THREE.Uint16BufferAttribute;
    g.setIndex(new Index(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Rotation-minimising frames along a polyline.
export function frames(pts) {
  const n = pts.length;
  const T = [];
  const N = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const ref = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let nn = new THREE.Vector3().crossVectors(T[0], ref).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      nn = nn.clone().addScaledVector(T[i], -nn.dot(T[i]));
      if (nn.lengthSq() < 1e-8) nn = N[i - 1].clone();
      nn.normalize();
    }
    N.push(nn.clone());
    B.push(new THREE.Vector3().crossVectors(T[i], nn).normalize());
  }
  return { T, N, B };
}

// Tapered tube along a polyline (trunks, branches, stems, roots).
export function addTube(md, pts, radii, o = {}) {
  const radial = o.radial ?? 8;
  const uRep = o.uRepeat ?? 1;
  const vScale = o.vScale ?? 1;
  const col = o.color ?? [1, 1, 1];
  const { N, B } = frames(pts);
  const base = md.count;
  let acc = o.vOffset ?? 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += pts[i].distanceTo(pts[i - 1]) / vScale;
    const p = pts[i];
    const sw = o.sway ? o.sway(i, p) : 0;
    const hh = o.h ? o.h(i, p) : 0;
    const c = o.colorFn ? o.colorFn(i, p) : col;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = N[i].x * ca + B[i].x * sa;
      const dy = N[i].y * ca + B[i].y * sa;
      const dz = N[i].z * ca + B[i].z * sa;
      const r = radii[i] * (o.radiusMod ? o.radiusMod(i, a, p) : 1);
      md.pos.push(p.x + dx * r, p.y + dy * r, p.z + dz * r);
      md.nor.push(dx, dy, dz);
      md.uv.push((j / radial) * uRep, acc);
      md.col.push(c[0], c[1], c[2]);
      md.sway.push(sw);
      md.h.push(hh);
    }
  }
  const R = radial + 1;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * R + j;
      const b = a + R;
      md.idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
}

const _p = new THREE.Vector3();
const _face = new THREE.Vector3();

// A single textured quad. `base` is the bottom-centre, `up` follows texture +v, `right` follows +u.
export function addCard(md, base, up, right, w, h, o = {}) {
  const col = o.color ?? [1, 1, 1];
  const uv = o.uv ?? [0, 0, 1, 1];
  _face.crossVectors(right, up).normalize();
  const i0 = md.count;
  const corners = [
    [-0.5, 0],
    [0.5, 0],
    [0.5, 1],
    [-0.5, 1],
  ];
  for (const [cx, cy] of corners) {
    _p.copy(base).addScaledVector(right, cx * w).addScaledVector(up, cy * h);
    const n = o.normal ? o.normal(_p, _face, cy) : _face;
    md.pos.push(_p.x, _p.y, _p.z);
    md.nor.push(n.x, n.y, n.z);
    md.uv.push(uv[0] + (cx + 0.5) * (uv[2] - uv[0]), uv[1] + cy * (uv[3] - uv[1]));
    md.col.push(col[0], col[1], col[2]);
    md.sway.push(o.swayFn ? o.swayFn(cy) : o.sway ?? 0);
    md.h.push(o.h ?? 0);
  }
  md.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
}

// A ribbon following a centre line (fern fronds, grass blades, hanging lichen…).
// centers[i], rights[i] (unit), widths[i], vs[i] → one row of two vertices per entry.
export function addStrip(md, centers, rights, widths, vs, o = {}) {
  const col = o.color ?? [1, 1, 1];
  const i0 = md.count;
  const { T } = frames(centers);
  const n = new THREE.Vector3();
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    n.crossVectors(rights[i], T[i]).normalize();
    if (o.normalFn) n.copy(o.normalFn(i, c, n));
    const cc = o.colorFn ? o.colorFn(i) : col;
    const sw = o.swayFn ? o.swayFn(i) : o.sway ?? 0;
    const hh = o.hFn ? o.hFn(i) : o.h ?? 0;
    for (const s of [-0.5, 0.5]) {
      _p.copy(c).addScaledVector(rights[i], s * widths[i]);
      md.pos.push(_p.x, _p.y, _p.z);
      md.nor.push(n.x, n.y, n.z);
      md.uv.push(s + 0.5, vs[i]);
      md.col.push(cc[0], cc[1], cc[2]);
      md.sway.push(sw);
      md.h.push(hh);
    }
  }
  for (let i = 0; i < centers.length - 1; i++) {
    const a = i0 + i * 2;
    md.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
}

// Fullscreen triangle used by every post-processing pass and the texture baker.
let _fsTri = null;
export function fullscreenTriangle() {
  if (_fsTri) return _fsTri;
  _fsTri = new THREE.BufferGeometry();
  _fsTri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  _fsTri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return _fsTri;
}
