import * as THREE from 'three';
import { RNG } from '../lib/random.js';
import { SUN_DIR, SUN_COLOR, SAPLING, FOREST_RADIUS } from './layout.js';
import { heightAt } from './terrain.js';
import { HASH_GLSL } from '../gl/noise.glsl.js';

// Small things that sell the morning: dew drops, a spider web, sunlit dust, and the misty forest beyond.

export const sunHDR = new THREE.Vector3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(3.4);

// Shared shadow lookup so tiny things only sparkle where the sun really reaches.
export const shadowUniforms = {
  tShadow: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uHasShadow: { value: 0 },
};

const SHADOW_GLSL = /* glsl */ `
#include <packing>
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
float sunVisibility(vec3 wp) {
  if (uHasShadow < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 0.5;
  float d = unpackRGBAToDepth(textureLod(tShadow, sc.xy, 0.0));
  return step(sc.z - 0.002, d);
}`;

const DROP_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uGround;
vec3 dropEnv(vec3 d) {
  vec3 c = mix(uGround, uSky, smoothstep(-0.25, 0.55, d.y));
  return c + uSunColor * pow(max(dot(d, uSunDir), 0.0), 250.0) * 0.6;
}
// N, V in world space (V: toward the eye). vis: sun visibility.
vec3 shadeDrop(vec3 N, vec3 V, float vis) {
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 Np = N - V * ndv;
  vec3 exitDir = normalize(-V - Np * 1.7);
  vec3 refr = dropEnv(exitDir) * vec3(0.86, 0.95, 0.93);
  refr += uSunColor * vis * pow(max(dot(exitDir, uSunDir), 0.0), 40.0) * 3.0;
  refr *= mix(1.0, 0.18, pow(1.0 - ndv, 2.5));
  vec3 refl = dropEnv(R);
  vec3 col = mix(refr, refl, F);
  col += uSunColor * vis * pow(max(dot(R, uSunDir), 0.0), 1400.0) * 90.0;
  return col;
}`;

function dropUniforms() {
  return {
    uSunDir: { value: SUN_DIR },
    uSunColor: { value: sunHDR },
    uSky: { value: new THREE.Vector3(0.55, 0.62, 0.7) },
    uGround: { value: new THREE.Vector3(0.03, 0.045, 0.02) },
  };
}

// Real sphere drops (on the sapling's leaves).
export function dewSphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...dropUniforms(), uVis: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vWP;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uVis;
      varying vec3 vN;
      varying vec3 vWP;
      ${DROP_GLSL}
      void main() {
        gl_FragColor = vec4(shadeDrop(normalize(vN), normalize(cameraPosition - vWP), uVis), 1.0);
      }`,
  });
}

