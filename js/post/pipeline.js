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
// (NaN-safe: one broken pixel must never bloom into a glowing blob)
vec3 s(vec2 o) { vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb; return any(isnan(c)) ? vec3(0.0) : min(c, vec3(250.0)); }
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

// Horizon-style screen-space ambient occlusion from the depth buffer: contact shadows between
// plants, trunks and the ground that the single sun and the hemisphere light cannot give.
const SSAO = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec2 uTexel;
uniform vec2 uRes;
uniform float uRadius;
uniform float uStrength;
varying vec2 vUv;
vec3 posAt(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = uInvProj * ndc;
  return p.xyz / p.w;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 P = posAt(vUv);
  float dist = -P.z;
  if (dist > 45.0) { gl_FragColor = vec4(1.0, dist, 0.0, 1.0); return; }
  vec3 Px1 = posAt(vUv + vec2(uTexel.x, 0.0)), Px0 = posAt(vUv - vec2(uTexel.x, 0.0));
  vec3 Py1 = posAt(vUv + vec2(0.0, uTexel.y)), Py0 = posAt(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(Px1.z - P.z) < abs(P.z - Px0.z) ? Px1 - P : P - Px0;
  vec3 dy = abs(Py1.z - P.z) < abs(P.z - Py0.z) ? Py1 - P : P - Py0;
  vec3 N = normalize(cross(dx, dy));
  float radPx = clamp(uRadius * uProj[1][1] / dist * uRes.y * 0.5, 2.0, 90.0);
  float noise = ign(gl_FragCoord.xy);
  float occ = 0.0;
  const int DIRS = 6;
  const int STEPS = 4;
  for (int i = 0; i < DIRS; i++) {
    float a = (float(i) + noise) * 6.2831853 / float(DIRS);
    vec2 dir = vec2(cos(a), sin(a));
    for (int j = 1; j <= STEPS; j++) {
      float t = (float(j) - 0.5 + fract(noise * 7.13 + float(i) * 0.37)) / float(STEPS);
      vec2 suv = vUv + dir * radPx * t / uRes;
      vec3 S = posAt(suv);
      vec3 v = S - P;
      float l = length(v);
      float ndv = dot(N, v) / max(l, 1e-4);
      float w = 1.0 - clamp(l / uRadius, 0.0, 1.0);
      occ += max(ndv - 0.12, 0.0) * w;
    }
  }
  occ /= float(DIRS * STEPS);
  float ao = clamp(1.0 - occ * uStrength, 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(22.0, 45.0, dist));
  gl_FragColor = vec4(ao, dist, 0.0, 1.0);
}`;

const AO_BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tSrc, vUv).rg;
  float sum = c.r;
  float wsum = 1.0;
  for (int i = 1; i <= 3; i++) {
    vec2 a = texture2D(tSrc, vUv + uDir * float(i)).rg;
    vec2 b = texture2D(tSrc, vUv - uDir * float(i)).rg;
    float wa = exp(-abs(a.g - c.g) * 2.5) * (1.0 - float(i) * 0.22);
    float wb = exp(-abs(b.g - c.g) * 2.5) * (1.0 - float(i) * 0.22);
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
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

// Depth of field, step 1: half-resolution colour + the nearest linear depth of each 2×2 block
// (nearest, so thin foreground leaves keep their depth and blur over what lies behind them).
const DOF_PREP = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uTexel; // full-res texel
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
float linDepth(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = texture2D(tScene, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tScene, vUv + vec2(o.x, -o.y)).rgb
         + texture2D(tScene, vUv + vec2(-o.x, o.y)).rgb + texture2D(tScene, vUv + vec2(o.x, o.y)).rgb;
  float d = min(min(texture2D(tDepth, vUv + vec2(-o.x, -o.y)).r, texture2D(tDepth, vUv + vec2(o.x, -o.y)).r),
                min(texture2D(tDepth, vUv + vec2(-o.x, o.y)).r, texture2D(tDepth, vUv + vec2(o.x, o.y)).r));
  c *= 0.25;
  gl_FragColor = vec4(any(isnan(c)) ? vec3(0.0) : min(c, vec3(400.0)), linDepth(d));
}`;

// Depth of field, step 2: a lens-like gather. Every sample along a golden-angle spiral contributes if its own
// circle of confusion reaches this pixel (scatter-as-gather), so out-of-focus foreground bleeds over its edges,
// bright points open into bokeh discs, and the background never smears over sharper things in front of it.
const DOF_GATHER = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel; // half-res texel
uniform float uFocus;
uniform float uScale;
uniform float uMaxPx;
uniform float uSpacing;
varying vec2 vUv;
const float GA = 2.39996323;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// near blur may grow larger than far blur, as with a real lens (the circle of confusion explodes up close)
float coc(float z) { return clamp((1.0 / uFocus - 1.0 / z) * uScale, -NEAR_MAX, 1.0) * uMaxPx; }
void main() {
  vec4 c0 = texture2D(tSrc, vUv);
  float s0 = abs(coc(c0.a));
  vec3 acc = c0.rgb;
  float tot = 1.0;
  float nearCover = 0.0;
  // a different rotation of the spiral per pixel turns structured ripples into fine noise the grain hides
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  for (int i = 0; i < DOF_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(DOF_SAMPLES)) * uMaxPx * NEAR_MAX;
    float a = fi * GA + rot;
    vec4 cs = texture2D(tSrc, vUv + vec2(cos(a), sin(a)) * r * uTexel);
    float signedS = coc(cs.a);
    float ss = abs(signedS);
    if (cs.a > c0.a) ss = min(ss, s0 * 2.0);
    float m = smoothstep(r - uSpacing, r + uSpacing, ss);
    acc += mix(acc / tot, cs.rgb, m);
    tot += 1.0;
    if (signedS < 0.0) nearCover = max(nearCover, m * smoothstep(0.6, 2.5, ss));
  }
  gl_FragColor = vec4(acc / tot, nearCover);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tVol;
uniform sampler2D tDof;
uniform sampler2D tDepth;
uniform sampler2D tRays;
uniform sampler2D tAO;
uniform float uAO;
uniform float uRays;
uniform vec3 uSunColor;
uniform float uExposure;
uniform float uBloom;
uniform float uVol;
uniform float uDof;
uniform float uFocus;
uniform float uFocusRange;
uniform float uDofScale;
uniform float uDofMaxPx;
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
  if (any(isnan(col))) col = vec3(0.0);
  if (uAO > 0.001) {
    float ao = texture2D(tAO, vUv).r;
    float lumS = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(1.0, ao, uAO * (1.0 - smoothstep(0.5, 2.4, lumS)));
  }
  if (uDof > 0.001) {
    float z = linDepth(texture2D(tDepth, vUv).r);
    float own = abs(clamp((1.0 / uFocus - 1.0 / z) * uDofScale, -1.8, 1.0)) * uDofMaxPx;
    vec4 dof = texture2D(tDof, vUv);
    col = mix(col, dof.rgb, max(smoothstep(0.35, 1.4, own), dof.a));
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
    this.dofA = new THREE.WebGLRenderTarget(1, 1, { ...hdr, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.dofB = new THREE.WebGLRenderTarget(1, 1, hdr);
    const dofSamples = { ultra: 96, high: 72, medium: 48, low: 32 }[quality.tier] ?? 48;
    this.dofSamples = dofSamples;
    this.dofPrep = pass(DOF_PREP, { tScene: { value: this.sceneRT.texture }, tDepth: { value: this.sceneRT.depthTexture }, uTexel: { value: new THREE.Vector2() }, uNear: { value: 0.05 }, uFar: { value: 1000 } });
    this.dofGather = pass(DOF_GATHER, { tSrc: { value: this.dofA.texture }, uTexel: { value: new THREE.Vector2() }, uFocus: { value: 2 }, uScale: { value: 1 }, uMaxPx: { value: 8 }, uSpacing: { value: 1 } });
    this.dofGather.defines = { DOF_SAMPLES: dofSamples, NEAR_MAX: '1.8' };
    this.aoA = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.aoB = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.whiteTex.needsUpdate = true;
    this.ssao = pass(SSAO, {
      tDepth: { value: this.sceneRT.depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 0.5 },
      uStrength: { value: 2.6 },
    });
    this.aoBlur = pass(AO_BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

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
      uDofScale: { value: 1 },
      uDofMaxPx: { value: 0 },
      tRays: { value: this.raysA.texture },
      tAO: { value: this.whiteTex },
      uAO: { value: 0 },
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
    this.dofA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.dofB.setSize(this.dofA.width, this.dofA.height);
    this.aoA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.aoB.setSize(this.aoA.width, this.aoA.height);
    this.ssao.uniforms.uTexel.value.set(1 / this.aoA.width, 1 / this.aoA.height);
    this.ssao.uniforms.uRes.value.set(this.aoA.width, this.aoA.height);
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

    const cu = this.composite.uniforms;

    // 1b — ambient occlusion from the depth buffer
    if (this.q.ssao) {
      const su = this.ssao.uniforms;
      su.uRadius.value = look.aoRadius ?? 0.5;
      su.uInvProj.value.copy(camera.projectionMatrixInverse);
      su.uProj.value.copy(camera.projectionMatrix);
      this.draw(this.ssao, this.aoA);
      this.aoBlur.uniforms.tSrc.value = this.aoA.texture;
      this.aoBlur.uniforms.uDir.value.set(1 / this.aoA.width, 0);
      this.draw(this.aoBlur, this.aoB);
      this.aoBlur.uniforms.tSrc.value = this.aoB.texture;
      this.aoBlur.uniforms.uDir.value.set(0, 1 / this.aoA.height);
      this.draw(this.aoBlur, this.aoA);
      cu.tAO.value = this.aoA.texture;
      cu.uAO.value = look.ao ?? 0.85;
    } else {
      cu.tAO.value = this.whiteTex;
      cu.uAO.value = 0;
    }

    // 2 — volumetric light
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

    // 4 — depth of field: thin-lens circle of confusion, half-res bokeh gather
    // CoC = (1/focus − 1/z) · scale, normalised so the blur is a quarter of its maximum at focus + focusRange.
    let dofScale = 1;
    let dofMaxPx = 0;
    if (look.dof > 0.001 && this.q.dof) {
      const F = Math.max(0.05, look.focus);
      const R = Math.max(0.05, look.focusRange);
      dofScale = (0.25 * F * (F + R)) / R;
      dofMaxPx = look.dof * 0.022 * this.dofA.height; // largest blur radius in half-res pixels
      const p = this.dofPrep.uniforms;
      p.uTexel.value.set(1 / this.w, 1 / this.h);
      p.uNear.value = camera.near;
      p.uFar.value = camera.far;
      this.draw(this.dofPrep, this.dofA);
      const g = this.dofGather.uniforms;
      g.uTexel.value.set(1 / this.dofA.width, 1 / this.dofA.height);
      g.uFocus.value = F;
      g.uScale.value = dofScale;
      g.uMaxPx.value = Math.max(1, dofMaxPx);
      g.uSpacing.value = Math.max(0.5, ((dofMaxPx * 1.8) / Math.sqrt(this.dofSamples)) * 0.75);
      this.draw(this.dofGather, this.dofB);
    }
    cu.uDofScale.value = dofScale;
    cu.uDofMaxPx.value = dofMaxPx;

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
    cu.uWarmth.value = look.warmth ?? 1;
    if (look.sun) cu.uSunColor.value.set(look.sun[0], look.sun[1], look.sun[2]).multiplyScalar((look.sunI ?? 3.4) * (3.2 / 3.4));
    this.draw(this.composite, null);
  }
}
