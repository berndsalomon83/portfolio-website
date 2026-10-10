import * as THREE from 'three';
import { SUN_DIR } from '../world/layout.js';

// Uniforms shared by every animated material.
export const shared = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSnow: { value: 0 }, // 0 = no snow … 1 = deep winter
};

// Seasonal colour + leaf loss per plant group, driven by js/world/seasons.js.
// uSColor/uSAmount recolour the leaves (keeping their light and shade), uSLoss drops leaves or plants.
const seasonGroup = () => ({ uSColor: { value: new THREE.Vector3(0.25, 0.45, 0.06) }, uSAmount: { value: 0 }, uSLoss: { value: 0 }, uSSnow: { value: 1 } });
export const seasonUniforms = {
  conifer: seasonGroup(),
  birch: seasonGroup(),
  berry: seasonGroup(),
  lingon: seasonGroup(),
  fern: seasonGroup(),
  grass: seasonGroup(),
  moss: seasonGroup(),
  none: seasonGroup(),
};

const SEASON_VERT = /* glsl */ `
varying float vSRnd;
#if !defined(USE_COLOR) && !defined(USE_COLOR_ALPHA)
  attribute vec3 color;
#endif
float seasonRandom() {
#ifdef LOSS_PER_CARD
  vec3 key = color.rgb;                 // every card has its own tint → its own random
#else
  vec3 key = vec3(0.37, 0.61, 0.13);    // whole plant at once
#endif
#ifdef USE_INSTANCING
  vec2 inst = instanceMatrix[3].xz;
#else
  vec2 inst = modelMatrix[3].xz;
#endif
  return fract(sin(dot(key, vec3(12.9898, 78.233, 37.719)) * 1.37 + dot(inst, vec2(0.731, 0.397))) * 43758.5453);
}`;

// Season support for foliage: tint, leaves (or whole plants) dropping out, snow on top.
// `depth` = the shadow material variant (only needs the drop-out so bare trees cast bare shadows).
export function injectSeason(shader, group, { depth = false } = {}) {
  const u = seasonUniforms[group] ?? seasonUniforms.none;
  shader.uniforms.uSColor = u.uSColor;
  shader.uniforms.uSAmount = u.uSAmount;
  shader.uniforms.uSLoss = u.uSLoss;
  shader.uniforms.uSSnow = u.uSSnow;
  shader.uniforms.uSnow = shared.uSnow;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${SEASON_VERT}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSRnd = seasonRandom();');
  const pars = '#define HAS_SEASON\nuniform vec3 uSColor;\nuniform float uSAmount;\nuniform float uSLoss;\nuniform float uSSnow;\nuniform float uSnow;\nvarying float vSRnd;\nfloat sSnowMask = 0.0;';
  if (depth) {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace('void main() {', 'void main() {\n  if (vSRnd < uSLoss) discard;');
    return;
  }
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${pars}`).replace(
    '#include <map_fragment>',
    /* glsl */ `#include <map_fragment>
  if (vSRnd < uSLoss) discard;
  diffuseColor.rgb = mix(diffuseColor.rgb, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) / 0.32 * uSColor, uSAmount);
  {
    vec3 sWn = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
    sSnowMask = smoothstep(0.12, 0.55, sWn.y + (vSRnd - 0.5) * 0.35) * uSnow * uSSnow;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.75, 0.8), sSnowMask * 0.85);
  }`,
  );
}

const f = (x) => x.toFixed(5);

// Height fog with forward scattering toward the sun, replacing three's built-in fog.
// Uses scene.fog (FogExp2): colour = ambient haze, density = base density at ground level.
// On top lies a ground mist: much denser close to the ground, pooling in the hollows (steep height falloff,
// integrated exactly along the view ray) and gathered in banks between the trunks (noise sampled at a few
// points along the ray), whiter than the haze. The far distance turns slightly cooler (aerial perspective).
export function installFog({ falloff = 0.07, sunGlow = [0.55, 0.42, 0.26], mist = 1.6, mistK = 0.55, mistBase = 1.0, mistTaps = 2 } = {}) {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
    float fMistHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float fMistNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 u = fract(p);
      u = u * u * (3.0 - 2.0 * u);
      return mix(mix(fMistHash(i), fMistHash(i + vec2(1.0, 0.0)), u.x), mix(fMistHash(i + vec2(0.0, 1.0)), fMistHash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
{
  vec3 fRay = vFogWorldPos - cameraPosition;
  float fDist = length(fRay);
  vec3 fDir = fRay / max(fDist, 1e-4);
  #ifdef FOG_EXP2
    float fT = ${f(falloff)} * fRay.y;
    float fLine = abs(fT) > 1e-3 ? (1.0 - exp(-fT)) / fT : 1.0 - 0.5 * fT;
    float fOD = fogDensity * exp(-${f(falloff)} * cameraPosition.y) * fDist * fLine;
    float mT = ${f(mistK)} * fRay.y;
    float mLine = abs(mT) > 1e-3 ? (1.0 - exp(-mT)) / mT : 1.0 - 0.5 * mT;
    float mOD = fogDensity * ${f(mist)} * exp(-${f(mistK)} * (cameraPosition.y - ${f(mistBase)})) * fDist * mLine;
    float mBank = 0.0;
    for (int k = 0; k < ${mistTaps}; k++) {
      vec2 q = cameraPosition.xz + fDir.xz * min(fDist, 48.0) * (float(k) + 0.6) / ${mistTaps}.0;
      mBank += fMistNoise(q * 0.16) * 0.65 + fMistNoise(q * 0.43 + 7.1) * 0.35;
    }
    mOD *= mix(0.15, 1.85, smoothstep(0.25, 0.75, mBank / ${mistTaps}.0));
    float fogFactor = 1.0 - exp(-(fOD + mOD));
    float mShare = mOD / max(fOD + mOD, 1e-5);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    float mShare = 0.0;
  #endif
  float fSun = pow(max(dot(fDir, vec3(${f(SUN_DIR.x)}, ${f(SUN_DIR.y)}, ${f(SUN_DIR.z)})), 0.0), 5.0);
  vec3 fCol = fogColor * (1.0 + vec3(${sunGlow.map(f).join(', ')}) * fSun * 4.0);
  fCol = mix(fCol, fCol * 1.1 + 0.012, mShare);
  fCol *= mix(vec3(1.0), vec3(0.93, 0.98, 1.07), smoothstep(12.0, 70.0, fDist));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fCol, fogFactor);
}
#endif`;
}

