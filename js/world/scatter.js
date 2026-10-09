import { PATH, SAPLING } from './layout.js';

// Spatial helpers for placing things on the forest floor.

export function trunkTest(trees, cell = 4) {
  const grid = new Map();
  for (const t of trees) {
    const k = `${Math.floor(t.x / cell)},${Math.floor(t.z / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }
  // true if (x,z) is within r (+ trunk radius) of any trunk
  return (x, z, r) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = grid.get(`${gx + a},${gz + b}`);
        if (!list) continue;
        for (const t of list) {
          const rr = r + 0.3 * t.scale;
          if ((t.x - x) ** 2 + (t.z - z) ** 2 < rr * rr) return true;
        }
      }
    }
    return false;
  };
}

// Points along the walk (denser where the camera lingers close to the ground).
const ANCHORS = (() => {
  const out = [];
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i];
    const [bx, bz] = PATH[i + 1];
    for (let k = 0; k < 10; k++) {
      const t = k / 10;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t, 0.5 + i * 0.4]);
    }
  }
  out.push([SAPLING.x, SAPLING.y, 4]);
  out.push([SAPLING.x, SAPLING.y - 3, 3]);
  return out;
})();
const ANCHOR_TOTAL = ANCHORS.reduce((s, a) => s + a[2], 0);

function pickAnchor(rng) {
  let r = rng.next() * ANCHOR_TOTAL;
  for (const a of ANCHORS) {
    r -= a[2];
    if (r <= 0) return a;
  }
  return ANCHORS[ANCHORS.length - 1];
}

// Gaussian scatter around the walk; accept(x, z) may reject or return a weight (0..1).
export function scatterNearPath(rng, count, sigma, accept, maxAttempts = count * 12) {
  const pts = [];
  let attempts = 0;
  while (pts.length < count && attempts < maxAttempts) {
    attempts++;
    const a = pickAnchor(rng);
    const x = a[0] + rng.gauss() * sigma;
    const z = a[1] + rng.gauss() * sigma;
    const w = accept(x, z);
    if (w === false || w <= 0) continue;
    if (w !== true && rng.next() > w) continue;
    pts.push([x, z]);
  }
  return pts;
}

// Uniform scatter in a disc.
export function scatterDisc(rng, count, cx, cz, radius, accept, maxAttempts = count * 10) {
  const pts = [];
  let attempts = 0;
  while (pts.length < count && attempts < maxAttempts) {
    attempts++;
    const r = radius * Math.sqrt(rng.next());
    const a = rng.next() * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const w = accept(x, z);
    if (w === false || w <= 0) continue;
    if (w !== true && rng.next() > w) continue;
    pts.push([x, z]);
  }
  return pts;
}

// Distance from a point to the camera's final line of sight (camera → sapling), to keep it clear.
const CAM_END = PATH[PATH.length - 1];
export function distToSightline(x, z) {
  const [ax, az] = CAM_END;
  const bx = SAPLING.x;
  const bz = SAPLING.y;
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
}

export function distToCameraEnd(x, z) {
  return Math.hypot(x - CAM_END[0], z - CAM_END[1]);
}
