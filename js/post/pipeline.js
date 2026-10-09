import * as THREE from 'three';
import { fullscreenTriangle } from '../lib/geometry.js';
import { SUN_DIR, SUN_COLOR, SAPLING } from '../world/layout.js';

// HDR render → volumetric sun shafts (ray-marched through the real shadow map) → bloom → depth of field
// → filmic tone mapping, grading, vignette and grain.

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DOWNSAMPLE = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uPrefilter;
varying vec2 vUv;
vec3 s(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(250.0)); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) { vec3 m = (a + b + c + d) * 0.25; return m / (1.0 + lum(m)); }
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uPrefilter > 0.5) {
    col = karis(j, k, l, m) * 0.5 + (karis(a, b, d, e) + karis(b, c, e, f) + karis(d, e, g, h) + karis(e, f, h, i)) * 0.125;
    col = col / max(1.0 - lum(col), 1e-3); // undo karis tone curve
    float br = lum(col);
    float soft = clamp(br - uThreshold + 0.5, 0.0, 1.0);
    soft = soft * soft * 0.5;
    float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
    col *= max(contrib, 0.0);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UPSAMPLE = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 c = s(vec2(-1.0, 1.0)) + 2.0 * s(vec2(0.0, 1.0)) + s(vec2(1.0, 1.0))
         + 2.0 * s(vec2(-1.0, 0.0)) + 4.0 * s(vec2(0.0)) + 2.0 * s(vec2(1.0, 0.0))
         + s(vec2(-1.0, -1.0)) + 2.0 * s(vec2(0.0, -1.0)) + s(vec2(1.0, -1.0));
  gl_FragColor = vec4(c / 16.0 * uWeight, 1.0);
}`;

const VOLUMETRIC = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform float uDensity;
uniform float uFalloff;
uniform float uMaxDist;
uniform float uHasShadow;
uniform vec3 uBeamPos;
uniform float uBeamRadius;
uniform float uTime;
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float sunVis(vec3 wp) {
  // an open column of light reaches the sapling through the gap in the canopy
  vec3 rel = wp - uBeamPos;
  float along = dot(rel, uSunDir);
  float radial = length(rel - uSunDir * along);
  float beam = along > 0.0 ? (1.0 - smoothstep(uBeamRadius * 0.4, uBeamRadius, radial)) : 0.0;
  if (uHasShadow < 0.5) return max(0.45, beam);
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return max(0.22, beam);
  float d = unpackRGBAToDepth(texture2D(tShadow, sc.xy));
  return max(step(sc.z - 0.0015, d), beam);
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 ray = wp - uCamPos;
  float dist = length(ray);
  vec3 dir = ray / dist;
  dist = min(dist, uMaxDist);
  float stepLen = dist / float(STEPS);
  float jitter = ign(gl_FragCoord.xy + fract(uTime * 7.31) * 0.0);
  float acc = 0.0;
  float trans = 1.0;
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + jitter) * stepLen;
    vec3 p = uCamPos + dir * t;
    float dens = uDensity * exp(-uFalloff * max(p.y, -4.0));
    acc += sunVis(p) * dens * stepLen * trans;
    trans *= exp(-dens * stepLen * 0.5);
  }
  float cosT = dot(dir, uSunDir);
  float g = 0.72;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5) * 0.0795775;
  float phase = hg * 0.85 + 0.0795775 * 0.6;
  gl_FragColor = vec4(vec3(acc * phase), 1.0);
}`;

