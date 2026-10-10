import * as THREE from 'three';
import { heightAt } from '../terrain.js';
import { SUN_DIR } from '../layout.js';
import { heroHeightAt } from './config.js';

// Close-up sunlight for the flyover.
// world.js keeps one orthographic shadow map centred 10–16 m ahead of the camera, ±quality.shadowExtent wide
// (±34 m on medium, ~3 cm per texel): right for the walk, far too coarse 0.85 m above the moss, and its
// "ahead" is undefined when the camera looks straight down. While the camera tips down (w = look.fly) the
// box shrinks onto the floor the camera actually sees, down to about ±1.8 m (~1.8 mm per texel on medium),
// still snapped to whole texels so nothing shimmers while gliding. Near/far stay as world.js sets them
// (a 280 m column along the sun), so crowns 30 m up still throw their dapples into the small box.
// The depth and normal biases scale with the texel, or small things would lose their shadows.

const TIGHT = { ultra: 1.6, high: 1.7, medium: 1.8, low: 2.0 }; // half extent while gliding (m)
const MARGIN = 0.45; // room for receivers above the floor (fern tops, stems) around the seen ground (m)
const BACK = 140; // sun distance behind the box centre, as in world.js

const saved = new WeakMap(); // sun → the walk's settings, restored exactly at w = 0

const _P = new THREE.Vector3();
const _Q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _base = new THREE.Vector3();
const _seen = new THREE.Vector3();
const _c = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Tighten the sun's shadow map onto the ground under the camera. Call every frame right after world.js has
 * placed the shadow camera; w = look.fly (0 … 1). At w = 0 it hands everything back exactly as world.js
 * set it (extent, biases, position) and otherwise does nothing. Returns the half extent in use (m).
 */
export function flyoverShadow(sun, camera, quality, w = 0) {
  const shadow = sun.shadow;
  const cam = shadow.camera;
  let st = saved.get(sun);
  if (!st) {
    st = { extent: quality.shadowExtent, bias: shadow.bias, normalBias: shadow.normalBias, active: false };
    saved.set(sun, st);
  }
  w = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;

  if (w <= 0) {
    if (st.active) {
      // hand back: the walk's box, its biases and world.js's own placement snapped to its own texels
      st.active = false;
      setExtent(cam, st.extent);
      shadow.bias = st.bias;
      shadow.normalBias = st.normalBias;
      walkCentre(camera, quality, _c);
      place(sun, _c);
    }
    return st.extent;
  }
  st.active = true;

  camera.updateMatrixWorld();
  camera.getWorldPosition(_P);
  camera.getWorldQuaternion(_Q);
  _dir.set(0, 0, -1).applyQuaternion(_Q);
  _upv.set(0, 1, 0).applyQuaternion(_Q);
  _rot.lookAt(SUN_DIR, _origin, _up); // light space: x, y across the sun's rays, z along them
  _inv.copy(_rot).invert();

  // where the view axis meets the floor
  const full = st.extent;
  const reach = 2.5 * full; // view rays count this far at most (m), beyond the far side of the walk's box
  floorHit(_P, _dir, reach, _foot);

  // the walk's centre, worked out so it stays defined straight down: tipped down, the camera's up points ahead
  const s = _dir.y >= 0 ? 1 : -1;
  _base.set(_dir.x - s * _upv.x, 0, _dir.z - s * _upv.z);
  if (_base.lengthSq() < 1e-8) _base.set(0, 0, -1);
  _base.normalize().multiplyScalar(quality.tier === 'low' ? 10 : 16).add(_P);
  _base.y = heightAt(_base.x, _base.z);
  _pt.copy(_base).applyMatrix4(_inv);
  const bx = _pt.x;
  const by = _pt.y;

  // the floor the camera sees (where the frustum corner rays meet the terrain), in light space,
  // clipped to the walk's box: whatever the walk's box shades stays shaded while the box shrinks
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / (camera.zoom || 1);
  const tanH = tanV * camera.aspect;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [cx, cy] of CORNERS) {
    _ray.set(cx * tanH, cy * tanV, -1).normalize().applyQuaternion(_Q);
    _pt.copy(_P).addScaledVector(_ray, rayFloor(_P, _ray, reach)).applyMatrix4(_inv);
    x0 = Math.min(x0, _pt.x);
    x1 = Math.max(x1, _pt.x);
    y0 = Math.min(y0, _pt.y);
    y1 = Math.max(y1, _pt.y);
  }
  _pt.copy(_foot).applyMatrix4(_inv);
  const fz = _pt.z;
  x0 = Math.min(Math.max(x0, bx - full), _pt.x);
  x1 = Math.max(Math.min(x1, bx + full), _pt.x);
  y0 = Math.min(Math.max(y0, by - full), _pt.y);
  y1 = Math.max(Math.min(y1, by + full), _pt.y);
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const half = Math.max(x1 - x0, y1 - y0) * 0.5 + MARGIN;
  const tight = TIGHT[quality.tier] ?? TIGHT.medium;
  const need = Math.min(full, Math.max(tight, half));
  _seen.set(mx, my, fz).applyMatrix4(_rot);

  // blend: the box shrinks smoothly (in log scale) and slides from the walk's centre onto the seen floor
  let extent = Math.exp(Math.log(full) + (Math.log(need) - Math.log(full)) * w);
  _c.copy(_base).lerp(_seen, w);
  // while it slides, keep the seen floor inside
  _pt.copy(_c).applyMatrix4(_inv);
  const off = Math.max(Math.abs(_pt.x - mx), Math.abs(_pt.y - my));
  extent = Math.max(extent, Math.min(full, off + half));

  setExtent(cam, extent);
  const k = extent / full;
  shadow.normalBias = st.normalBias * k; // about one texel, as on the walk
  shadow.bias = st.bias * Math.max(k, 0.06);
  place(sun, _c);
  return extent;
}