// ── Wind ─────────────────────────────────────────────────────

const WIND_TREE = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uTreeH;
attribute float aSway;
vec3 windOffset(vec3 base, vec3 lp, vec3 wp) {
  float h = clamp(lp.y / uTreeH, 0.0, 1.2);
  float ph = dot(base.xz, vec2(0.071, 0.053));
  float gust = 0.55 + 0.45 * sin(uTime * 0.21 + base.x * 0.013 + base.z * 0.011);
  float b = h * h * (sin(uTime * 0.63 + ph) * 0.65 + sin(uTime * 1.41 + ph * 1.9) * 0.35);
  vec3 off = vec3(0.82, 0.0, 0.57) * b * 0.28 * gust;
  float fl = sin(uTime * 2.3 + dot(wp, vec3(0.9, 1.3, 0.7))) * 0.6 + sin(uTime * 3.7 + dot(wp, vec3(1.7, 0.6, 1.4))) * 0.4;
  off += vec3(0.35, 0.25, 0.3) * fl * aSway * 0.07 * gust;
  return off * uWind;
}`;

const WIND_PLANT = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform float uTreeH;
attribute float aSway;
vec3 windOffset(vec3 base, vec3 lp, vec3 wp) {
  float h = clamp(lp.y / uTreeH, 0.0, 1.6);
  float k = pow(h, 1.6);
  float ph = dot(base.xz, vec2(0.37, 0.29));
  float gust = 0.5 + 0.5 * sin(uTime * 0.27 + base.x * 0.05 + base.z * 0.04);
  float s = sin(uTime * 1.7 + ph) * 0.6 + sin(uTime * 3.1 + ph * 1.7 + wp.y * 4.0) * 0.4;
  float fl = sin(uTime * 6.0 + dot(wp, vec3(17.0, 11.0, 13.0))) * aSway;
  return (vec3(0.8, 0.0, 0.6) * s * k * 0.07 * (0.4 + gust) + vec3(0.3, 0.6, 0.2) * fl * 0.012) * uWind * uTreeH;
}`;

// Inject wind displacement. Works for InstancedMesh (per-instance phase) and plain meshes.
export function injectWind(shader, mode = 'tree') {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${mode === 'tree' ? WIND_TREE : WIND_PLANT}`)
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
{
#ifdef USE_INSTANCING
  mat3 wIm = mat3(instanceMatrix);
  vec3 wBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  vec3 wWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vec3 wOff = windOffset(wBase, transformed, wWp);
  transformed += transpose(wIm) * wOff / max(dot(wIm[0], wIm[0]), 1e-6);
#else
  vec3 wBase = modelMatrix[3].xyz;
  vec3 wWp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  mat3 wM = mat3(modelMatrix);
  transformed += transpose(wM) * windOffset(wBase, transformed, wWp) / max(dot(wM[0], wM[0]), 1e-6);
#endif
}`,
    );
}

// ── Foliage: translucency, sharpened alpha, non-flipped crown normals ──

export function injectFoliage(shader, { power = 4, flipNormals = false } = {}) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uTrans;');
  if (!flipNormals) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      /* glsl */ `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
vec3 normal = normalize(vNormal);
vec3 nonPerturbedNormal = normal;`,
    );
  }
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
#ifdef USE_MAP
{
  vec2 mt = vMapUv * vec2(textureSize(map, 0));
  vec2 dx = dFdx(mt), dy = dFdy(mt);
  float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  diffuseColor.a *= 1.0 + mip * 0.22;
}
#endif`,
    )
    .replace(
      '#include <lights_fragment_begin>',
      /* glsl */ `#include <lights_fragment_begin>
#if NUM_DIR_LIGHTS > 0
{
  vec3 tL = directLight.direction;
  float tV = max(dot(-geometryViewDir, tL), 0.0);
  float tScatter = pow(tV, ${power.toFixed(1)}) * 1.6 + 0.22 * tV;
  float tBack = max(dot(-geometryNormal, tL), 0.0) * 0.25;
#ifdef HAS_SEASON
  float tSnowK = 1.0 - sSnowMask;
#else
  float tSnowK = 1.0;
#endif
  reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb * uTrans * (tScatter + tBack) * tSnowK;
}
#endif`,
    );
}
