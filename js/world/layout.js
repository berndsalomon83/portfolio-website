import * as THREE from 'three';

// The shape of the walk: where the sun stands, where the camera travels and where the sapling grows.

const deg = THREE.MathUtils.degToRad;

export const SUN_ELEVATION = 41; // degrees above the horizon — a high-summer Swedish morning
export const SUN_AZIMUTH = 14; // degrees, turning from straight ahead (-Z) toward +X

export const SUN_DIR = new THREE.Vector3(
  Math.sin(deg(SUN_AZIMUTH)) * Math.cos(deg(SUN_ELEVATION)),
  Math.sin(deg(SUN_ELEVATION)),
  -Math.cos(deg(SUN_AZIMUTH)) * Math.cos(deg(SUN_ELEVATION)),
).normalize();

export const SUN_COLOR = new THREE.Color(1.0, 0.86, 0.68);

// Camera footprint on the ground (x, z). Camera keyframes in story.js follow this line.
export const PATH = [
  [0.0, 6.5],
  [0.2, 2.5],
  [0.5, -2.5],
  [0.9, -8.5],
  [1.4, -16.0],
];

// The young oak that grows at the end of the walk.
export const SAPLING = new THREE.Vector2(1.55, -17.5);

// Where the ground mesh is densest (close-up of the forest floor).
export const GROUND_FOCUS = new THREE.Vector2(1.4, -15.0);

export const FOREST_RADIUS = 78;

export function distToPath(x, z) {
  let best = Infinity;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [ax, az] = PATH[i];
    const [bx, bz] = PATH[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    best = Math.min(best, Math.hypot(ex, ez));
  }
  // the end of the walk continues a little toward the sapling
  const ex = x - SAPLING.x;
  const ez = z - SAPLING.y;
  return Math.min(best, Math.hypot(ex, ez) + 1.0);
}
