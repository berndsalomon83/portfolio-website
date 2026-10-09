import * as THREE from 'three';
import { heightAt } from './world/terrain.js';
import { SAPLING } from './world/layout.js';

// Scroll → story position s ∈ [0, 4] (one unit per chapter) → camera pose and the "look" of the frame.

const deg = THREE.MathUtils.degToRad;

// Camera keyframes per chapter: position (eye height above the ground), heading and pitch in degrees.
const CAM = [
  { x: 0.0, z: 6.5, y: 1.7, yaw: 3, pitch: 52, fov: 62 }, // hero — looking up into the crowns
  { x: 0.2, z: 2.5, y: 1.7, yaw: 5, pitch: 25, fov: 58 }, // about — down the trunks
  { x: 0.5, z: -2.5, y: 1.65, yaw: -3, pitch: 4, fov: 55 }, // work — eye level, shafts of light
  { x: 0.9, z: -8.5, y: 1.2, yaw: 0, pitch: -7, fov: 52 }, // experience — crouching, undergrowth
  { x: 1.4, z: -16.0, y: 0.55, yaw: 5, pitch: -3, fov: 34 }, // contact — forest floor, the sapling
];

// Frame "look" per chapter.
const LOOK = [
  { exposure: 0.36, bloom: 0.11, bloomThreshold: 1.4, vol: 0.85, volDensity: 0.011, dof: 0.0, focus: 25, focusRange: 15, vignette: 0.45, saturation: 1.04, fog: 0.0065, beam: 0.0, rays: 0.78, height: 24 },
  { exposure: 0.5, bloom: 0.1, bloomThreshold: 1.4, vol: 0.95, volDensity: 0.013, dof: 0.0, focus: 15, focusRange: 10, vignette: 0.5, saturation: 1.05, fog: 0.0075, beam: 0.0, rays: 0.55, height: 14 },
  { exposure: 0.66, bloom: 0.1, bloomThreshold: 1.3, vol: 1.0, volDensity: 0.016, dof: 0.0, focus: 8, focusRange: 6, vignette: 0.52, saturation: 1.06, fog: 0.0095, beam: 0.3, rays: 0.35, height: 6 },
  { exposure: 0.78, bloom: 0.11, bloomThreshold: 1.25, vol: 1.0, volDensity: 0.018, dof: 0.3, focus: 6, focusRange: 4, vignette: 0.55, saturation: 1.07, fog: 0.0105, beam: 0.6, rays: 0.15, height: 1.8 },
  { exposure: 0.84, bloom: 0.13, bloomThreshold: 1.2, vol: 0.9, volDensity: 0.015, dof: 0.7, focus: 1.9, focusRange: 0.6, vignette: 0.6, saturation: 1.06, fog: 0.009, beam: 0.85, rays: 0.0, height: 0.3 },
];

const ease = (t) => t * t * (3 - 2 * t);

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sampleCam(s, key) {
  const n = CAM.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
  const t = THREE.MathUtils.clamp(s - i, 0, 1);
  const k = (j) => CAM[Math.min(n - 1, Math.max(0, j))][key];
  return catmull(k(i - 1), k(i), k(i + 1), k(i + 2), t);
}

function sampleLook(s) {
  const n = LOOK.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
  const t = ease(THREE.MathUtils.clamp(s - i, 0, 1));
  const a = LOOK[i];
  const b = LOOK[i + 1];
  const out = {};
  for (const key of Object.keys(a)) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

function groundAt(x, z) {
  // averaged so the camera glides instead of tracing every hummock
  let h = 0;
  const r = 0.7;
  h += heightAt(x, z) * 2;
  h += heightAt(x + r, z) + heightAt(x - r, z) + heightAt(x, z + r) + heightAt(x, z - r);
  return h / 6;
}

export class Story {
  constructor(sections) {
    this.sections = sections;
    this.s = 0;
    this.target = 0;
    this.mouse = new THREE.Vector2();
    this.mouseSmooth = new THREE.Vector2();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.saplingY = heightAt(SAPLING.x, SAPLING.y);
    this.measure();
    addEventListener('resize', () => this.measure());
    addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
    this.s = this.target = this.readScroll();
  }

  measure() {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    this.anchors = this.sections.map((el, i) => (i === this.sections.length - 1 ? max : Math.min(max, el.offsetTop)));
    this.anchors[0] = 0;
  }

  readScroll() {
    const y = scrollY;
    const a = this.anchors;
    if (y <= a[0]) return 0;
    for (let i = 0; i < a.length - 1; i++) {
      if (y < a[i + 1]) return i + (y - a[i]) / Math.max(1, a[i + 1] - a[i]);
    }
    return a.length - 1;
  }

  update(dt) {
    this.target = this.force ?? this.readScroll();
    const k = 1 - Math.exp(-dt * (this.reduced ? 12 : 3.2));
    this.s += (this.target - this.s) * k;
    if (Math.abs(this.target - this.s) < 1e-4) this.s = this.target;
    this.mouseSmooth.lerp(this.mouse, 1 - Math.exp(-dt * 2.5));
  }

  get chapter() {
    return Math.round(this.s);
  }

  applyCamera(camera, time) {
    const s = this.s;
    const x = sampleCam(s, 'x');
    const z = sampleCam(s, 'z');
    const eye = sampleCam(s, 'y');
    let yaw = sampleCam(s, 'yaw');
    let pitch = sampleCam(s, 'pitch');
    const fov = sampleCam(s, 'fov');
    const y = groundAt(x, z) + eye;

    // final approach: frame the sapling in the lower third whatever the terrain does
    const w = ease(THREE.MathUtils.clamp(s - 3, 0, 1));
    if (w > 0) {
      const dx = SAPLING.x - x;
      const dz = SAPLING.y - z;
      // wide screens: text on the left, seedling on the right third. Portrait: seedling low, text above.
      const wide = camera.aspect > 1.15;
      const dy = this.saplingY + (wide ? 0.38 : 0.66) - y;
      const yawS = THREE.MathUtils.radToDeg(Math.atan2(dx, -dz)) - (wide ? 6.5 : 0);
      const pitchS = THREE.MathUtils.radToDeg(Math.atan2(dy, Math.hypot(dx, dz)));
      yaw += (yawS - yaw) * w;
      pitch += (pitchS - pitch) * w;
    }

    // breathing + pointer parallax
    if (!this.reduced) {
      yaw += Math.sin(time * 0.21) * 0.6 + this.mouseSmooth.x * 2.2;
      pitch += Math.sin(time * 0.17 + 1.3) * 0.4 - this.mouseSmooth.y * 1.4;
    }
    const bob = this.reduced ? 0 : Math.sin(time * 0.6) * 0.008;

    camera.position.set(x, y + bob, z);
    this.camPos = camera.position;
    const cy = Math.cos(deg(pitch));
    const dir = new THREE.Vector3(Math.sin(deg(yaw)) * cy, Math.sin(deg(pitch)), -Math.cos(deg(yaw)) * cy);
    camera.up.set(0, 1, 0);
    camera.lookAt(camera.position.clone().add(dir));
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  look() {
    const l = sampleLook(this.s);
    l.growth = ease(THREE.MathUtils.clamp((this.s - 3.15) / 0.8, 0, 1));
    // focus pulls onto the sapling during the final approach
    if (this.camPos) {
      const d = Math.hypot(this.camPos.x - SAPLING.x, this.camPos.y - (this.saplingY + 0.3), this.camPos.z - SAPLING.y);
      const w = ease(THREE.MathUtils.clamp(this.s - 3, 0, 1));
      l.focus += (d - l.focus) * w;
    }
    return l;
  }
}
