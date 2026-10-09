import * as THREE from 'three';
import { shared, injectWind, injectFoliage, injectSeason } from '../gl/patches.js';
import { HASH_GLSL } from '../gl/noise.glsl.js';
import { SUN_DIR } from './layout.js';

const f = (x) => x.toFixed(5);

// ── Foliage (needles, leaves, ferns, moss, grass) ────────────
export function foliageMaterial({
  map,
  trans = [1.0, 0.82, 0.42],
  wind = 'tree',
  height = 20,
  alphaTest = 0.5,
  a2c = true,
  color = 0xffffff,
  power = 4,
  side = THREE.DoubleSide,
  vertexColors = true,
  key = 'a',
  season = 'none',
  lossPerCard = false,
}) {
  const mat = new THREE.MeshLambertMaterial({
    map,
    color,
    alphaTest,
    side,
    vertexColors,
    alphaToCoverage: a2c,
  });
  const uTrans = { value: new THREE.Vector3(...trans) };
  const uH = { value: height };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uWind = shared.uWind;
    sh.uniforms.uTreeH = uH;
    sh.uniforms.uTrans = uTrans;
    injectWind(sh, wind);
    injectFoliage(sh, { power });
    injectSeason(sh, season);
  };
  mat.customProgramCacheKey = () => `foliage-${wind}-${power}-${key}-${lossPerCard ? 'card' : 'plant'}`;
  if (lossPerCard) mat.defines = { LOSS_PER_CARD: '' };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest, side });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uWind = shared.uWind;
    sh.uniforms.uTreeH = uH;
    injectWind(sh, wind);
    injectSeason(sh, season, { depth: true });
  };
  depth.customProgramCacheKey = () => `foliage-depth-${wind}-${lossPerCard ? 'card' : 'plant'}`;
  if (lossPerCard) depth.defines = { LOSS_PER_CARD: '' };
  mat.userData.depth = depth;
  mat.userData.uH = uH;
  mat.userData.uTrans = uTrans;
  return mat;
}

// Depth material for opaque wind-animated geometry (bark).
export function windDepthMaterial(uH, wind = 'tree') {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uWind = shared.uWind;
    sh.uniforms.uTreeH = uH;
    injectWind(sh, wind);
  };
  depth.customProgramCacheKey = () => `bark-depth-${wind}`;
  return depth;
}

