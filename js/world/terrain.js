import * as THREE from 'three';
import { fbm2, noise2, smoothstep } from '../lib/random.js';
import { distToPath, SAPLING, GROUND_FOCUS } from './layout.js';

// Rolling glacial terrain: long swells, mossy hummocks, a calm walking line and a small mound for the sapling.
export function heightAt(x, z) {
  const big = fbm2(x * 0.0105 + 3.1, z * 0.0105 - 1.7, 4) * 3.2;
  const mid = fbm2(x * 0.055 - 7.3, z * 0.055 + 2.2, 3) * 0.36;
  const hum = fbm2(x * 0.42 + 11.0, z * 0.42 - 4.0, 2) * 0.085;
  const fine = noise2(x * 1.9, z * 1.9) * 0.018;
  const calm = smoothstep(0.6, 7.0, distToPath(x, z));
  const ds2 = (x - SAPLING.x) ** 2 + (z - SAPLING.y) ** 2;
  const mound = 0.09 * Math.exp(-ds2 / 0.7);
  return big + mid * (0.45 + 0.55 * calm) + hum * (0.4 + 0.6 * calm) + fine + mound;
}

export function normalAt(x, z, e = 0.04, out = new THREE.Vector3()) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// Grid warped so vertices crowd around the forest-floor close-up and thin out toward the horizon.
export function groundGeometry(segs = 360, extent = 150) {
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const nv = new THREE.Vector3();
  const warp = (s) => Math.sign(s) * Math.pow(Math.abs(s), 2.0) * extent;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = GROUND_FOCUS.x + warp((i / segs) * 2 - 1);
      const z = GROUND_FOCUS.y + warp((j / segs) * 2 - 1);
      const y = heightAt(x, z);
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      normalAt(x, z, 0.06, nv);
      nor[k * 3] = nv.x;
      nor[k * 3 + 1] = nv.y;
      nor[k * 3 + 2] = nv.z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = z;
    }
  }
  const idx = new Uint32Array(segs * segs * 6);
  let p = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// Ecology map: R = moss cover, G = blueberry shade, B = damp hollows. Sampled by the ground shader
// and (via ecoAt) by the undergrowth scatter so plants grow where the ground looks right.
export function buildEcology(trees, rect = [-100, -100, 200, 200], size = 256) {
  const [x0, z0, w, h] = rect;
  const data = new Uint8Array(size * size * 4);
  const cell = 6;
  const grid = new Map();
  for (const t of trees) {
    const key = `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(t);
  }
  const field = new Float32Array(size * size * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = x0 + ((i + 0.5) / size) * w;
      const z = z0 + ((j + 0.5) / size) * h;
      let litter = 0;
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const list = grid.get(`${gx + a},${gz + b}`);
          if (!list) continue;
          for (const t of list) {
            const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
            const k = t.species === 'spruce' ? 0.85 : t.species === 'pine' ? 0.45 : t.species === 'young' ? 0.35 : 0.3;
            litter += k * Math.exp(-d2 / (2 * 2.2 * 2.2));
          }
        }
      }
      const n = fbm2(x * 0.06, z * 0.06, 4);
      const moss = smoothstep(-0.25, 0.35, n + 0.42 - litter * 0.55);
      const berry = smoothstep(0.05, 0.45, fbm2(x * 0.09 + 40, z * 0.09 - 13, 3)) * moss;
      const hy = heightAt(x, z);
      const damp = smoothstep(0.2, -0.9, hy - fbm2(x * 0.02, z * 0.02, 2) * 3.0) * 0.6;
      const k = (j * size + i) * 3;
      field[k] = moss;
      field[k + 1] = berry;
      field[k + 2] = damp;
      data[(j * size + i) * 4] = moss * 255;
      data[(j * size + i) * 4 + 1] = berry * 255;
      data[(j * size + i) * 4 + 2] = damp * 255;
      data[(j * size + i) * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const ecoAt = (x, z) => {
    const i = Math.min(size - 1, Math.max(0, Math.floor(((x - x0) / w) * size)));
    const j = Math.min(size - 1, Math.max(0, Math.floor(((z - z0) / h) * size)));
    const k = (j * size + i) * 3;
    return { moss: field[k], berry: field[k + 1], damp: field[k + 2] };
  };
  return { texture: tex, rect, ecoAt };
}
