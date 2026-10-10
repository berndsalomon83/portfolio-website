import * as THREE from 'three';
import { heightAt } from './world/terrain.js';
import { SAPLING } from './world/layout.js';
import { FLY, PATCH, SPOTS, toPatch, heroHeightAt } from './world/flyover/config.js';

// Scroll → story position s ∈ [0, 4] (one unit per chapter) → camera pose and the "look" of the frame.
// Between Experience (3) and Contact (4) the page has an empty interlude: the camera tips straight down,
// glides low over the forest floor (js/world/flyover/) and rises again to find the seedling.

const deg = THREE.MathUtils.degToRad;
const rad2deg = THREE.MathUtils.radToDeg;

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
  { exposure: 0.36, bloom: 0.11, bloomThreshold: 1.4, vol: 0.85, volDensity: 0.011, dof: 0.0, focus: 25, focusRange: 15, vignette: 0.45, saturation: 1.04, fog: 0.0065, beam: 0.0, rays: 0.78, height: 24, ao: 0.6 },
  { exposure: 0.5, bloom: 0.1, bloomThreshold: 1.4, vol: 0.95, volDensity: 0.013, dof: 0.0, focus: 15, focusRange: 10, vignette: 0.5, saturation: 1.05, fog: 0.0075, beam: 0.0, rays: 0.55, height: 14, ao: 0.8 },
  { exposure: 0.66, bloom: 0.1, bloomThreshold: 1.3, vol: 1.0, volDensity: 0.016, dof: 0.0, focus: 8, focusRange: 6, vignette: 0.52, saturation: 1.08, fog: 0.0095, beam: 0.3, rays: 0.35, height: 6, ao: 1.0 },
  { exposure: 0.78, bloom: 0.11, bloomThreshold: 1.25, vol: 1.0, volDensity: 0.018, dof: 0.3, focus: 6, focusRange: 4, vignette: 0.55, saturation: 1.1, fog: 0.0105, beam: 0.6, rays: 0.15, height: 1.8, ao: 1.0 },
  { exposure: 0.84, bloom: 0.13, bloomThreshold: 1.2, vol: 0.9, volDensity: 0.015, dof: 0.8, focus: 1.9, focusRange: 0.32, vignette: 0.6, saturation: 1.1, fog: 0.009, beam: 0.85, rays: 0.0, height: 0.3, ao: 1.0 },
];

// The flyover choreography for s ∈ [3, 4] (tuning knobs).
export const FLYCAM = {
  fallback: [3.35, 3.75], // glide range in s when the page layout can't tell
  edge: [0.1, 0.98], // glide starts with the last 10 % of the Experience cards on screen, ends as the Contact text arrives
  tipStart: 0.05, // tilt in: the nose starts to go down after this fraction of the way, gently, while the cards are read …
  tipInto: 0.2, // … and settles straight down this fraction into the glide, so it never swings round in a few wheel notches
  ends: 0.4, // glide: the speed dips this much at either end (0 = constant, 1 = stop) …
  endLen: 0.2, // … over this fraction of the glide
  lift: 0.06, // rise: the camera climbs this much (m) before it settles at the seedling
  reveal: 2, // rise: how early the gaze lifts (0 = evenly … 3 = early)
  rack: [0.2, 0.8], // rise: the focus moves from the floor onto the seedling over this part of the rise
  growFrom: 0.55, // rise: the seedling starts to grow after this fraction, just as it enters the frame (measured on 16:9)
  drift: 0.012, // drone drift while looking down (m)
  heroFocus: 0.16, // glide: the focus rises this far (m) onto the crozier heads while passing over the young fern …
  heroReach: 0.2, // … within about this distance of its crown (m)
  parallax: 0.03, // pointer → sideways slide while looking down (m)
};

// The look while the camera points straight down, blended in by look.fly.
const FLY_LOOK = { exposureGain: 1.0, dof: 0.45, focusRange: 0.28, ao: 1.15, aoRadius: 0.12 };

const ease = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const sstep = (a, b, x) => ease(clamp01((x - a) / (b - a)));

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function sampleCam(s, key) {
  const n = CAM.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
  const t = THREE.MathUtils.clamp(s - i, 0, 1);
  const k = (j) => CAM[Math.min(n - 1, Math.max(0, j))][key];
  return catmull(k(i - 1), k(i), k(i + 1), k(i + 2), t);
}