// ── Bark: two textures blended by height (e.g. pine: plated foot → orange flaky top) ──
export function barkMaterial({ texA, texB, mixAt = 2, mixWidth = 0.05, scaleB = [1, 1], height = 20, footMoss = 1, topMoss = 0, normalScale = 1.2, wind = true }) {
  const mat = new THREE.MeshStandardMaterial({
    map: texA.color,
    normalMap: texA.normal,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughness: 1,
    metalness: 0,
  });
  const uH = { value: height };
  const u = {
    uMapB: { value: (texB ?? texA).color },
    uNormB: { value: (texB ?? texA).normal },
    uBark: { value: new THREE.Vector4(mixAt, mixWidth, scaleB[0], scaleB[1]) },
    uMoss: { value: new THREE.Vector2(footMoss, topMoss) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uTime: shared.uTime, uWind: shared.uWind, uTreeH: uH, uSnow: shared.uSnow });
    if (wind) injectWind(sh, 'tree');
    else sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSway;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH;\nvarying float vH;\nvarying float vLY;\nvarying vec3 vWN;')
      .replace(
        '#include <fog_vertex>',
        /* glsl */ `#include <fog_vertex>
vH = aH;
vLY = position.y;
#ifdef USE_INSTANCING
  vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
  vWN = normalize(mat3(modelMatrix) * objectNormal);
#endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uMapB;
uniform sampler2D uNormB;
uniform vec4 uBark;
uniform vec2 uMoss;
uniform float uSnow;
varying float vH;
varying float vLY;
varying vec3 vWN;
float bMix = 0.0;
float bRough = 1.0;
float bMoss = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
{
  vec2 uvA = vMapUv;
  vec2 uvB = vMapUv * uBark.zw;
  vec4 cA = texture2D(map, uvA);
  vec4 cB = texture2D(uMapB, uvB);
  float nz = texture2D(uNormB, uvA * vec2(0.37, 0.23)).a;
  bMix = smoothstep(uBark.x - uBark.y, uBark.x + uBark.y, vH + (nz - 0.5) * uBark.y * 2.0);
  vec4 c = mix(cA, cB, bMix);
  bRough = c.a;
  vec3 wn = normalize(vWN);
  vec3 away = normalize(vec3(${f(-SUN_DIR.x)}, 0.0, ${f(-SUN_DIR.z)}));
  float side = smoothstep(-0.4, 0.8, dot(wn, away));
  float mossTop = smoothstep(0.15, 0.6, wn.y + (nz - 0.5) * 0.8) * uMoss.y;
  bMoss = mossTop;
#ifdef TREE_BARK
  float foot = 1.0 - smoothstep(0.05, 0.9 + nz * 0.9, vLY);
  bMoss = max(bMoss, side * foot * smoothstep(0.3, 0.55, nz + 0.2) * uMoss.x);
#endif
  bMoss = clamp(bMoss, 0.0, 1.0);
  vec3 mossCol = mix(vec3(0.05, 0.09, 0.015), vec3(0.17, 0.24, 0.04), nz);
  c.rgb = mix(c.rgb, mossCol, bMoss);
#ifdef TREE_BARK
  c.rgb *= mix(0.5, 1.0, smoothstep(-0.15, 0.8, vLY));
#endif
  // winter: snow settles on everything that faces up (branches, logs, stumps)
  float bSnow = smoothstep(0.25, 0.65, wn.y + (nz - 0.5) * 0.6) * uSnow;
  c.rgb = mix(c.rgb, vec3(0.72, 0.75, 0.8), bSnow);
  bMoss = max(bMoss, bSnow);
  diffuseColor *= c;
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = roughness * mix(bRough, 0.95, bMoss);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
{
  vec3 nA = texture2D(normalMap, vNormalMapUv).xyz;
  vec3 nB = texture2D(uNormB, vNormalMapUv * uBark.zw).xyz;
  vec3 mapN = mix(nA, nB, bMix) * 2.0 - 1.0;
  mapN.xy *= normalScale * (1.0 - 0.7 * bMoss);
  normal = normalize(tbn * mapN);
}`,
      );
  };
  mat.customProgramCacheKey = () => `bark-${wind ? 'w' : 's'}`;
  if (wind) mat.defines = { TREE_BARK: '' };
  mat.userData.uH = uH;
  if (wind) mat.userData.depth = windDepthMaterial(uH);
  return mat;
}

