import * as THREE from 'three';
import { shared, injectWind, injectFoliage, injectSeason } from '../gl/patches.js';
import { HASH_GLSL } from '../gl/noise.glsl.js';
import { SUN_DIR } from './layout.js';

const f = (x) => x.toFixed(5);

// Fidelity switches, set from the quality tier before the world is built.
const OPTS = { pom: false, pbr: false };
export function setMaterialOptions(o) {
  Object.assign(OPTS, o);
}

// Parallax occlusion mapping: `hgtExpr(uv)` must evaluate to the surface height (0..1) at `uv`.
// Marches 14 layers from the top surface down and interpolates the hit; only within `fadeFar` metres.
const POM_GLSL = (hgtExpr, fadeNear, fadeFar) => /* glsl */ `
  {
    float pDist = length(vViewPosition);
    float pFade = (1.0 - smoothstep(${f(fadeNear)}, ${f(fadeFar)}, pDist)) * uPom;
    if (pFade > 0.0001) {
      vec3 pN = normalize(vNormal);
      mat3 ptbn = getTangentFrame(-vViewPosition, pN, vMapUv);
      vec3 pV = normalize(vViewPosition);
      vec3 vt = vec3(dot(pV, ptbn[0]), dot(pV, ptbn[1]), dot(pV, ptbn[2]));
      vt.z = max(vt.z, 0.22);
      vec2 pddx = dFdx(vMapUv), pddy = dFdy(vMapUv);
      const int PN = 14;
      float layer = 1.0 / float(PN);
      vec2 dUv = vt.xy / vt.z * pFade * layer;
      vec2 uv = vMapUv;
      float cur = 0.0;
      float hgt = 1.0 - (${hgtExpr});
      vec2 prevUv = uv;
      float prevH = hgt;
      for (int i = 0; i < PN; i++) {
        if (cur >= hgt) break;
        prevUv = uv;
        prevH = hgt;
        uv -= dUv;
        cur += layer;
        hgt = 1.0 - (${hgtExpr});
      }
      float after = hgt - cur;
      float before = prevH - (cur - layer);
      gUv = mix(uv, prevUv, clamp(after / (after - before + 1e-5), 0.0, 1.0));
    }
  }`;

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
  roughness = 0.62,
}) {
  const Mat = OPTS.pbr ? THREE.MeshStandardMaterial : THREE.MeshLambertMaterial;
  const mat = new Mat({
    map,
    color,
    alphaTest,
    side,
    vertexColors,
    alphaToCoverage: a2c,
  });
  if (OPTS.pbr) {
    mat.roughness = roughness;
    mat.metalness = 0;
  }
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
  mat.customProgramCacheKey = () => `foliage-${wind}-${power}-${key}-${lossPerCard ? 'card' : 'plant'}-${OPTS.pbr ? 'pbr' : 'lam'}`;
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
export function barkMaterial({ texA, texB, mixAt = 2, mixWidth = 0.05, scaleB = [1, 1], height = 20, footMoss = 1, topMoss = 0, normalScale = 1.2, wind = true, pom = 0.03, detail = null, uRepeat = 3 }) {
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
    uPom: { value: pom },
    uRepeat: { value: uRepeat },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, { uTime: shared.uTime, uWind: shared.uWind, uTreeH: uH, uSnow: shared.uSnow });
    if (wind) injectWind(sh, 'tree');
    else sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSway;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH;\nvarying float vH;\nvarying float vLY;\nvarying vec3 vWN;\nvarying float vSeed;')
      .replace(
        '#include <fog_vertex>',
        /* glsl */ `#include <fog_vertex>
vH = aH;
vLY = position.y;
#ifdef USE_INSTANCING
  vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  vec2 bSeedP = instanceMatrix[3].xz;
#else
  vWN = normalize(mat3(modelMatrix) * objectNormal);
  vec2 bSeedP = modelMatrix[3].xz;
#endif
vSeed = fract(sin(dot(bSeedP, vec2(12.9898, 78.233))) * 43758.5453);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
${HASH_GLSL}
uniform sampler2D uMapB;
uniform sampler2D uNormB;
uniform vec4 uBark;
uniform vec2 uMoss;
uniform float uSnow;
uniform float uPom;
uniform float uRepeat;
varying float vH;
varying float vLY;
varying vec3 vWN;
varying float vSeed;
float bMix = 0.0;
float bRough = 1.0;
float bMoss = 0.0;
vec2 gUv = vec2(0.0);`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
{
  float nz = texture2D(uNormB, vMapUv * vec2(0.37, 0.23)).a;
  float bAng = fract(vMapUv.x / uRepeat);
#ifdef BIRCH_DETAIL
  bMix = smoothstep(uBark.x - uBark.y, uBark.x + uBark.y, vH + (nz - 0.5) * uBark.y * 2.0 + (vSeed - 0.5) * 0.05 + 0.025 * sin(bAng * 12.566 + vSeed * 6.0));
#else
  bMix = smoothstep(uBark.x - uBark.y, uBark.x + uBark.y, vH + (nz - 0.5) * uBark.y * 2.0);
#endif
  gUv = vMapUv;
#ifdef USE_POM
${POM_GLSL('mix(textureGrad(normalMap, uv, pddx, pddy).a, textureGrad(uNormB, uv * uBark.zw, pddx * uBark.zw, pddy * uBark.zw).a, bMix)', 5.0, 13.0)}
#endif
  vec2 uvA = gUv;
  vec2 uvB = gUv * uBark.zw;
  vec4 cA = texture2D(map, uvA);
  vec4 cB = texture2D(uMapB, uvB);
  vec4 c = mix(cA, cB, bMix);
  bRough = c.a;
  vec3 wn = normalize(vWN);
  vec3 away = normalize(vec3(${f(-SUN_DIR.x)}, 0.0, ${f(-SUN_DIR.z)}));
  float side = smoothstep(-0.4, 0.8, dot(wn, away));
#ifdef BIRCH_DETAIL
  {
    // the white paper never repeats: a second, offset sample takes over in noise-shaped patches
    float rep = texture2D(uNormB, vec2(gUv.x * 0.11 + vSeed * 3.0, gUv.y * 0.07 + vSeed)).a;
    float paper = smoothstep(0.44, 0.56, rep);
    vec2 uv2 = (gUv * vec2(1.0, 0.83) + vec2(vSeed * 3.17, vSeed * 11.3 + 0.37)) * uBark.zw;
    vec4 cB2 = texture2D(uMapB, uv2);
    c = mix(c, mix(cA, cB2, bMix), paper);
    // scars of lost branches: black diamonds, each tree its own
    vec2 sc = vec2(bAng * 9.0, vLY * 1.1 + vSeed * 5.0);
    vec2 cid = floor(sc);
    vec2 fr = fract(sc) - 0.5;
    vec3 hr = hash32(cid + vSeed * 13.0);
    if (hr.x < 0.11) {
      vec2 q = fr - (hr.yz - 0.5) * 0.4;
      float dd = abs(q.x) * (1.4 + hr.y) + abs(q.y) * (0.7 + 0.6 * hr.z);
      float scar = (1.0 - smoothstep(0.2, 0.3, dd)) * bMix;
      float rim = (smoothstep(0.26, 0.3, dd) - smoothstep(0.3, 0.38, dd)) * bMix;
      c.rgb = mix(c.rgb, vec3(0.06, 0.055, 0.05), scar);
      c.rgb = mix(c.rgb, c.rgb * 1.12, rim);
      bRough = mix(bRough, 0.5, scar);
    }
    // lichen crusts, mostly on the shaded side
    float ln = texture2D(uNormB, vec2(bAng * 5.0 + vSeed, vLY * 0.55 + vSeed * 3.0) * 0.37).a;
    float lich = smoothstep(0.6, 0.72, ln + (side - 0.5) * 0.12) * bMix * 0.8;
    c.rgb = mix(c.rgb, vec3(0.60, 0.64, 0.50) * (0.8 + 0.4 * nz), lich);
    bRough = mix(bRough, 0.95, lich);
    // faint horizontal banding of the paper, and every tree a slightly different white
    c.rgb *= 0.95 + 0.07 * texture2D(uNormB, vec2(vSeed * 2.0, vLY * 0.41)).a;
    c.rgb *= mix(vec3(0.88, 0.9, 0.93), vec3(1.0, 0.97, 0.9), fract(vSeed * 7.31)) * mix(1.0, 1.06, bMix);
    // soot and algae darken the lower trunk on its shaded side
    float smudge = texture2D(uNormB, vec2(bAng * 2.0 + vSeed * 4.0, vLY * 0.23) * 0.9).a;
    smudge = smoothstep(0.45, 0.8, smudge) * (1.0 - smoothstep(1.0, 7.0, vLY)) * (0.35 + 0.65 * side) * bMix;
    c.rgb = mix(c.rgb, c.rgb * vec3(0.45, 0.47, 0.5), smudge * 0.6);
  }
#endif
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
  vec3 nA = texture2D(normalMap, gUv).xyz;
  vec3 nB = texture2D(uNormB, gUv * uBark.zw).xyz;
  vec3 mapN = mix(nA, nB, bMix) * 2.0 - 1.0;
  mapN.xy *= normalScale * (1.0 - 0.7 * bMoss);
  normal = normalize(tbn * mapN);
}`,
      );
  };
  mat.customProgramCacheKey = () => `bark-${wind ? 'w' : 's'}-${OPTS.pom ? 'pom' : 'flat'}-${detail ?? 'plain'}`;
  const defs = {};
  if (wind) defs.TREE_BARK = '';
  if (OPTS.pom) defs.USE_POM = '';
  if (detail === 'birch') defs.BIRCH_DETAIL = '';
  mat.defines = defs;
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
    uPomG: { value: 0.045 },
  };
  mat.userData.uniforms = u;
  if (OPTS.pom) mat.defines = { USE_POM: '' };
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
uniform float uPomG;
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
#ifdef USE_POM
  {
    vec3 pV = normalize(cameraPosition - vWP);
    float pDist = length(cameraPosition - vWP);
    float pFade = (1.0 - smoothstep(4.0, 10.0, pDist)) * uPomG;
    if (pFade > 0.0001 && pV.y > 0.08) {
      float mB = smoothstep(0.42, 0.58, clamp(eco.r + (nz.r - 0.5) * 0.7, 0.0, 1.0));
      vec2 pddx = dFdx(w), pddy = dFdy(w);
      const int PN = 12;
      float layer = 1.0 / float(PN);
      vec2 dW = pV.xz / pV.y * pFade * layer;
      vec2 pw = w;
      float cur = 0.0;
      float hgt = 1.0 - mix(textureGrad(uLitN, pw / 1.15, pddx / 1.15, pddy / 1.15).a, textureGrad(uMossN, pw / 1.7, pddx / 1.7, pddy / 1.7).a, mB);
      vec2 prevW = pw;
      float prevH = hgt;
      for (int i = 0; i < PN; i++) {
        if (cur >= hgt) break;
        prevW = pw;
        prevH = hgt;
        pw -= dW;
        cur += layer;
        hgt = 1.0 - mix(textureGrad(uLitN, pw / 1.15, pddx / 1.15, pddy / 1.15).a, textureGrad(uMossN, pw / 1.7, pddx / 1.7, pddy / 1.7).a, mB);
      }
      float after = hgt - cur;
      float before = prevH - (cur - layer);
      w = mix(pw, prevW, clamp(after / (after - before + 1e-5), 0.0, 1.0));
    }
  }
#endif
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
  mat.customProgramCacheKey = () => `ground-${OPTS.pom ? 'pom' : 'flat'}`;
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