// Sky pixels near the sun → occlusion mask for crepuscular rays.
const RAY_MASK = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).r;
  vec3 c = min(texture2D(tScene, vUv).rgb, vec3(40.0));
  vec2 q = (vUv - uSun) * vec2(uAspect, 1.0);
  float w = exp(-dot(q, q) * 9.0) + 0.15 * exp(-dot(q, q) * 1.5);
  float sky = step(0.99999, d);
  gl_FragColor = vec4(c * w * sky, 1.0);
}`;

// Radial blur toward the sun (GPU Gems 3, ch. 13), applied twice with shrinking steps.
const RAY_BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSun;
uniform float uLength;
uniform float uDecay;
varying vec2 vUv;
const int N = 40;
void main() {
  vec2 dir = (uSun - vUv) * uLength / float(N);
  vec2 uv = vUv;
  float w = 1.0;
  vec3 acc = vec3(0.0);
  float tot = 0.0;
  for (int i = 0; i < N; i++) {
    acc += texture2D(tSrc, uv).rgb * w;
    tot += w;
    w *= uDecay;
    uv += dir;
  }
  gl_FragColor = vec4(acc / tot, 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tVol;
uniform sampler2D tDof;
uniform sampler2D tDepth;
uniform sampler2D tRays;
uniform float uRays;
uniform vec3 uSunColor;
uniform float uExposure;
uniform float uBloom;
uniform float uVol;
uniform float uDof;
uniform float uFocus;
uniform float uFocusRange;
uniform float uNear;
uniform float uFar;
uniform float uVignette;
uniform float uGrain;
uniform float uSaturation;
uniform float uWarmth;
uniform float uTime;
uniform float uFade;
uniform vec2 uRes;
varying vec2 vUv;

const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c) { return clamp(ACESOut * rrt(ACESIn * c), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float linDepth(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }

void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  if (uDof > 0.001) {
    float z = linDepth(texture2D(tDepth, vUv).r);
    float far = smoothstep(0.0, 1.0, max(z - uFocus - uFocusRange * 0.5, 0.0) / (uFocus * 2.5 + uFocusRange));
    float near = smoothstep(uFocus * 0.45, uFocus * 0.15, z) * 0.5;
    float coc = max(far, near);
    col = mix(col, texture2D(tDof, vUv).rgb, coc * uDof);
  }
  col += texture2D(tVol, vUv).rgb * uSunColor * uVol;
  col += texture2D(tRays, vUv).rgb * uRays * vec3(1.0, 0.86, 0.62);
  col += texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure / 0.6;
  // white balance toward a warm morning
  col *= vec3(1.0 + 0.06 * uWarmth, 1.0, 1.0 - 0.08 * uWarmth);
  col = aces(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  // split toning: cool-green shadows, warm highlights
  col = mix(col * vec3(0.94, 1.0, 1.0), col * vec3(1.04, 1.0, 0.93), smoothstep(0.05, 0.75, l));
  col = max(col, 0.0);
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  col *= mix(1.0, smoothstep(1.15, 0.2, length(q)), uVignette);
  col = toSRGB(col);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5) * uGrain;
  col *= uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

function pass(fragmentShader, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    ...extra,
  });
}

export class Pipeline {
  constructor(renderer, world, quality) {
    this.renderer = renderer;
    this.world = world;
    this.q = quality;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(fullscreenTriangle(), null);
    this.quad.frustumCulled = false;

    const hdr = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: quality.msaa,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
    this.sceneRT.depthTexture.type = THREE.UnsignedIntType;

    this.bloomMips = [];
    for (let i = 0; i < 6; i++) this.bloomMips.push(new THREE.WebGLRenderTarget(1, 1, hdr));
    this.volA = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.volB = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.raysA = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.raysB = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.dofA = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.dofB = new THREE.WebGLRenderTarget(1, 1, hdr);

    this.down = pass(DOWNSAMPLE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.2 }, uPrefilter: { value: 0 } });
    this.up = pass(UPSAMPLE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true });
    this.blur = pass(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.rayMask = pass(RAY_MASK, { tScene: { value: this.sceneRT.texture }, tDepth: { value: this.sceneRT.depthTexture }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.rayBlur = pass(RAY_BLUR, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uLength: { value: 0.9 }, uDecay: { value: 0.965 } });
    this.sunNdc = new THREE.Vector3();
    this.camDir = new THREE.Vector3();

    this.dummyShadow = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.dummyShadow.needsUpdate = true;
    const beamPos = new THREE.Vector3(SAPLING.x, 0, SAPLING.y);
    this.vol = pass(VOLUMETRIC, {
      tDepth: { value: this.sceneRT.depthTexture },
      tShadow: { value: this.dummyShadow },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: SUN_DIR.clone() },
      uDensity: { value: 0.02 },
      uFalloff: { value: 0.07 },
      uMaxDist: { value: 70 },
      uHasShadow: { value: 0 },
      uBeamPos: { value: beamPos },
      uBeamRadius: { value: 0.9 },
      uTime: { value: 0 },
    });
    this.vol.defines = { STEPS: quality.volSteps };

    this.composite = pass(COMPOSITE, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: this.bloomMips[0].texture },
      tVol: { value: this.volA.texture },
      tDof: { value: this.dofB.texture },
      tRays: { value: this.raysA.texture },
      uRays: { value: 0 },
      tDepth: { value: this.sceneRT.depthTexture },
      uSunColor: { value: new THREE.Vector3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(3.2) },
      uExposure: { value: 0.6 },
      uBloom: { value: 0.12 },
      uVol: { value: 1 },
      uDof: { value: 0 },
      uFocus: { value: 2.5 },
      uFocusRange: { value: 1.2 },
      uNear: { value: 0.05 },
      uFar: { value: 1000 },
      uVignette: { value: 0.55 },
      uGrain: { value: 0.025 },
      uSaturation: { value: 1.05 },
      uWarmth: { value: 1 },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uRes: { value: new THREE.Vector2(1, 1) },
    });
    this.blackVol = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackVol.needsUpdate = true;
    this.blackVol.colorSpace = THREE.NoColorSpace;
  }

  setSize(w, h) {
    // w, h = drawing-buffer pixels
    w = Math.max(4, w);
    h = Math.max(4, h);
    this.w = w;
    this.h = h;
    this.sceneRT.setSize(w, h);
    let mw = Math.max(1, w >> 1);
    let mh = Math.max(1, h >> 1);
    for (const rt of this.bloomMips) {
      rt.setSize(mw, mh);
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
    }
    const vs = this.q.volScale;
    this.volA.setSize(Math.max(1, Math.round(w * vs)), Math.max(1, Math.round(h * vs)));
    this.volB.setSize(this.volA.width, this.volA.height);
    this.raysA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.raysB.setSize(this.raysA.width, this.raysA.height);
    this.dofA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.dofB.setSize(this.dofA.width, this.dofA.height);
    this.composite.uniforms.uRes.value.set(w, h);
  }

  draw(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.camera);
  }

  render(look, time) {
    const r = this.renderer;
    const { scene, camera, sun } = this.world;
    r.autoClear = false;

    // 1 — scene into HDR
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    // 2 — volumetric light
    const cu = this.composite.uniforms;
    if (this.q.volumetric && look.vol > 0.001) {
      const u = this.vol.uniforms;
      const map = sun.shadow && sun.shadow.map ? sun.shadow.map.texture : null;
      u.tShadow.value = map ?? this.dummyShadow;
      u.uHasShadow.value = map ? 1 : 0;
      u.uShadowMatrix.value.copy(sun.shadow.matrix);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uCamPos.value.copy(camera.position);
      u.uDensity.value = look.volDensity;
      u.uTime.value = time;
      u.uBeamPos.value.y = this.world.saplingGroundY ?? 0;
      u.uBeamRadius.value = look.beam;
      this.draw(this.vol, this.volA);
      this.blur.uniforms.tSrc.value = this.volA.texture;
      this.blur.uniforms.uDir.value.set(1 / this.volA.width, 0);
      this.draw(this.blur, this.volB);
      this.blur.uniforms.tSrc.value = this.volB.texture;
      this.blur.uniforms.uDir.value.set(0, 1 / this.volA.height);
      this.draw(this.blur, this.volA);
      cu.tVol.value = this.volA.texture;
    } else {
      cu.tVol.value = this.blackVol;
    }

    // 2b — crepuscular rays from the sun through the crowns
    camera.getWorldDirection(this.camDir);
    const facing = this.camDir.dot(SUN_DIR);
    this.sunNdc.copy(camera.position).addScaledVector(SUN_DIR, 500).project(camera);
    const sx = this.sunNdc.x * 0.5 + 0.5;
    const sy = this.sunNdc.y * 0.5 + 0.5;
    const off = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5));
    const rayK = (look.rays ?? 0) * THREE.MathUtils.smoothstep(facing, 0.15, 0.55) * (1 - THREE.MathUtils.smoothstep(off, 0.75, 1.3));
    if (rayK > 0.002) {
      this.rayMask.uniforms.uSun.value.set(sx, sy);
      this.rayMask.uniforms.uAspect.value = this.w / this.h;
      this.draw(this.rayMask, this.raysA);
      const rb = this.rayBlur.uniforms;
      rb.uSun.value.set(sx, sy);
      rb.tSrc.value = this.raysA.texture;
      rb.uLength.value = 0.95;
      rb.uDecay.value = 0.97;
      this.draw(this.rayBlur, this.raysB);
      rb.tSrc.value = this.raysB.texture;
      rb.uLength.value = 0.18;
      rb.uDecay.value = 0.99;
      this.draw(this.rayBlur, this.raysA);
    }
    cu.uRays.value = rayK;

    // 3 — bloom (downsample chain + tent upsample)
    const d = this.down.uniforms;
    let src = this.sceneRT;
    for (let i = 0; i < this.bloomMips.length; i++) {
      const dst = this.bloomMips[i];
      d.tSrc.value = src.texture;
      d.uTexel.value.set(1 / src.width, 1 / src.height);
      d.uPrefilter.value = i === 0 ? 1 : 0;
      d.uThreshold.value = look.bloomThreshold;
      r.setRenderTarget(dst);
      this.draw(this.down, dst);
      src = dst;
    }
    const up = this.up.uniforms;
    for (let i = this.bloomMips.length - 1; i > 0; i--) {
      const s = this.bloomMips[i];
      up.tSrc.value = s.texture;
      up.uTexel.value.set(1 / s.width, 1 / s.height);
      up.uWeight.value = 1.0;
      this.draw(this.up, this.bloomMips[i - 1]);
    }

    // 4 — depth-of-field source (quarter-res blur)
    if (look.dof > 0.001 && this.q.dof) {
      d.tSrc.value = this.sceneRT.texture;
      d.uTexel.value.set(2 / this.w, 2 / this.h);
      d.uPrefilter.value = 0;
      this.draw(this.down, this.dofA);
      this.blur.uniforms.tSrc.value = this.dofA.texture;
      this.blur.uniforms.uDir.value.set(1.5 / this.dofA.width, 0);
      this.draw(this.blur, this.dofB);
      this.blur.uniforms.tSrc.value = this.dofB.texture;
      this.blur.uniforms.uDir.value.set(0, 1.5 / this.dofA.height);
      this.draw(this.blur, this.dofA);
      this.blur.uniforms.tSrc.value = this.dofA.texture;
      this.blur.uniforms.uDir.value.set(2.8 / this.dofA.width, 0);
      this.draw(this.blur, this.dofB);
      this.blur.uniforms.tSrc.value = this.dofB.texture;
      this.blur.uniforms.uDir.value.set(0, 2.8 / this.dofA.height);
      this.draw(this.blur, this.dofA);
      this.blur.uniforms.tSrc.value = this.dofA.texture;
      this.blur.uniforms.uDir.value.set(2.0 / this.dofA.width, -2.0 / this.dofA.height);
      this.draw(this.blur, this.dofB);
    }

    // 5 — composite to screen
    cu.uExposure.value = look.exposure;
    cu.uBloom.value = look.bloom;
    cu.uVol.value = look.vol;
    cu.uDof.value = this.q.dof ? look.dof : 0;
    cu.uFocus.value = look.focus;
    cu.uFocusRange.value = look.focusRange;
    cu.uNear.value = camera.near;
    cu.uFar.value = camera.far;
    cu.uVignette.value = look.vignette;
    cu.uSaturation.value = look.saturation;
    cu.uTime.value = time;
    cu.uFade.value = look.fade ?? 1;
    this.draw(this.composite, null);
  }
}