function setExtent(cam, e) {
  if (cam.right === e && cam.top === e && cam.left === -e && cam.bottom === -e) return;
  cam.left = -e;
  cam.right = e;
  cam.top = e;
  cam.bottom = -e;
  cam.updateProjectionMatrix();
}

// First floor hit along a ray (falls back to the floor below a far point when it misses).
function floorHit(P, d, reach, out) {
  let h = heroHeightAt(P.x, P.z);
  let t = reach;
  if (d.y < -1e-3) {
    for (let i = 0; i < 4; i++) {
      t = Math.min(reach, Math.max(0, P.y - h) / -d.y);
      h = heroHeightAt(P.x + d.x * t, P.z + d.z * t);
    }
  }
  out.copy(P).addScaledVector(d, t);
  out.y = h;
  return out;
}

// Distance along a view ray to the terrain, up to `reach`. Marches over the real terrain, which falls away
// downhill (a flat plane would put the far floor much too close), then bisects so it varies smoothly.
function rayFloor(P, d, reach) {
  if (d.y >= -1e-4) return reach;
  const gap = (t) => P.y + d.y * t - heightAt(P.x + d.x * t, P.z + d.z * t);
  let t0 = 0;
  let t = 0;
  for (let i = 0; i < 48; i++) {
    const g = gap(t);
    if (g <= 0) {
      for (let k = 0; k < 7; k++) {
        const m = (t0 + t) * 0.5;
        if (gap(m) > 0) t0 = m;
        else t = m;
      }
      return Math.min(reach, t);
    }
    if (t >= reach) return reach;
    t0 = t;
    t = Math.min(reach, t + Math.max(0.1, (0.6 * g) / -d.y));
  }
  return reach; // no hit found: assume far
}

// world.js's own centre (updateShadowFrustum), for the exact hand-back at w = 0.
function walkCentre(camera, quality, out) {
  camera.getWorldDirection(_dir);
  _dir.y = 0;
  if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
  _dir.normalize();
  out.copy(camera.position).addScaledVector(_dir, quality.tier === 'low' ? 10 : 16);
  out.y = heightAt(out.x, out.z);
  return out;
}

// Snap the centre to whole shadow texels (across the sun's rays) and put sun and target there.
function place(sun, c) {
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
  _rot.lookAt(SUN_DIR, _origin, _up);
  _inv.copy(_rot).invert();
  c.applyMatrix4(_inv);
  c.x = Math.round(c.x / texel) * texel;
  c.y = Math.round(c.y / texel) * texel;
  c.applyMatrix4(_rot);
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(SUN_DIR, BACK);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}