export function sampleLook(s) {
  const n = LOOK.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
  const t = ease(THREE.MathUtils.clamp(s - i, 0, 1));
  const a = LOOK[i];
  const b = LOOK[i + 1];
  const out = {};
  for (const key of Object.keys(a)) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

export function groundAt(x, z) {
  // averaged so the camera glides instead of tracing every hummock
  let h = 0;
  const r = 0.7;
  h += heightAt(x, z) * 2;
  h += heightAt(x + r, z) + heightAt(x - r, z) + heightAt(x, z + r) + heightAt(x, z - r);
  return h / 6;
}

// ── the flyover path ────────────────────────────────────────
const GLIDE = new THREE.Vector2().subVectors(FLY.end, FLY.start); // ≈ 2 m along the walk
const GLIDE_YAW = rad2deg(Math.atan2(GLIDE.x, -GLIDE.y)); // heading of the glide: screen-up = direction of travel
// slopes (per unit s) of today's spline where the flyover joins it: leaving s = 3 and arriving at s = 4
const slope3 = (key) => 0.5 * (CAM[4][key] - CAM[2][key]);
const slope4 = (key) => 0.5 * (CAM[4][key] - CAM[3][key]);

// p0 → p1 over a segment d long (in s), leaving p0 with slope m0 and arriving with slope m1 (per unit s).
// W is the 0 → 1 blend; any W that is flat at both ends keeps the joins C1. W = ease(t) is a cubic Hermite.
function shaped(p0, m0, p1, m1, t, d, W) {
  const u = 1 - t;
  return (1 - W) * p0 + W * p1 + d * (m0 * t * u * u - m1 * t * t * u);
}

// Glide progress 0 → 1: a calm cruise, a little slower where it settles in and where it lifts off.
function glideProgress(t) {
  const a = FLYCAM.ends;
  const q = FLYCAM.endLen;
  // ∫₀ˣ (1 − smoothstep(0, q, τ)) dτ
  const F = (x) => (x >= q ? q / 2 : x - q * ((x / q) ** 3 - (x / q) ** 4 / 2));
  return (t - a * F(t) - a * (q / 2 - F(1 - t))) / (1 - a * q);
}
// The nose going down: one gentle curve over the tilt in and the start of the glide (−90° from there on).
function tipPitch(s, sA, sB) {
  const d = sA - 3 + FLYCAM.tipInto * (sB - sA);
  const t = clamp01((s - 3) / d);
  return shaped(CAM[3].pitch, slope3('pitch'), -90, 0, t, d, sstep(FLYCAM.tipStart, 1, t));
}
const glideEndRate = () => (1 - FLYCAM.ends) / (1 - FLYCAM.ends * FLYCAM.endLen); // d(progress)/dt at either end

// The gaze lifts early in the rise, so the seedling is in view while it grows (flat at both ends).
const revealCurve = (t) => ease(t) + FLYCAM.reveal * t * t * (1 - t) * (1 - t);

// 0 … 1, how much the camera looks straight down (1 during the glide).
const flyOf = (pitch) => sstep(20, 88, -pitch);

// Today's pose: the chapter spline plus the sapling framing at the end. Used for s < 3 and s ≥ 4.
function legacyPose(s, aspect, saplingY, out) {
  const x = sampleCam(s, 'x');
  const z = sampleCam(s, 'z');
  const eye = sampleCam(s, 'y');
  let yaw = sampleCam(s, 'yaw');
  let pitch = sampleCam(s, 'pitch');
  const fov = sampleCam(s, 'fov');
  const y = groundAt(x, z) + eye;
  const w = ease(THREE.MathUtils.clamp(s - 3, 0, 1));
  if (w > 0) {
    const f = frameSapling(x, y, z, aspect, saplingY);
    yaw += (f.yaw - yaw) * w;
    pitch += (f.pitch - pitch) * w;
  }
  return Object.assign(out, { x, y, z, eye, yaw, pitch, fov, fly: 0 });
}

// final approach: frame the sapling in the lower third whatever the terrain does
function frameSapling(x, y, z, aspect, saplingY) {
  const dx = SAPLING.x - x;
  const dz = SAPLING.y - z;
  // wide screens: text on the left, seedling on the right third. Portrait: seedling low, text above.
  const wide = aspect > 1.15;
  const dy = saplingY + (wide ? 0.38 : 0.66) - y;
  return {
    yaw: rad2deg(Math.atan2(dx, -dz)) - (wide ? 6.5 : 0),
    pitch: rad2deg(Math.atan2(dy, Math.hypot(dx, dz))),
  };
}

/** Glide range [sA, sB] made safe: inside (3, 4) with room for the tilt in and the rise. */
export function sanitizeFlyRange(sA, sB) {
  if (!Number.isFinite(sA) || !Number.isFinite(sB) || sB <= sA) return [...FLYCAM.fallback];
  const a = Math.min(3.75, Math.max(3.12, sA));
  const b = Math.min(3.88, Math.max(a + 0.1, sB));
  return [a, b];
}

/** Scroll offset (px) → story position, piecewise linear between the chapter anchors. */
export function scrollToS(y, anchors) {
  const a = anchors;
  if (y <= a[0]) return 0;
  for (let i = 0; i < a.length - 1; i++) {
    if (y < a[i + 1]) return i + (y - a[i]) / Math.max(1, a[i + 1] - a[i]);
  }
  return a.length - 1;
}

/**
 * Base camera pose at story position s (no breathing, drift or pointer parallax).
 * Returns { x, y, z, eye (above the smoothed ground), yaw, pitch, fov (degrees), fly (0 … 1) }.
 * s ∈ [0, 3] and s ≥ 4 are today's walk; s ∈ (3, 4) is the flyover: tilt in → glide → rise.
 */
export function storyPose(s, { aspect = 16 / 9, flyRange = FLYCAM.fallback, saplingY = heightAt(SAPLING.x, SAPLING.y) } = {}, out = {}) {
  if (!(s > 3 && s < 4)) return legacyPose(s, aspect, saplingY, out);
  const [sA, sB] = flyRange;
  const rate = glideEndRate() / (sB - sA); // glide speed at either end, as a multiple of GLIDE per unit s
  let x, z, eye, yaw, pitch, fov;
  if (s <= sA) {
    // tilt in: leave today's spline with its own velocity, descend and tip the nose straight down
    const d = sA - 3;
    const t = (s - 3) / d;
    const W = ease(t);
    x = shaped(CAM[3].x, slope3('x'), FLY.start.x, GLIDE.x * rate, t, d, W);
    z = shaped(CAM[3].z, slope3('z'), FLY.start.y, GLIDE.y * rate, t, d, W);
    eye = shaped(CAM[3].y, slope3('y'), FLY.altitude, 0, t, d, sstep(FLYCAM.tipStart * 0.5, 1, t));
    yaw = shaped(CAM[3].yaw, slope3('yaw'), GLIDE_YAW, 0, t, d, sstep(0, 0.85, t)); // settled before vertical
    pitch = tipPitch(s, sA, sB);
    fov = shaped(CAM[3].fov, slope3('fov'), FLY.fov, 0, t, d, W);
  } else if (s <= sB) {
    // the glide: straight down, heading along the walk, at a calm and nearly even pace
    const g = glideProgress((s - sA) / (sB - sA));
    x = FLY.start.x + GLIDE.x * g;
    z = FLY.start.y + GLIDE.y * g;
    eye = FLY.altitude;
    yaw = GLIDE_YAW;
    pitch = tipPitch(s, sA, sB);
    fov = FLY.fov;
  } else {
    // rise: lift the gaze, drift on toward the seedling and settle into today's final framing
    const d = 4 - sB;
    const t = (s - sB) / d;
    x = shaped(FLY.end.x, GLIDE.x * rate, CAM[4].x, slope4('x'), t, d, ease(t));
    z = shaped(FLY.end.y, GLIDE.y * rate, CAM[4].z, slope4('z'), t, d, ease(t));
    eye = shaped(FLY.altitude, 0, CAM[4].y, slope4('y'), t, d, sstep(0.25, 1, t)) + FLYCAM.lift * 16 * t * t * (1 - t) * (1 - t);
    fov = shaped(FLY.fov, 0, CAM[4].fov, slope4('fov'), t, d, sstep(0.1, 1, t));
    const f = frameSapling(x, groundAt(x, z) + eye, z, aspect, saplingY);
    yaw = GLIDE_YAW + (f.yaw - GLIDE_YAW) * sstep(0.3, 1, t); // turns once the view is no longer vertical
    pitch = -90 + (f.pitch + 90) * revealCurve(t);
  }
  return Object.assign(out, { x, y: groundAt(x, z) + eye, z, eye, yaw, pitch, fov, fly: flyOf(pitch) });
}

/**
 * The look of the frame at story position s for a base pose from storyPose().
 * camPos (the real camera position, with breathing) drives the focus pull onto the sapling, as it always has.
 */
export function storyLook(s, pose, { flyRange = FLYCAM.fallback, saplingY = heightAt(SAPLING.x, SAPLING.y), camPos = null } = {}) {
  const l = sampleLook(s);
  if (!(s > 3 && s < 4)) {
    // today's walk
    l.growth = ease(THREE.MathUtils.clamp((s - 3.15) / 0.8, 0, 1));
    if (camPos) {
      const d = Math.hypot(camPos.x - SAPLING.x, camPos.y - (saplingY + 0.3), camPos.z - SAPLING.y);
      const w = ease(THREE.MathUtils.clamp(s - 3, 0, 1));
      l.focus += (d - l.focus) * w;
    }
    l.fly = 0;
    l.aoRadius = 0.5;
    return l;
  }
  const [, sB] = flyRange;
  const f = pose.fly;
  l.fly = f;
  // looking down at the dark floor: a touch brighter, no shafts or rays, a shallow macro focus
  l.exposure *= 1 + FLY_LOOK.exposureGain * f;
  l.vol *= 1 - f; // 0 during the glide, which also skips the volumetric pass
  l.beam *= 1 - f;
  l.rays *= 1 - f;
  l.dof += (FLY_LOOK.dof - l.dof) * f;
  l.focusRange += (FLY_LOOK.focusRange - l.focusRange) * f;
  l.ao += (FLY_LOOK.ao - l.ao) * f;
  l.aoRadius = 0.5 + (FLY_LOOK.aoRadius - 0.5) * f;
  l.height += (pose.eye - l.height) * f;
  // focus on the ground the camera looks at while tipped down …
  const fg = sstep(18, 50, -pose.pitch);
  if (fg > 0) l.focus += (groundDistance(pose) - l.focus) * fg;
  // … and lifts onto the young fern's crozier heads while the camera passes over them
  const hero = SPOTS.fiddleheadsA;
  if (hero && fg > 0) {
    const { u, v } = toPatch(pose.x, pose.z);
    const r2 = ((u - hero.u) ** 2 + (v - hero.v) ** 2) / (FLYCAM.heroReach * FLYCAM.heroReach);
    l.focus -= FLYCAM.heroFocus * Math.exp(-r2) * fg;
  }
  // … then, after the glide, rack focus onto the sapling while the gaze lifts: the floor the rise rushes over
  // goes soft and the seedling sharpens before it starts to grow
  const t = clamp01((s - sB) / (4 - sB));
  if (camPos && t > 0) {
    const d = Math.hypot(camPos.x - SAPLING.x, camPos.y - (saplingY + 0.3), camPos.z - SAPLING.y);
    l.focus += (d - l.focus) * sstep(FLYCAM.rack[0], FLYCAM.rack[1], t);
  }
  // the seedling grows while the camera rises and finds it
  l.growth = sstep(FLYCAM.growFrom, 0.97, t);
  return l;
}

// Distance along the view axis to the forest floor (what the DOF needs).
function groundDistance(p) {
  const sp = Math.max(0.15, Math.sin(deg(-p.pitch)));
  const cp = Math.cos(deg(p.pitch));
  const hx = Math.sin(deg(p.yaw)) * cp;
  const hz = -Math.cos(deg(p.yaw)) * cp;
  let h = heroHeightAt(p.x, p.z);
  for (let i = 0; i < 3; i++) {
    const t = Math.max(0, p.y - h) / sp;
    h = heroHeightAt(p.x + hx * t, p.z + hz * t);
  }
  return Math.min(12, Math.max(0.2, (p.y - h) / sp));
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Heading and pitch (degrees, roll 0) → camera orientation. Same as lookAt with up = +Y, but fine straight down. */
export function orientCamera(quaternion, yaw, pitch) {
  _euler.set(deg(pitch), -deg(yaw), 0, 'YXZ');
  return quaternion.setFromEuler(_euler);
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
    this.pose = null;
    this.measure();
    addEventListener('resize', () => this.measure());
    // late layout shifts (web fonts, images) move the anchors and the interlude
    addEventListener('load', () => this.measure());
    document.fonts?.ready?.then(() => this.measure());
    addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
    this.s = this.target = this.readScroll();
  }

  measure() {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    this.anchors = this.sections.map((el, i) => (i === this.sections.length - 1 ? max : Math.min(max, el.offsetTop)));
    this.anchors[0] = 0;
    this.flyRange = this.measureFlyRange();
  }

  // The glide runs while the empty interlude fills the screen: from when the Experience cards have
  // (nearly) scrolled away until the Contact text is about to come up from below.
  measureFlyRange() {
    try {
      const el = document.querySelector('.interlude');
      const prev = el?.previousElementSibling;
      const next = el?.nextElementSibling;
      if (!el || !prev || !next || el.offsetHeight < 1 || this.anchors.length < 5) return sanitizeFlyRange(NaN, NaN);
      const rect = (e) => e.getBoundingClientRect();
      // content edges, in the same frame as the anchors (offsetTop)
      const cardsEnd = prev.offsetTop + (rect(prev.lastElementChild ?? prev).bottom - rect(prev).top);
      const textStart = next.offsetTop + (rect(next.firstElementChild ?? next).top - rect(next).top);
      const H = innerHeight;
      const [a, b] = FLYCAM.edge;
      return sanitizeFlyRange(scrollToS(cardsEnd - a * H, this.anchors), scrollToS(textStart - b * H, this.anchors));
    } catch {
      return sanitizeFlyRange(NaN, NaN);
    }
  }

  readScroll() {
    return scrollToS(scrollY, this.anchors);
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
    const p = (this.pose = storyPose(this.s, { aspect: camera.aspect, flyRange: this.flyRange, saplingY: this.saplingY }, this.pose ?? {}));
    let { x, y, z, yaw, pitch } = p;
    const f = p.fly;

    // breathing + pointer parallax. Looking straight down a turn of the head would roll the frame, so it hushes.
    if (!this.reduced) {
      yaw += (Math.sin(time * 0.21) * 0.6 + this.mouseSmooth.x * 2.2) * (1 - f);
      pitch += (Math.sin(time * 0.17 + 1.3) * 0.4 - this.mouseSmooth.y * 1.4) * (1 - 0.85 * f);
      y += Math.sin(time * 0.6) * 0.008 * (1 - 0.5 * f);
      if (f > 0) {
        // a hovering drone: slow sway, and the pointer slides the view a few centimetres
        const k = FLYCAM.drift * f;
        const side = k * (Math.sin(time * 0.23 + 0.4) * 0.7 + Math.sin(time * 0.53 + 2.1) * 0.3) + FLYCAM.parallax * f * this.mouseSmooth.x;
        const ahead = k * 0.6 * Math.sin(time * 0.17 + 1.7) - FLYCAM.parallax * 0.7 * f * this.mouseSmooth.y;
        x += PATCH.v.x * side + PATCH.u.x * ahead;
        z += PATCH.v.y * side + PATCH.u.y * ahead;
        y += k * 0.4 * Math.sin(time * 0.29 + 0.9);
      }
    }

    camera.position.set(x, y, z);
    this.camPos = camera.position;
    camera.up.set(0, 1, 0);
    orientCamera(camera.quaternion, yaw, pitch);
    if (Math.abs(camera.fov - p.fov) > 1e-3) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
  }

  look() {
    const pose = this.pose ?? storyPose(this.s, { flyRange: this.flyRange, saplingY: this.saplingY });
    return storyLook(this.s, pose, { flyRange: this.flyRange, saplingY: this.saplingY, camPos: this.camPos });
  }
}