// Thousands of impostor drops on moss and grass: camera-facing quads shaded as spheres,
// never smaller than ~1.4 px so they glitter instead of aliasing away.
export function dewField(points, { minPx = 1.4 } = {}) {
  const n = points.length;
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  const off = new Float32Array(n * 4);
  points.forEach((p, i) => {
    off[i * 4] = p[0];
    off[i * 4 + 1] = p[1];
    off[i * 4 + 2] = p[2];
    off[i * 4 + 3] = p[3];
  });
  geo.setAttribute('aDrop', new THREE.InstancedBufferAttribute(off, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...dropUniforms(),
      ...shadowUniforms,
      uViewport: { value: new THREE.Vector2(1, 1) },
      uMinPx: { value: minPx },
      uTime: { value: 0 },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      attribute vec4 aDrop;
      uniform vec2 uViewport;
      uniform float uMinPx;
      varying vec2 vUv;
      varying float vVis;
      varying float vEnergy;
      varying vec3 vWP;
      void main() {
        vec3 wp = aDrop.xyz;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float r = aDrop.w;
        float px = r * 2.0 * projectionMatrix[1][1] / max(-mv.z, 1e-3) * uViewport.y * 0.5;
        float grow = max(1.0, uMinPx / max(px, 1e-4));
        vEnergy = 1.0 / (grow * grow);
        mv.xy += position.xy * r * 2.0 * grow;
        vUv = uv * 2.0 - 1.0;
        vVis = sunVisibility(wp);
        vWP = wp;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying vec2 vUv;
      varying float vVis;
      varying float vEnergy;
      varying vec3 vWP;
      ${DROP_GLSL}
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        vec3 nV = vec3(vUv, sqrt(1.0 - r2));
        // view space → world space
        vec3 N = normalize((vec4(nV, 0.0) * viewMatrix).xyz);
        vec3 V = normalize(cameraPosition - vWP);
        vec3 col = shadeDrop(N, V, vVis);
        gl_FragColor = vec4(col * mix(1.0, vEnergy, 0.6) * uStrength, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'dew';
  return mesh;
}

// An orb web strung between a fern and a twig, beaded with dew; threads glint where they catch the sun.
export function spiderWeb(center, normal, radius, rng) {
  const n = normal.clone().normalize();
  const u = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(u, n).normalize();
  const P = (r, a) => center.clone().addScaledVector(u, Math.cos(a) * r * 1.08).addScaledVector(v, Math.sin(a) * r);
  const pos = [];
  const tan = [];
  const seg = (a, b) => {
    const t = b.clone().sub(a).normalize();
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    tan.push(t.x, t.y, t.z, t.x, t.y, t.z);
  };
  const spokes = 26;
  const angles = [];
  for (let i = 0; i < spokes; i++) angles.push((i / spokes) * Math.PI * 2 + rng.float(-0.05, 0.05));
  const frameR = angles.map(() => radius * rng.float(0.92, 1.08));
  for (let i = 0; i < spokes; i++) {
    seg(P(radius * 0.04, angles[i]), P(frameR[i], angles[i]));
    seg(P(frameR[i], angles[i]), P(frameR[(i + 1) % spokes], angles[(i + 1) % spokes]));
  }
  // anchor lines
  for (const a of [0.4, 1.9, 3.3, 4.9]) seg(P(radius, a), P(radius * rng.float(1.8, 2.6), a + rng.float(-0.1, 0.1)));
  const beads = [];
  let r = radius * 0.12;
  const turns = 30;
  for (let t = 0; t < turns; t++) {
    for (let i = 0; i < spokes; i++) {
      const a0 = angles[i];
      const a1 = angles[(i + 1) % spokes] + (i === spokes - 1 ? Math.PI * 2 : 0);
      const r0 = r;
      r += (radius * 0.84) / (turns * spokes);
      const p0 = P(Math.min(r0, frameR[i] * 0.95), a0);
      const p1 = P(Math.min(r, frameR[(i + 1) % spokes] * 0.95), a1);
      // slight catenary sag between spokes
      const mid = p0.clone().lerp(p1, 0.5).addScaledVector(new THREE.Vector3(0, -1, 0), 0.0012);
      seg(p0, mid);
      seg(mid, p1);
      const L = p0.distanceTo(p1);
      const nb = Math.floor(L / 0.0045);
      for (let k = 1; k < nb; k++) {
        if (rng.chance(0.55)) {
          const q = k / nb;
          const p = q < 0.5 ? p0.clone().lerp(mid, q * 2) : mid.clone().lerp(p1, q * 2 - 1);
          beads.push([p.x, p.y, p.z, rng.float(0.0005, 0.0012)]);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aTangent', new THREE.Float32BufferAttribute(tan, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: SUN_DIR }, uSunColor: { value: sunHDR }, uStrength: { value: 1 }, ...shadowUniforms },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      attribute vec3 aTangent;
      uniform vec3 uSunDir;
      varying float vGlint;
      varying float vHue;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 V = normalize(cameraPosition - wp.xyz);
        vec3 T = normalize(aTangent);
        // a thin cylinder reflects light into a cone around the thread
        float c = dot(T, uSunDir) + dot(T, V);
        vGlint = pow(max(1.0 - abs(c), 0.0), 18.0) * sunVisibility(wp.xyz);
        float fwd = pow(max(dot(-V, uSunDir), 0.0), 3.0);
        vGlint += fwd * 0.08;
        vHue = dot(T, V) * 3.0 + dot(wp.xyz, vec3(9.0, 7.0, 5.0));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor;
      uniform float uStrength;
      varying float vGlint;
      varying float vHue;
      void main() {
        vec3 irid = 0.6 + 0.4 * cos(6.2831 * (vHue + vec3(0.0, 0.33, 0.67)));
        gl_FragColor = vec4(uSunColor * irid * vGlint * 0.6 * uStrength, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.name = 'web';
  return { lines, beads };
}

// Sunlit dust, pollen and the odd insect drifting through the beams.
export function dustMotes(count) {
  const rng = new RNG(99);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.float(-1, 1);
    pos[i * 3 + 1] = rng.float(-1, 1);
    pos[i * 3 + 2] = rng.float(-1, 1);
    seed[i] = rng.next();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...shadowUniforms,
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(14, 7, 14) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: sunHDR },
      uPx: { value: 800 },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uCam;
      uniform vec3 uBox;
      uniform vec3 uSunDir;
      uniform float uPx;
      varying float vI;
      varying float vBokeh;
      void main() {
        vec3 drift = vec3(sin(uTime * 0.11 + aSeed * 40.0) * 0.4 + 0.15, sin(uTime * 0.07 + aSeed * 13.0) * 0.25 + 0.05, cos(uTime * 0.09 + aSeed * 29.0) * 0.4) * uTime * 0.12;
        vec3 wobble = vec3(sin(uTime * 1.3 + aSeed * 90.0), sin(uTime * 1.1 + aSeed * 60.0), cos(uTime * 1.7 + aSeed * 70.0)) * 0.05;
        vec3 p = position * uBox + drift + wobble;
        vec3 rel = mod(p - uCam + uBox, uBox * 2.0) - uBox;
        vec3 wp = uCam + rel;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float dist = -mv.z;
        vec3 V = normalize(wp - cameraPosition);
        float cosT = dot(V, uSunDir);
        float g = 0.75;
        float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
        float vis = sunVisibility(wp);
        float size = mix(0.0025, 0.007, fract(aSeed * 7.31));
        float px = size * uPx / max(dist, 0.05);
        vBokeh = smoothstep(4.0, 16.0, px);
        gl_PointSize = clamp(px, 1.5, 34.0);
        float fade = smoothstep(0.25, 1.2, dist) * (1.0 - smoothstep(uBox.x * 0.6, uBox.x, length(rel)));
        vI = vis * hg * 0.05 * fade * (0.4 + 0.6 * fract(aSeed * 13.7)) / (1.0 + vBokeh * px * 0.06);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor;
      uniform float uStrength;
      varying float vI;
      varying float vBokeh;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r = length(q);
        if (r > 1.0) discard;
        float core = exp(-r * r * 4.0);
        float disc = smoothstep(1.0, 0.85, r) * (0.55 + 0.45 * smoothstep(0.5, 0.95, r));
        float a = mix(core, disc, vBokeh);
        gl_FragColor = vec4(uSunColor * vI * a * uStrength, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = 'dust';
  return pts;
}

// Things that fall through the air: golden birch leaves in autumn, snowflakes in winter.
// Particles wrap around the camera; `uAmount` (0..1) decides how many of them are present.
function fallingParticles({ count, seed, box, leaf }) {
  const rng = new RNG(seed);
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.float(-1, 1);
    pos[i * 3 + 1] = rng.float(-1, 1);
    pos[i * 3 + 2] = rng.float(-1, 1);
    rnd[i] = rng.next();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(rnd, 1));
  const mat = new THREE.ShaderMaterial({
    defines: leaf ? { LEAF: '' } : {},
    uniforms: {
      ...shadowUniforms,
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(...box) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: sunHDR },
      uPx: { value: 800 },
      uAmount: { value: 0 },
    },
    vertexShader: /* glsl */ `
      ${SHADOW_GLSL}
      attribute float aSeed;
      uniform float uTime;
      uniform float uAmount;
      uniform float uPx;
      uniform vec3 uCam;
      uniform vec3 uBox;
      uniform vec3 uSunDir;
      varying float vOn;
      varying float vSpin;
      varying float vFlip;
      varying float vLight;
      varying vec3 vTint;
      varying float vPx;
      void main() {
        float s = aSeed;
        vOn = step(fract(s * 17.31), uAmount);
#ifdef LEAF
        float fall = 0.28 + 0.22 * fract(s * 13.1);
        float sway = 0.7;
        float size = 0.05 + 0.025 * fract(s * 5.7);
#else
        float fall = 0.16 + 0.16 * fract(s * 13.1);
        float sway = 0.45;
        float size = 0.014 + 0.018 * fract(s * 5.7);
#endif
        vec3 p = position * uBox;
        p.y -= uTime * fall;
#ifdef LEAF
        p.x += sin(uTime * 0.6 + s * 40.0) * sway + uTime * 0.12;
        p.z += cos(uTime * 0.45 + s * 23.0) * sway;
#else
        // snow floats: slow wide swaying plus a little flutter, carried by a faint breeze
        p.x += sin(uTime * 0.32 + s * 40.0) * sway + sin(uTime * 0.9 + s * 13.0) * 0.07 + uTime * 0.05;
        p.z += cos(uTime * 0.27 + s * 23.0) * sway + cos(uTime * 0.8 + s * 7.0) * 0.06;
#endif
        vec3 rel = mod(p - uCam + uBox, uBox * 2.0) - uBox;
        vec3 wp = uCam + rel;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float dist = -mv.z;
#ifdef LEAF
        vPx = clamp(size * uPx / max(dist, 0.05), 1.5, 72.0);
        vOn *= smoothstep(0.35, 1.2, dist);
#else
        vPx = clamp(size * uPx / max(dist, 0.05), 1.5, 120.0);
        vOn *= smoothstep(0.15, 0.6, dist);
#endif
        gl_PointSize = vOn * vPx;
        vOn *= 1.0 - smoothstep(uBox.x * 0.7, uBox.x, length(rel));
        vSpin = uTime * (1.2 + 2.4 * fract(s * 7.3)) + s * 30.0;
        vFlip = uTime * (0.9 + 1.6 * fract(s * 3.9)) + s * 11.0;
        vec3 V = normalize(wp - cameraPosition);
        float back = pow(max(dot(V, uSunDir), 0.0), 4.0);
        vLight = sunVisibility(wp) * (0.6 + 1.6 * back);
        vec3 gold = mix(vec3(0.62, 0.32, 0.03), vec3(0.75, 0.52, 0.07), fract(s * 3.7));
        vTint = mix(gold, vec3(0.32, 0.14, 0.05), step(0.78, fract(s * 5.3)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor;
      varying float vOn;
      varying float vSpin;
      varying float vFlip;
      varying float vLight;
      varying vec3 vTint;
      varying float vPx;
      void main() {
        if (vOn < 0.01) discard;
        vec2 q = gl_PointCoord * 2.0 - 1.0;
#ifdef LEAF
        float c = cos(vSpin), s = sin(vSpin);
        q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        q.x /= max(abs(cos(vFlip)), 0.22);          // tumbling: the leaf turns edge-on and back
        float d = length(q * vec2(1.0, 1.85));
        if (d > 0.95) discard;
        vec3 col = vTint * (0.18 + vLight * 0.32 * uSunColor);
        gl_FragColor = vec4(col, 1.0);
#else
        float d = length(q);
        // flakes close to the lens are big, out of focus and faint; distant ones small and soft
        float blur = clamp(vPx / 60.0, 0.0, 1.0);
        float a = (1.0 - smoothstep(mix(0.5, 0.0, blur), 1.0, d)) * vOn * mix(0.85, 0.3, blur);
        if (a < 0.01) discard;
        vec3 col = vec3(0.93, 0.95, 1.0) * (0.75 + vLight * 0.18 * length(uSunColor) / 1.7);
        gl_FragColor = vec4(col, a);
#endif
      }`,
    transparent: !leaf,
    depthWrite: leaf,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = leaf ? 'falling-leaves' : 'snowfall';
  return pts;
}

export const fallingLeaves = (count) => fallingParticles({ count, seed: 404, box: [10, 6, 10], leaf: true });
export const snowfall = (count) => fallingParticles({ count, seed: 808, box: [8, 5, 8], leaf: false });

// A ring of misty forest far away so the horizon never shows empty sky.
export function forestBackdrop() {
  const R = FOREST_RADIUS + 22;
  const geo = new THREE.CylinderGeometry(R, R, 60, 160, 1, true);
  geo.translate(0, 18, -6);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFog: { value: new THREE.Color() },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWP;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${HASH_GLSL}
      uniform vec3 uFog;
      uniform vec3 uSunDir;
      varying vec3 vWP;
      varying vec2 vUv;
      float vnoise(float x) { float i = floor(x); float f = fract(x); return mix(hash12(vec2(i, 3.1)), hash12(vec2(i + 1.0, 3.1)), f * f * (3.0 - 2.0 * f)); }
      void main() {
        float a = vUv.x * 900.0;
        float y = vWP.y;
        float canopy = 18.0 + vnoise(a * 0.15) * 8.0 + vnoise(a * 0.9) * 3.0;
        float alpha = 1.0 - smoothstep(canopy - 10.0, canopy, y);
        if (alpha < 0.01) discard;
        float trunk = step(0.6, hash12(vec2(floor(a), 1.0))) * smoothstep(0.5, 0.25, abs(fract(a) - 0.5));
        float depthMix = 0.86 + 0.08 * vnoise(a * 0.2);
        vec3 dir = normalize(vWP - cameraPosition);
        float sun = pow(max(dot(dir, uSunDir), 0.0), 5.0);
        vec3 col = uFog * (depthMix - trunk * 0.1 * (1.0 - smoothstep(4.0, 16.0, y)));
        col *= 1.0 + vec3(0.55, 0.42, 0.26) * sun * 4.0;
        gl_FragColor = vec4(col, alpha);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'backdrop';
  return mesh;
}

// Collect dew-drop positions on moss tufts and grass around the close-up.
export function dewPoints(mossPoints, grassPoints, count, rng) {
  const out = [];
  const S = SAPLING;
  const pool = mossPoints.filter(([x, z]) => Math.hypot(x - S.x, z - (S.y + 1.0)) < 4.5);
  for (let i = 0; i < count && pool.length; i++) {
    const [x, z] = pool[Math.floor(rng.next() * pool.length)];
    const px = x + rng.float(-0.05, 0.05);
    const pz = z + rng.float(-0.05, 0.05);
    out.push([px, heightAt(px, pz) + rng.float(0.03, 0.075), pz, rng.float(0.0009, 0.0024)]);
  }
  void grassPoints;
  return out;
}