// ── Forest floor: moss ↔ needle litter blend driven by an ecology map + dew glints ──
export function groundMaterial({ moss, litter, noise, eco, ecoRect }) {
  const mat = new THREE.MeshStandardMaterial({
    map: moss.color, // placeholder so USE_MAP / vMapUv paths exist
    roughness: 1,
    metalness: 0,
  });
  const u = {
    uMossC: { value: moss.color },
    uMossN: { value: moss.normal },
    uLitC: { value: litter.color },
    uLitN: { value: litter.normal },
    uNoise: { value: noise },
    uEco: { value: eco },
    uEcoRect: { value: new THREE.Vector4(...ecoRect) },
    uDew: { value: 1 },
    uSGround: { value: new THREE.Vector3(1, 1, 1) },
    uSLitter: { value: 0 },
  };
  mat.userData.uniforms = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uSnow: shared.uSnow });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vGN;')
      .replace(
        '#include <fog_vertex>',
        '#include <fog_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGN = normalize(mat3(modelMatrix) * objectNormal);',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${HASH_GLSL}
uniform sampler2D uMossC, uMossN, uLitC, uLitN, uNoise, uEco;
uniform vec4 uEcoRect;
uniform float uDew;
uniform float uSnow;
uniform vec3 uSGround;
uniform float uSLitter;
varying vec3 vWP;
varying vec3 vGN;
float gMoss = 1.0;
float gSnow = 0.0;
float gRough = 1.0;
vec3 gN = vec3(0.0, 0.0, 1.0);
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
{
  vec2 w = vWP.xz;
  vec4 eco = texture2D(uEco, (w - uEcoRect.xy) / uEcoRect.zw);
  vec4 nz = texture2D(uNoise, w * 0.021);
  vec4 nz2 = texture2D(uNoise, w * 0.093 + 0.37);
  float bl = smoothstep(0.38, 0.62, nz2.g);
  vec2 m1 = w / 1.7, m2 = rot2(w, 0.61) / 2.3 + 0.5;
  vec2 l1 = w / 1.15, l2 = rot2(w, 1.13) / 1.45 + 0.3;
  vec2 m2x = dFdx(m2), m2y = dFdy(m2), l2x = dFdx(l2), l2y = dFdy(l2);
  vec4 mc = texture2D(uMossC, m1);
  vec4 mn = texture2D(uMossN, m1);
  vec4 lc = texture2D(uLitC, l1);
  vec4 ln = texture2D(uLitN, l1);
  // second, rotated sample breaks up tiling — only where it can be seen
  if (bl > 0.01 && length(vWP - cameraPosition) < 30.0) {
    mc = mix(mc, textureGrad(uMossC, m2, m2x, m2y), bl);
    mn = mix(mn, textureGrad(uMossN, m2, m2x, m2y), bl);
    lc = mix(lc, textureGrad(uLitC, l2, l2x, l2y), bl);
    ln = mix(ln, textureGrad(uLitN, l2, l2x, l2y), bl);
  }
  float m = clamp(eco.r + (nz.r - 0.5) * 0.7, 0.0, 1.0);
  m = smoothstep(0.42, 0.58, m + (mn.a - ln.a) * 0.45);
  gMoss = m;
  vec3 col = mix(lc.rgb, mc.rgb, m);
  // macro variation: blueberry shade, wet hollows, sunburnt patches
  col *= mix(1.0, 0.62, eco.g * 0.8);
  col *= mix(1.0, 0.78, eco.b);
  col *= 0.86 + 0.28 * nz.b;
  col = mix(col, col * vec3(1.12, 1.02, 0.78), smoothstep(0.55, 0.8, nz.g) * 0.5);
  col *= uSGround;
  // autumn: fallen birch leaves scattered over moss and needles
  if (uSLitter > 0.001) {
    vec2 lp = w * 6.0;
    vec2 lid = floor(lp);
    vec3 lr = hash32(lid + 11.0);
    if (lr.x < 0.42 * uSLitter) {
      float a = lr.y * 6.2832;
      vec2 q = fract(lp) - 0.5 - (hash22(lid + 5.0) - 0.5) * 0.4;
      q = vec2(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y);
      float lm = smoothstep(0.2, 0.15, length(q * vec2(1.0, 1.9)));
      vec3 lc2 = mix(vec3(0.62, 0.3, 0.025), vec3(0.72, 0.5, 0.06), lr.z);
      lc2 = mix(lc2, vec3(0.28, 0.12, 0.04), step(0.72, fract(lr.x * 9.7)));
      col = mix(col, lc2, lm);
    }
  }
  // winter: snow cover, thinner under the dense spruces
  gSnow = smoothstep(0.42, 0.62, uSnow * 1.15 + (nz.r - 0.5) * 0.55 - (1.0 - eco.r) * 0.22) * step(0.001, uSnow);
  col = mix(col, vec3(0.74, 0.77, 0.82), gSnow);
  diffuseColor.rgb *= col;
  gRough = mix(mix(lc.a, mc.a, m), 0.5, gSnow);
  gN = normalize(mix(mix(ln.xyz, mn.xyz, m) * 2.0 - 1.0, vec3(0.0, 0.0, 1.0), gSnow * 0.85));
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
{
  // texture u = world x, v = world z → perturb the smooth terrain normal in world space
  vec3 geoN = normalize(vGN);
  vec3 nW = normalize(geoN + vec3(gN.x, 0.0, gN.y) * 1.6 / max(gN.z, 0.25));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <lights_fragment_begin>',
        /* glsl */ `#include <lights_fragment_begin>
#if NUM_DIR_LIGHTS > 0
{
  float dist = length(vWP - cameraPosition);
  float glint = max(uDew * 1.0, gSnow * 1.3);
  if (dist < 16.0 && glint > 0.0) {
    vec2 cp = vWP.xz * 85.0;
    vec2 cid = floor(cp);
    float r = hash12(cid);
    if (r > 0.82 - 0.1 * max(gMoss, gSnow) - 0.08 * gSnow) {
      vec2 off = hash22(cid + 3.1) - 0.5;
      float dd = length(fract(cp) - 0.5 - off * 0.5);
      float drop = smoothstep(0.34, 0.1, dd);
      vec2 rr = hash22(cid + 7.7) * 2.0 - 1.0;
      vec3 rn = normalize(vec3(rr.x, 1.1, rr.y));
      vec3 rnV = normalize((viewMatrix * vec4(rn, 0.0)).xyz);
      vec3 R = reflect(-geometryViewDir, rnV);
      float sp = pow(max(dot(R, directLight.direction), 0.0), 700.0);
      reflectedLight.directSpecular += directLight.color * sp * drop * 70.0 * glint * (0.3 + 0.7 * max(gMoss, gSnow)) * (1.0 - smoothstep(9.0, 16.0, dist));
    }
  }
}
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'ground';
  return mat;
}

// ── Rocks: triplanar granite with moss growing on top ─────────
export function rockMaterial({ rock, moss, mossBias = 0, scale = 0.45 }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  const u = {
    uRockC: { value: rock.color },
    uRockN: { value: rock.normal },
    uMossC: { value: moss.color },
    uMossN: { value: moss.normal },
    uRock: { value: new THREE.Vector2(scale, mossBias) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uSnow: shared.uSnow });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform sampler2D uRockC, uRockN, uMossC, uMossN;
uniform vec2 uRock;
uniform float uSnow;
varying vec3 vWP;
varying vec3 vWN;
float rMoss = 0.0;
float rRough = 1.0;
vec3 rWN = vec3(0.0, 1.0, 0.0);`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
{
  vec3 N = normalize(vWN);
  vec3 bw = pow(abs(N), vec3(4.0));
  bw /= dot(bw, vec3(1.0));
  vec2 ux = vWP.zy * uRock.x, uy = vWP.xz * uRock.x, uz = vWP.xy * uRock.x;
  vec4 cx = texture2D(uRockC, ux), cy = texture2D(uRockC, uy), cz = texture2D(uRockC, uz);
  vec4 rc = cx * bw.x + cy * bw.y + cz * bw.z;
  vec3 tx = texture2D(uRockN, ux).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(uRockN, uy).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(uRockN, uz).xyz * 2.0 - 1.0;
  vec3 nx = vec3(tx.xy + N.zy, abs(tx.z) * N.x);
  vec3 ny = vec3(ty.xy + N.xz, abs(ty.z) * N.y);
  vec3 nzv = vec3(tz.xy + N.xy, abs(tz.z) * N.z);
  vec3 rockN = normalize(nx.zyx * bw.x + ny.xzy * bw.y + nzv.xyz * bw.z);
  vec2 mu = vWP.xz / 1.5;
  vec4 mc = texture2D(uMossC, mu);
  vec4 mn = texture2D(uMossN, mu);
  float hgt = texture2D(uRockN, uy * 0.31).a;
  rMoss = smoothstep(0.32, 0.62, N.y + (mn.a - 0.5) * 0.7 + (hgt - 0.5) * 0.6 + uRock.y);
  vec3 mnW = normalize(vec3(mn.x * 2.0 - 1.0, mn.z * 2.0 - 1.0, mn.y * 2.0 - 1.0));
  mnW = normalize(mix(N, mnW, 0.6));
  rWN = normalize(mix(rockN, mnW, rMoss));
  diffuseColor.rgb *= mix(rc.rgb, mc.rgb * 0.95, rMoss);
  rRough = mix(rc.a, mc.a, rMoss);
  float rSnow = smoothstep(0.3, 0.6, N.y + (hgt - 0.5) * 0.4) * uSnow;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.77, 0.82), rSnow);
  rRough = mix(rRough, 0.5, rSnow);
  rWN = normalize(mix(rWN, N, rSnow));
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rWN, 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => 'rock';
  return mat;
}
