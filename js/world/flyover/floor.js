import * as THREE from 'three';
import { heightAt } from '../terrain.js';
import { groundMaterial } from '../materials.js';
import { smoothstep, fbm2, noise2, mulberry32 } from '../../lib/random.js';
import { PATCH, SPOTS, fromPatch, toPatch, patchFade, inPatch, heroHeightAt, heroNormalAt, monthOf } from './config.js';
import { FLOOR_MAP, FLOOR_DEPTH, bakeFloorTextures, floorTextureSize } from './floor-bake.js';

// The moss carpet stands up to ~4 cm above the floor; winter snow drapes over it. Guarded like litter.js:
// without moss.js the snow lies on the bare floor relief.
let MOSS_API = null;
try {
  MOSS_API = await import('./moss.js');
} catch {
  MOSS_API = null;
}
const mossTopAt = typeof MOSS_API?.mossTopAt === 'function' ? MOSS_API.mossTopAt : null;

// The forest floor under the flyover: a fine mesh over the hero patch that follows heroHeightAt, shaded with
// the regular ground material plus a baked close-up layer (old pine needles on dark moist duff, bark crumbs,
// twig bits, birch-leaf skeletons, lichen, grit) that fades in toward the patch core and near the camera.
// At the patch border the mesh lies exactly on the terrain mesh and shades exactly like it, so the seam vanishes.

const f5 = (x) => x.toFixed(5);

// ── tuning ──────────────────────────────────────────────────
export const FLOOR = {
  sink: 0.06, // how far the regular terrain sinks under the patch core (m), see sinkTerrain()
  sinkFade: [0.7, 1.0], // patchFade range over which it sinks (late, so the border triangles stay put)
  matchEnd: 0.5, // below this patchFade the floor bends onto the rendered terrain mesh
  layerFade: [0.5, 0.95], // patchFade range over which the close-up layer fades in
  clearance: [0.002, 0.007], // floor height above the sunken terrain (m) over which the close-up layer may show
  distFade: [2.6, 5.2], // camera distance (m) over which the close-up layer gives way to the regular ground
  farOff: [6.5, 8.5], // camera → patch centre distance (m) beyond which the close-up layer is skipped entirely
  match: 0.5, // 0 … 1: how far the close-up brightness is pulled toward the regular needle litter
  ao: 1.0, // height-based ambient occlusion in the needle mat
  microShadow: 0.9, // baked needle-on-needle sun shadows
  normal: 1.0, // strength of the close-up normals
  mossKeep: 0.85, // where the ground is moss, only the top needles and debris lie over it
  pomDepth: 1.0, // parallax depth on high / ultra (× FLOOR_DEPTH)
  // winter
  snowRelief: 1.4, // the snow's soft bumps over moss hummocks, shrub clumps, lichen cushions and buried litter
  snowThin: 0.55, // how much less snow lies under crowns that hold it, in tree wells and toward the edges
  snowRipple: 0.0016, // wind-ripple amplitude (m), only where the snow lies open
  snowPits: 0.3, // chance per 25 cm cell of a pit where a clump fell from the branches (more under crowns)
  snowGrain: 0.8, // granular crust at millimetre scale (normal strength)
  snowSparkle: 0.7, // ice crystals glinting in the sun (density, clustered on the crust)
  snowSSS: 0.8, // light wrapping past the terminator of bumps, a cool translucent glow
};

// Under the snow: spots that make a mound (patch spot name → mound height, m).
const SNOW_MOUNDS = {
  bilberry: 0.06,
  lingon: 0.035,
  fernLeft: 0.03,
  fernRight: 0.03,
  fiddleheadsA: 0.015,
  fiddleheadsB: 0.012,
  twinflower: 0.012,
  woodSorrel: 0.01,
  reindeerLichen1: 0.035,
  reindeerLichen2: 0.03,
  haircapMoss: 0.015,
};
// How much snow a crown holds and how far it reaches (m at scale 1); bare birches hold a little in their twigs.
const CROWNS = { spruce: [0.85, 2.6], young: [0.7, 1.5], pine: [0.45, 3.0], birch: [0.12, 2.6], youngBirch: [0.06, 1.3] };

// Vertex spacing (m): fine over the glide footprint, coarser toward the patch border.
const TIERS = {
  ultra: { core: 0.0082, outer: 0.03 },
  high: { core: 0.009, outer: 0.032 },
  medium: { core: 0.014, outer: 0.04 },
  low: { core: 0.024, outer: 0.05 },
};
// Fine region in patch coordinates: the camera footprint during the glide (|u| ≤ 1.35, |v| ≤ 0.63 at 16:9).
const FINE_U = [1.42, 1.7];
const FINE_V = [0.66, 0.86];

// ── terrain: the sunken regular ground and its exact surface ─

/** Depth (m) the regular terrain is lowered by at patchFade f. */
export function sinkDepth(f) {
  return FLOOR.sink * smoothstep(FLOOR.sinkFade[0], FLOOR.sinkFade[1], f);
}

/**
 * Lower the regular ground geometry under the patch so the close-up floor always lies on top of it.
 * Call once on the terrain geometry, before buildFloor(). Normals stay as they are on purpose: the strip
 * near the border keeps exactly the shading it had, and the sunken core is hidden under the floor anyway.
 */
export function sinkTerrain(geometry) {
  if (geometry.userData.flyoverSunk) return geometry;
  const pos = geometry.getAttribute('position');
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const z = pos.getZ(k);
    if (!inPatch(x, z)) continue;
    const d = sinkDepth(patchFade(x, z));
    if (d > 0) pos.setY(k, pos.getY(k) - d);
  }
  pos.needsUpdate = true;
  geometry.computeBoundingSphere();
  geometry.userData.flyoverSunk = true;
  return geometry;
}

/** 'sunk' (by sinkTerrain), 'lowered' (by other code), 'plain' (untouched) or null (no grid found). */
export function terrainState(mesh) {
  const pos = mesh?.geometry?.getAttribute?.('position');
  if (!pos) return null;
  if (mesh.geometry.userData.flyoverSunk) return 'sunk';
  let lowered = 0;
  let core = 0;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const z = pos.getZ(k);
    if (!inPatch(x, z) || patchFade(x, z) < 0.999) continue;
    core++;
    if (pos.getY(k) < heightAt(x, z) - 0.004) lowered++;
  }
  return core === 0 ? null : lowered > core * 0.5 ? 'lowered' : 'plain';
}

const IDENTITY = new THREE.Matrix4();

/**
 * The regular ground as the GPU draws it (the warped grid from terrain.js groundGeometry): height and normal
 * interpolated over the very triangle that holds (x, z). Returns null if the mesh is not such a grid.
 * `pendingSink`: answer as if sinkTerrain() had already been applied.
 */
export function terrainSurface(mesh, { pendingSink = false } = {}) {
  const g = mesh?.geometry;
  const pos = g?.getAttribute?.('position');
  const nor = g?.getAttribute?.('normal');
  const ix = g?.index?.array;
  if (!pos || !nor || !ix) return null;
  const n = Math.round(Math.sqrt(pos.count));
  if (n < 3 || n * n !== pos.count || ix.length < 6) return null;
  mesh.updateMatrixWorld?.(true);
  if (mesh.matrixWorld && !mesh.matrixWorld.equals(IDENTITY)) return null;
  // a regular grid: vertex (i, j) at (xs[i], zs[j]), quads split into (a, c, b) and (b, c, d)
  if (ix[0] !== 0 || ix[1] !== n || ix[2] !== 1 || ix[3] !== 1 || ix[4] !== n || ix[5] !== n + 1) return null;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = pos.getX(i);
  for (let j = 0; j < n; j++) zs[j] = pos.getZ(j * n);
  for (let i = 1; i < n; i++) if (!(xs[i] > xs[i - 1]) || !(zs[i] > zs[i - 1])) return null;
  for (const k of [n + 1, (n >> 1) * n + (n >> 2), n * n - 2]) {
    if (pos.getX(k) !== xs[k % n] || pos.getZ(k) !== zs[Math.floor(k / n)]) return null;
  }
  const find = (arr, v) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (arr[m] <= v) lo = m;
      else hi = m;
    }
    return lo;
  };
  const cache = new Map();
  const vy = (k) => {
    if (!pendingSink) return pos.getY(k);
    let y = cache.get(k);
    if (y === undefined) {
      const x = xs[k % n];
      const z = zs[Math.floor(k / n)];
      y = pos.getY(k) - (inPatch(x, z) ? sinkDepth(patchFade(x, z)) : 0);
      cache.set(k, y);
    }
    return y;
  };
  return (x, z, outN = null) => {
    if (x < xs[0] || x > xs[n - 1] || z < zs[0] || z > zs[n - 1]) return null;
    const i = find(xs, x);
    const j = find(zs, z);
    const fx = (x - xs[i]) / (xs[i + 1] - xs[i]);
    const fz = (z - zs[j]) / (zs[j + 1] - zs[j]);
    const a = j * n + i;
    let p, q, r, wp, wq, wr;
    if (fx + fz <= 1) {
      p = a; q = a + 1; r = a + n; // a, b, c
      wq = fx; wr = fz; wp = 1 - fx - fz;
    } else {
      p = a + n + 1; q = a + n; r = a + 1; // d, c, b
      wq = 1 - fx; wr = 1 - fz; wp = fx + fz - 1;
    }
    if (outN) {
      outN.set(
        nor.getX(p) * wp + nor.getX(q) * wq + nor.getX(r) * wr,
        nor.getY(p) * wp + nor.getY(q) * wq + nor.getY(r) * wr,
        nor.getZ(p) * wp + nor.getZ(q) * wq + nor.getZ(r) * wr,
      ).normalize();
    }
    return vy(p) * wp + vy(q) * wq + vy(r) * wr;
  };
}

// ── winter: the snow field, shared with the moss, litter and life modules ──

/**
 * The snow model. One field over the patch (RGBA8, 2.5 cm texels, s along u, t along v):
 *   R  G  what the snow lies on, m above heroHeightAt (moss carpet top, mounds, buried lumps) = R × gScale
 *   G  e  its relative elevation over the surrounding ~10 cm, floor micro relief included, m = (G − 0.5) × eScale
 *   B  thin: less snow under crowns that hold it, in the wells round the trunks, toward the edges = B × tScale
 *   A  canopy 0 … 1 (clumps fall from it and leave pits)
 * From it, for a season snow value (sp.snow):
 *   sEff      = clamp(snow − thin × thinning × (1 − 0.75 smoothstep(0.9, 1, snow)), 0, 1)
 *   depth     = SNOW.depth × smoothstep(SNOW.start, 1, sEff)^1.5            (m, where the snow lies level)
 *   thickness = depth − (1 − SNOW.drape) × e − SNOW.lag × (1 − smoothstep(0, SNOW.lagDepth, depth))
 *                                                                         (m; ≤ 0: the top pokes out)
 *   surface   = G + max(thickness, 0)                                     (m above heroHeightAt)
 *   dusting   = SNOW.dust × smoothstep(0.03, 0.45, sEff) of open, up-facing surfaces carry snow grains
 * Hollows fill first, hummock tops, clumps and cones poke out longest, tree wells stay thin.
 * GLSL: SNOW_FIELD_GLSL (floorSnowAt); CPU: snowDepthAt (the field the floor built last).
 */
export const SNOW = {
  depth: 0.09, // m of snow at full winter where nothing thins it
  start: 0.22, // effective snow below which only a dusting lies
  drape: 0.45, // 0: snow fills hollows level, like water … 1: it follows every bump
  lag: 0.008, // m: the first snow lies only in the deepest hollows; this lag is gone once lagDepth has fallen
  lagDepth: 0.015,
  dust: 0.75, // dusting coverage of open, up-facing surfaces
  texel: 0.025, // m
  gScale: 0.08,
  eScale: 0.06,
  tScale: 1.5,
};

export const SNOW_FIELD_GLSL = /* glsl */ `
uniform sampler2D tSnowField;
uniform vec4 uSnowMapA; // patch centre x, z; 1 / patch length, 1 / patch width
uniform vec4 uSnowMapB; // patch u axis (x, z), v axis (x, z)
uniform vec4 uSnowK; // sp.snow, thinning, depth at full snow (m), drape
// (what the snow lies on (m), relative elevation (m), thin, canopy) at world x, z
vec4 floorSnowField(vec2 xz) {
  vec2 d = xz - uSnowMapA.xy;
  vec2 st = vec2(dot(d, uSnowMapB.xy) * uSnowMapA.z, dot(d, uSnowMapB.zw) * uSnowMapA.w) + 0.5;
  vec4 f = textureLod(tSnowField, st, 0.0);
  return vec4(f.r * ${f5(SNOW.gScale)}, (f.g - 0.5) * ${f5(SNOW.eScale)}, f.b * ${f5(SNOW.tScale)}, f.a);
}
// (snow surface above heroHeightAt (m), thickness (m, ≤ 0 bare), effective snow 0 … 1, canopy) from the field
vec4 floorSnowFrom(vec4 f) {
  float sEff = clamp(uSnowK.x - f.z * uSnowK.y * (1.0 - 0.75 * smoothstep(0.9, 1.0, uSnowK.x)), 0.0, 1.0);
  float depth = uSnowK.z * pow(smoothstep(${f5(SNOW.start)}, 1.0, sEff), 1.5);
  float t = depth - (1.0 - uSnowK.w) * f.y - ${f5(SNOW.lag)} * (1.0 - smoothstep(0.0, ${f5(SNOW.lagDepth)}, depth));
  return vec4(f.x + max(t, 0.0), t, sEff, f.w);
}
vec4 floorSnowAt(vec2 xz) { return floorSnowFrom(floorSnowField(xz)); }
// the mean dusting coverage of open, up-facing surfaces
float floorSnowDust(float sEff) { return ${f5(SNOW.dust)} * smoothstep(0.03, 0.45, sEff); }
// (private helpers of the dusting, own names so they never clash with the includer's)
float fsdHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float fsdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fsdHash(i), fsdHash(i + vec2(1.0, 0.0)), f.x), mix(fsdHash(i + vec2(0.0, 1.0)), fsdHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fsdBlob(vec2 e, vec2 o, float r) { return 1.0 - smoothstep(0.67 * r, r, length(e - o)); }
// one clump of flakes per cell (q in cell units), present with probability pres: two or three overlapping blobs,
// mostly tiny, a few up to ≈ 4 mm across, some drawn out; soft over the outer third, the small ones translucent
float fsdTuft(vec2 q, float pres, float seed) {
  vec2 id = floor(q) + seed;
  if (fsdHash(id) >= pres) return 0.0;
  float hs = fsdHash(id + 5.1);
  float r = mix(0.06, 0.3, hs * hs * hs); // cells (4 mm): many tiny, few big
  float stretch = 1.0 + 0.9 * step(0.55, fsdHash(id + 7.7)) * (1.0 - smoothstep(0.1, 0.2, r));
  float room = max(0.49 - 1.56 * r * stretch, 0.0); // the clump stays inside its cell
  vec2 c = 0.5 + (vec2(fsdHash(id + 17.3), fsdHash(id + 9.7)) - 0.5) * 2.0 * room;
  vec2 d = fract(q) - c;
  float a = fsdHash(id + 3.3) * 6.2832;
  vec2 e = vec2((cos(a) * d.x + sin(a) * d.y) / stretch, cos(a) * d.y - sin(a) * d.x);
  vec2 o1 = (vec2(fsdHash(id + 11.1), fsdHash(id + 13.7)) - 0.5) * r;
  vec2 o2 = (vec2(fsdHash(id + 23.9), fsdHash(id + 29.1)) - 0.5) * r;
  float b1 = fsdBlob(e, o1, r * mix(0.45, 0.85, fsdHash(id + 19.3)));
  float b2 = fsdBlob(e, o2, r * mix(0.4, 0.8, fsdHash(id + 31.3))) * step(0.4, fsdHash(id + 37.7));
  return max(fsdBlob(e, vec2(0.0), r), max(b1, b2)) * mix(0.5, 0.95, smoothstep(0.08, 0.24, r));
}
/**
 * Snow grains of a dusting at world xz, 0 … 1: the flakes lie in loose clouds 2–6 cm across, as irregular clumps
 * of 1–4 mm (many tiny, few big, soft-edged, the small ones translucent) that run together into granular cover
 * in the cloud cores, with only a few single grains between the clouds.
 *   sEff        effective snow there (floorSnowAt(xz).z)
 *   up          how open the surface is to the sky, 0 … 1 (e.g. normal.y² × ambient occlusion)
 *   footprintM  the pixel's footprint in metres (max(length(dFdx(xz)), length(dFdy(xz)))): wider than a tuft,
 *               the same mean coverage comes back as a smooth value, so nothing shimmers
 */
float floorSnowDustAt(vec2 xz, float sEff, float up, float footprintM) {
  float p = floorSnowDust(sEff) * clamp(up, 0.0, 1.0);
  if (p < 0.0005) return 0.0;
  float n = 0.65 * fsdNoise(xz * 28.0) + 0.35 * fsdNoise(xz * 61.0 + 7.3);
  float cloud = smoothstep(0.38, 0.72, n + (p - 0.4) * 0.5);
  float dens = clamp(p * (0.15 + 1.6 * cloud), 0.0, 1.0);
  // two staggered layers of clumps on 4 mm cells, sparse between the clouds
  float pres = clamp(dens / 0.08, 0.0, 1.0) * 0.75;
  vec2 g = xz * 250.0;
  float tufts = max(fsdTuft(g, pres, 1.7), fsdTuft(g + vec2(0.5, 0.37), pres, 31.9));
  // in the clouds the flakes run together into granular cover with ragged holes, never a smooth sheet
  float core = smoothstep(0.05, 0.7, dens);
  float th = 0.97 - 0.75 * core;
  float vn = 0.6 * fsdNoise(xz * 300.0) + 0.4 * fsdNoise(xz * 800.0 + 3.7);
  float near = max(tufts, smoothstep(th, th + 0.1, vn) * mix(0.6, 0.95, core));
  // … and the same mean coverage once a pixel is wider than a clump
  float tA = pres * 0.04;
  float far = 1.0 - (1.0 - tA) * (1.0 - tA) * (1.0 - 0.88 * smoothstep(0.32, 1.02, core));
  // a few loose single grains (≈ 0.9 mm cells, translucent), fewer inside the clouds than between them
  vec2 sg = xz * 1100.0;
  float grain = step(fsdHash(floor(sg) + 3.1), p * 0.03 * (1.0 - 0.6 * cloud)) * 0.6 * (1.0 - smoothstep(0.15, 0.4, length(fract(sg) - 0.5)));
  grain *= 1.0 - smoothstep(0.0006, 0.0015, footprintM);
  return max(mix(near, far, smoothstep(0.0015, 0.0045, footprintM)), grain);
}
/**
 * Lying snow over a surface point h metres above heroHeightAt, at world xz: coverage 0 … 1.
 * The snow over the point is min(snow surface − h, snow thickness), so what sticks out of thin snow stays free
 * and nothing is buried where no snow lies. Its surface is ragged over a few cm and grain by grain, and across
 * a band of ±3 mm around it the cover breaks into granular clumps and grains, never a clean outline. A pixel
 * wider than the grains gets the same mean coverage as a smooth value. From thin first snow in the hollows to
 * deep January snow.
 */
float floorSnowLieAt(vec2 xz, float h, float footprintM) {
  vec4 s = floorSnowAt(xz);
  if (s.y < -0.012) return 0.0;
  float fine = 1.0 - smoothstep(0.001, 0.003, footprintM); // grain-sized detail fades once a pixel is wider
  float rag = (fsdNoise(xz * 36.0 + 1.3) - 0.5) * 0.008 + (fsdNoise(xz * 330.0 + 5.9) - 0.5) * 0.003 * fine;
  float t = min(s.x - h, s.y) + rag; // m of snow over the point
  float k = clamp(t / 0.006 + 0.5, 0.0, 1.0); // across the ±3 mm band
  float vn = 0.6 * fsdNoise(xz * 300.0) + 0.4 * fsdNoise(xz * 800.0 + 3.7);
  float th = mix(0.85, 0.06, k); // fully under: no holes left
  float near = smoothstep(th - 0.05, th + 0.05, vn);
  // and stray clumps just beyond the edge
  near = max(near, fsdTuft(xz * 250.0, smoothstep(0.0, 0.5, k) * 0.6, 7.3) * step(k, 0.98));
  return mix(near, k, smoothstep(0.0015, 0.0045, footprintM));
}
/**
 * The crust of a snow surface at world xz: (tone, slope x, slope z). Tone ≈ 0.96 … 1.04 (multiply the snow
 * colour); the slopes (−∂h/∂x, −∂h/∂z) are a gentle undulation over a few cm plus the grain, which fades out
 * once a pixel is wider than a grain. Add them to the snow surface's normal (normal += vec3(sx, 0, sz)).
 */
vec3 floorSnowSurf(vec2 xz, float footprintM) {
  float e = 0.0016;
  float c0 = fsdNoise(xz * 40.0 + 2.1);
  float cx = fsdNoise((xz + vec2(e, 0.0)) * 40.0 + 2.1);
  float cz = fsdNoise((xz + vec2(0.0, e)) * 40.0 + 2.1);
  float gk = 1.0 - smoothstep(0.0006, 0.0016, footprintM);
  float g0 = fsdNoise(xz * 1400.0 + 9.1);
  float gx = fsdNoise((xz + vec2(0.0005, 0.0)) * 1400.0 + 9.1);
  float gz = fsdNoise((xz + vec2(0.0, 0.0005)) * 1400.0 + 9.1);
  vec2 sl = -vec2(cx - c0, cz - c0) * 1.6 - vec2(gx - g0, gz - g0) * 0.5 * gk;
  return vec3(0.96 + 0.08 * mix(0.5, g0, gk), sl);
}
`;

/**
 * Build the snow field over the patch (CPU). → { texture (THREE.DataTexture), data, W, H,
 * sample(u, v) → { G, e, thin, canopy, sx, sz } (floats; slopes of G in world x, z), depthAt(x, z, snow) }.
 */
export async function snowField({ trees = [], tick = null } = {}) {
  const W = Math.round((2 * PATCH.halfL) / SNOW.texel);
  const H = Math.round((2 * PATCH.halfW) / SNOW.texel);
  const du = (2 * PATCH.halfL) / W;
  const dv = (2 * PATCH.halfW) / H;
  const n = W * H;
  const raw = new Float32Array(n);
  const relief = new Float32Array(n);
  const thin = new Float32Array(n);
  const canopy = new Float32Array(n);
  const C = PATCH.center;
  const near = trees.filter((t) => Math.hypot(t.x - C.x, t.z - C.y) < 10);
  const mounds = Object.entries(SNOW_MOUNDS).filter(([name]) => SPOTS[name]).map(([name, h]) => [SPOTS[name], h]);
  // small things the snow buries on a 10 cm grid: twigs, cones, tussocks; each a soft (often long) lump
  const LC = 0.1;
  const lumpAt = (ci, cj) => {
    const r = mulberry32(((ci * 73856093) ^ (cj * 19349663) ^ 0x5eed) >>> 0);
    if (r() > 0.4) return null;
    const a = r() * Math.PI;
    return { u: (ci + r()) * LC, v: (cj + r()) * LC, ca: Math.cos(a), sa: Math.sin(a), rl: 0.025 + 0.035 * r(), rw: 0.018 + 0.012 * r(), h: 0.007 + 0.014 * r() };
  };
  const lumps = new Map();
  const lumpCell = (ci, cj) => {
    const key = ci * 100003 + cj;
    if (!lumps.has(key)) lumps.set(key, lumpAt(ci, cj));
    return lumps.get(key);
  };
  let last = performance.now();
  for (let j = 0; j < H; j++) {
    if (tick && performance.now() - last > 12) {
      await tick();
      last = performance.now();
    }
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const u = -PATCH.halfL + (i + 0.5) * du;
      const v = -PATCH.halfW + (j + 0.5) * dv;
      const { x, z } = fromPatch(u, v);
      const hero = heroHeightAt(x, z);
      let L = mossTopAt ? Math.max(0, mossTopAt(x, z) - hero) * 0.9 : 0;
      const wob = 0.15 * noise2(u * 9.1 + 3.3, v * 9.1 - 7.7);
      for (const [sp, h] of mounds) L += h * (1 - smoothstep(0.3, 1.05, Math.hypot(u - sp.u, v - sp.v) / sp.r + wob));
      // a soft undulation of the snow itself (≈ 10–15 cm) and the lumps over what it buries
      L += 0.011 * fbm2(u * 7.3 - 1.9, v * 7.3 + 4.1, 3);
      const ci = Math.floor(u / LC);
      const cj = Math.floor(v / LC);
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const q = lumpCell(ci + a, cj + b);
          if (!q) continue;
          const du0 = u - q.u;
          const dv0 = v - q.v;
          const x1 = (du0 * q.ca + dv0 * q.sa) / q.rl;
          const y1 = (-du0 * q.sa + dv0 * q.ca) / q.rw;
          L += q.h * Math.exp(-(x1 * x1 + y1 * y1));
        }
      }
      raw[k] = Math.max(0, L);
      relief[k] = hero - heightAt(x, z);
      let open = 1;
      let well = 0;
      for (const t of near) {
        const d = Math.hypot(x - t.x, z - t.z);
        const [hold, reach] = CROWNS[t.species] ?? [0.3, 2.0];
        const R = reach * (t.scale ?? 1);
        open *= 1 - hold * Math.exp(-1.5 * (d / R) * (d / R));
        well = Math.max(well, 1 - smoothstep(0.2, 0.75 + 0.35 * (t.scale ?? 1), d)); // the well round the trunk
      }
      const edge = 1 - smoothstep(0.0, 0.5, Math.min(PATCH.halfL - Math.abs(u), PATCH.halfW - Math.abs(v)));
      canopy[k] = 1 - open;
      const base = Math.min(1, Math.max(0, 0.8 * canopy[k] + well + 0.3 * edge + 0.25 * fbm2(u * 3.1 + 7.7, v * 3.1 - 2.9, 3)));
      // patchy at ≈ 20–30 cm, so thin spots open here and there rather than everywhere at once
      thin[k] = base * (0.5 + Math.min(1, Math.max(0, 0.5 + 0.8 * fbm2(u * 2.9 + 5.3, v * 2.9 - 1.1, 2))));
    }
  }
  // separable box blur, edges clamped
  const box = (src, r) => {
    const tmp = new Float32Array(n);
    const out = new Float32Array(n);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let acc = 0;
        for (let o = -r; o <= r; o++) acc += src[j * W + Math.min(W - 1, Math.max(0, i + o))];
        tmp[j * W + i] = acc / (2 * r + 1);
      }
    }
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let acc = 0;
        for (let o = -r; o <= r; o++) acc += tmp[Math.min(H - 1, Math.max(0, j + o)) * W + i];
        out[j * W + i] = acc / (2 * r + 1);
      }
    }
    return out;
  };
  const G = box(raw, 1); // snow rounds everything off (≈ 2.5 cm)
  const Q = new Float32Array(n);
  for (let k = 0; k < n; k++) Q[k] = G[k] + relief[k];
  const Qs = box(box(Q, 4), 4); // the surroundings (≈ 10 cm)
  const data = new Uint8Array(n * 4);
  const byte = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  for (let k = 0; k < n; k++) {
    data[k * 4] = byte(G[k] / SNOW.gScale);
    data[k * 4 + 1] = byte((Q[k] - Qs[k]) / SNOW.eScale + 0.5);
    data[k * 4 + 2] = byte(thin[k] / SNOW.tScale);
    data[k * 4 + 3] = byte(canopy[k]);
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // read back exactly as the GPU's linear filter does (texel centres, clamped)
  const lin = (c, s, t) => {
    const x = s * W - 0.5;
    const y = t * H - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const px = (ii, jj) => data[(Math.min(H - 1, Math.max(0, jj)) * W + Math.min(W - 1, Math.max(0, ii))) * 4 + c] / 255;
    return (px(i, j) * (1 - fx) + px(i + 1, j) * fx) * (1 - fy) + (px(i, j + 1) * (1 - fx) + px(i + 1, j + 1) * fx) * fy;
  };
  const at = (arr, u, v) => {
    const x = (u + PATCH.halfL) / du - 0.5;
    const y = (v + PATCH.halfW) / dv - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const px = (ii, jj) => arr[Math.min(H - 1, Math.max(0, jj)) * W + Math.min(W - 1, Math.max(0, ii))];
    return (px(i, j) * (1 - fx) + px(i + 1, j) * fx) * (1 - fy) + (px(i, j + 1) * (1 - fx) + px(i + 1, j + 1) * fx) * fy;
  };
  return {
    texture,
    data,
    W,
    H,
    /** Float values at patch (u, v), and the slope of what the snow lies on (−∇G, world x, z). */
    sample(u, v, out = {}) {
      out.G = at(G, u, v);
      out.e = at(Q, u, v) - at(Qs, u, v);
      out.thin = at(thin, u, v);
      out.canopy = at(canopy, u, v);
      const gu = (at(G, u + du, v) - at(G, u - du, v)) / (2 * du);
      const gv = (at(G, u, v + dv) - at(G, u, v - dv)) / (2 * dv);
      out.sx = -(gu * PATCH.u.x + gv * PATCH.v.x);
      out.sz = -(gu * PATCH.u.y + gv * PATCH.v.y);
      return out;
    },
    /** The snow at world (x, z) for sp.snow: exactly what floorSnowAt computes on the GPU. */
    depthAt(x, z, snow, out = {}) {
      const { u, v } = toPatch(x, z);
      const s = u / (2 * PATCH.halfL) + 0.5;
      const t = v / (2 * PATCH.halfW) + 0.5;
      const g = lin(0, s, t) * SNOW.gScale;
      const e = (lin(1, s, t) - 0.5) * SNOW.eScale;
      const th = lin(2, s, t) * SNOW.tScale;
      const sEff = Math.min(1, Math.max(0, snow - th * FLOOR.snowThin * (1 - 0.75 * smoothstep(0.9, 1, snow))));
      const depth = SNOW.depth * Math.pow(smoothstep(SNOW.start, 1, sEff), 1.5);
      const thick = depth - (1 - SNOW.drape) * e - SNOW.lag * (1 - smoothstep(0, SNOW.lagDepth, depth));
      out.surface = g + Math.max(thick, 0);
      out.thickness = thick;
      out.sEff = sEff;
      out.canopy = lin(3, s, t);
      out.dust = SNOW.dust * smoothstep(0.03, 0.45, sEff);
      return out;
    },
  };
}

let lastSnowField = null;

/**
 * The floor's snow at world (x, z) for sp.snow (CPU, for litter and life): { surface (m above heroHeightAt),
 * thickness (m, ≤ 0 bare), sEff, canopy, dust }. Bare until buildFloor has run.
 */
export function snowDepthAt(x, z, snow, out = {}) {
  if (lastSnowField) return lastSnowField.depthAt(x, z, snow, out);
  out.surface = 0;
  out.thickness = -1;
  out.sEff = 0;
  out.canopy = 0;
  out.dust = 0;
  return out;
}

// ── the mesh ────────────────────────────────────────────────

// Grid coordinates along one patch axis: spacing s0 inside |a| ≤ inner, easing to s1 beyond outer.
function axisCoords(half, inner, outer, s0, s1) {
  const M = 8192;
  const da = (2 * half) / M;
  const cum = new Float64Array(M + 1);
  const spacing = (a) => s0 + (s1 - s0) * smoothstep(inner, outer, Math.abs(a));
  for (let k = 0; k < M; k++) cum[k + 1] = cum[k] + da / spacing(-half + (k + 0.5) * da);
  const N = Math.max(2, Math.round(cum[M] / 2) * 2);
  const out = new Float64Array(N + 1);
  let k = 0;
  for (let i = 0; i <= N; i++) {
    const target = (i / N) * cum[M];
    while (k < M - 1 && cum[k + 1] < target) k++;
    const t = (target - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-12);
    out[i] = -half + (k + Math.min(1, Math.max(0, t))) * da;
  }
  out[0] = -half;
  out[N] = half;
  return out;
}

/** Grid size per tier, without building anything. */
export function floorGridSize(tier = 'medium') {
  const t = TIERS[tier] ?? TIERS.medium;
  const nu = axisCoords(PATCH.halfL, FINE_U[0], FINE_U[1], t.core, t.outer).length;
  const nv = axisCoords(PATCH.halfW, FINE_V[0], FINE_V[1], t.core, t.outer).length;
  return { nu, nv, vertices: nu * nv, triangles: 2 * (nu - 1) * (nv - 1) };
}

/**
 * The floor mesh: a grid in the patch frame covering the whole patch (fade band included).
 * Positions from heroHeightAt, normals from heroNormalAt; in the outer fade band both bend onto the rendered
 * terrain (`terrain` from terrainSurface) so the border matches it exactly. Attributes: position, normal,
 * uv (world x, z, like the ground) and aFloor = (hollowness: −1 on bumps … +1 in hollows, where snow lies
 * deeper; clearance 0 … 1 above the sunken terrain, which gates the close-up layer) and
 * aSnow = slope of what the snow lies on (world x and z), see snowField(). Also returns that snow field.
 * Pure CPU work; `tick` (optional async) is awaited now and then so the loader stays responsive.
 */
export async function buildFloorGeometry({ tier = 'medium', terrain = null, tick = null, trees = [] } = {}) {
  const t = TIERS[tier] ?? TIERS.medium;
  const us = axisCoords(PATCH.halfL, FINE_U[0], FINE_U[1], t.core, t.outer);
  const vs = axisCoords(PATCH.halfW, FINE_V[0], FINE_V[1], t.core, t.outer);
  const nu = us.length;
  const nv = vs.length;
  const count = nu * nv;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const hgt = new Float64Array(count);
  const clear = new Float32Array(count).fill(1);
  const nh = new THREE.Vector3();
  const nt = new THREE.Vector3();
  let matched = 0;
  let last = performance.now();
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      const { x, z } = fromPatch(us[i], vs[j]);
      let y = heroHeightAt(x, z);
      heroNormalAt(x, z, 0.01, nh);
      const f = patchFade(x, z);
      const ty = terrain ? terrain(x, z, f < FLOOR.matchEnd ? nt : null) : null;
      if (ty !== null && f < FLOOR.matchEnd) {
        // ease from the hero surface onto the terrain mesh as drawn (exact at the border, where f = 0)
        const wT = 1 - smoothstep(0, FLOOR.matchEnd, f);
        y += (ty - heightAt(x, z)) * wT;
        nh.lerp(nt, wT).normalize();
        matched++;
      }
      // where the sunken terrain comes close to (or through) the floor, the close-up layer gives way to the
      // regular look, so the terrain showing through can never be told apart
      if (ty !== null) clear[k] = smoothstep(FLOOR.clearance[0], FLOOR.clearance[1], y - ty);
      hgt[k] = y;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      nor[k * 3] = nh.x;
      nor[k * 3 + 1] = nh.y;
      nor[k * 3 + 2] = nh.z;
      uv[k * 2] = x;
      uv[k * 2 + 1] = z;
    }
    if (tick && performance.now() - last > 12) {
      await tick();
      last = performance.now();
    }
  }

  // the snow surface: what it drapes over, where it lies thin
  const snow = await snowField({ trees: trees ?? [], tick });
  const aSnow = new Float32Array(count * 2);
  const sv = {};
  const surf = new Float64Array(count);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      snow.sample(us[i], vs[j], sv);
      aSnow[k * 2] = sv.sx;
      aSnow[k * 2 + 1] = sv.sz;
      surf[k] = hgt[k] + sv.G;
    }
  }
  if (tick) await tick();

  // hollowness: the Laplacian of the (snow) surface over ±3 cm (snow drifts into hollows, thins on bumps)
  const aFloor = new Float32Array(count * 2);
  const reach = (arr, i, dir) => {
    let m = i;
    while (m + dir >= 0 && m + dir < arr.length && Math.abs(arr[m] - arr[i]) < 0.03) m += dir;
    return m;
  };
  const iu0 = new Int32Array(nu), iu1 = new Int32Array(nu), iv0 = new Int32Array(nv), iv1 = new Int32Array(nv);
  for (let i = 0; i < nu; i++) { iu0[i] = reach(us, i, -1); iu1[i] = reach(us, i, 1); }
  for (let j = 0; j < nv; j++) { iv0[j] = reach(vs, j, -1); iv1[j] = reach(vs, j, 1); }
  const lap1 = (h0, hm, hp, dm, dp) => (dm > 0 && dp > 0 ? (2 / (dm + dp)) * ((hp - h0) / dp - (h0 - hm) / dm) : 0);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      const h0 = surf[k];
      const lu = lap1(h0, surf[j * nu + iu0[i]], surf[j * nu + iu1[i]], us[i] - us[iu0[i]], us[iu1[i]] - us[i]);
      const lv = lap1(h0, surf[iv0[j] * nu + i], surf[iv1[j] * nu + i], vs[j] - vs[iv0[j]], vs[iv1[j]] - vs[j]);
      aFloor[k * 2] = Math.max(-1, Math.min(1, (lu + lv) / 24));
    }
  }
  // the clearance gate: eroded over two rings of neighbours, then softened over one, so every triangle that
  // touches a tight spot stays fully closed while the open areas fade in over a few centimetres
  const ring = (src, r, op) => {
    const out = new Float32Array(count);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        let acc = op === 'min' ? 1 : 0;
        let n = 0;
        for (let b = Math.max(0, j - r); b <= Math.min(nv - 1, j + r); b++) {
          for (let a = Math.max(0, i - r); a <= Math.min(nu - 1, i + r); a++) {
            const val = src[b * nu + a];
            if (op === 'min') acc = Math.min(acc, val);
            else acc += val;
            n++;
          }
        }
        out[j * nu + i] = op === 'min' ? acc : acc / n;
      }
    }
    return out;
  };
  const gate = ring(ring(clear, 2, 'min'), 1, 'mean');
  for (let k = 0; k < count; k++) aFloor[k * 2 + 1] = gate[k];

  // two triangles per cell, wound so they face up
  const P0 = fromPatch(0, 0);
  const Pu = fromPatch(1, 0);
  const Pv = fromPatch(0, 1);
  const up = (Pv.z - P0.z) * (Pu.x - P0.x) - (Pv.x - P0.x) * (Pu.z - P0.z) > 0;
  const tris = (nu - 1) * (nv - 1) * 2;
  const idx = count > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  let p = 0;
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      if (up) {
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      } else {
        idx[p++] = a; idx[p++] = b; idx[p++] = c;
        idx[p++] = b; idx[p++] = d; idx[p++] = c;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aFloor', new THREE.BufferAttribute(aFloor, 2));
  g.setAttribute('aSnow', new THREE.BufferAttribute(aSnow, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return { geometry: g, nu, nv, us, vs, vertices: count, triangles: tris, matched, snow };
}

// ── the material ────────────────────────────────────────────

const C = PATCH.center;
const PATCH_GLSL = {
  c: `vec2(${f5(C.x)}, ${f5(C.y)})`,
  u: `vec2(${f5(PATCH.u.x)}, ${f5(PATCH.u.y)})`,
  v: `vec2(${f5(PATCH.v.x)}, ${f5(PATCH.v.y)})`,
};

const FLOOR_PARS = /* glsl */ `
uniform sampler2D tFloorA; // albedo (sRGB) + roughness
uniform sampler2D tFloorN; // normal xy, height, ambient occlusion
uniform sampler2D tFloorS; // sun visibility (sample A, sample B), lies-on-moss mask, wetness
uniform vec4 uFloorMap; // 1 / tile A, 1 / tile B, cos and sin of sample B's rotation
uniform vec4 uFloorView; // layer strength, distance fade start, end, parallax depth (m)
uniform vec4 uFloorSeason; // wetness, dew, autumn, -
uniform vec4 uFloorTune; // brightness match, AO, micro shadows, normal strength
uniform float uFloorMoss;
uniform vec4 uFloorSnowA; // snow relief, -, ripple amplitude (m), pit chance
uniform vec4 uFloorSnowB; // grain, sparkle, translucency, -
${SNOW_FIELD_GLSL}
varying vec2 vFloor; // hollowness, clearance above the sunken terrain
varying vec2 vSnow; // slope of what the snow lies on (world x, z)
float fAO = 1.0;
float fCrust = 0.0;
float fDust = 0.0;
vec3 fSnowN = vec3(0.0, 1.0, 0.0);
float fSunVis = 1.0;
float fSnow = 0.0;
float fGlint = 0.0;
float fBaseGlint = 1.0;
float fTop = 0.0;
float fFoot = 1.0;
vec2 fW = vec2(0.0);
vec2 floorRotB(vec2 p) { return vec2(uFloorMap.z * p.x - uFloorMap.w * p.y, uFloorMap.w * p.x + uFloorMap.z * p.y); }
vec2 floorRotBInv(vec2 p) { return vec2(uFloorMap.z * p.x + uFloorMap.w * p.y, -uFloorMap.w * p.x + uFloorMap.z * p.y); }
// height-blend of the two samples: the higher surface wins where they meet, so needles lie over needles
float floorPickB(float hA, float hB, float mk) { return clamp((hB - hA + (mk - 0.5) * 2.4) / 0.06 + 0.5, 0.0, 1.0); }
`;

// Runs right after the regular ground has set diffuseColor, gMoss, gSnow, gRough and gN.
const FLOOR_MAIN = /* glsl */ `
{
  vec2 fd = vWP.xz - ${PATCH_GLSL.c};
  float fEdge = min(${f5(PATCH.halfL)} - abs(dot(fd, ${PATCH_GLSL.u})), ${f5(PATCH.halfW)} - abs(dot(fd, ${PATCH_GLSL.v})));
  float fFade = smoothstep(0.0, ${f5(PATCH.fade)}, fEdge);
  float fDist = length(vWP - cameraPosition);
  float fLayer = smoothstep(${f5(FLOOR.layerFade[0])}, ${f5(FLOOR.layerFade[1])}, fFade) * (1.0 - smoothstep(uFloorView.y, uFloorView.z, fDist)) * uFloorView.x * vFloor.y;
  // derivatives in uniform control flow; everything below samples with textureGrad / textureLod
  vec2 w = vWP.xz;
  vec2 dwx = dFdx(w), dwy = dFdy(w);
  fW = w;
  fFoot = max(length(dwx), length(dwy));
  if (fLayer > 0.003) {
    const vec2 oB = vec2(0.371, 0.613);
    vec2 sAx = dwx * uFloorMap.x, sAy = dwy * uFloorMap.x;
    vec2 sBx = floorRotB(dwx) * uFloorMap.y, sBy = floorRotB(dwy) * uFloorMap.y;
    // which sample shows where: a noise patchwork (≈ 20–30 cm), settled by height where the two meet
    vec4 nzP = textureLod(uNoise, w * 0.75 + vec2(0.29, 0.53), 0.0);
    float mk = smoothstep(0.455, 0.545, nzP.r);
    // winter: the shared snow field (what the snow lies on, its relief, where it lies thin) and the snow
    // it gives: surface, thickness (m, ≤ 0 bare), effective snow, canopy
    vec4 sF = vec4(0.0);
    vec4 sS = vec4(0.0, -1.0, 0.0, 0.0);
    if (uSnowK.x > 0.001) {
      sF = floorSnowField(w);
      sS = floorSnowFrom(sF);
    }
    bool buried = sS.y > 0.014; // thicker than the needle mat and its ragged edge: no need to look at it
    vec2 pw = w;
#ifdef FLOOR_POM
    if (uFloorView.w > 0.00005 && !buried) {
      // parallax through the needle mat (on the sample that dominates here): 8 layers from its top down,
      // one fetch each, then interpolate the hit
      vec3 pV = normalize(cameraPosition - vWP);
      vec2 dW = pV.xz / max(pV.y, 0.3) * (uFloorView.w * fLayer * 0.125);
      bool pB = mk > 0.5;
      vec2 pUv = pB ? floorRotB(w) * uFloorMap.y + oB : w * uFloorMap.x;
      vec2 pStep = pB ? floorRotB(dW) * uFloorMap.y : dW * uFloorMap.x;
      vec2 pgx = pB ? sBx : sAx;
      vec2 pgy = pB ? sBy : sAy;
      float lvl = 1.0;
      float k = 0.0;
      float hgt = textureGrad(tFloorN, pUv, pgx, pgy).b;
      float prevD = hgt - lvl;
      for (int i = 0; i < 8; i++) {
        if (hgt >= lvl) break;
        prevD = hgt - lvl;
        k += 1.0;
        lvl -= 0.125;
        hgt = textureGrad(tFloorN, pUv - pStep * k, pgx, pgy).b;
      }
      float t = clamp(prevD / min(prevD - (hgt - lvl), -1e-5), 0.0, 1.0);
      pw = w - dW * max(k - 1.0 + t, 0.0);
    }
#endif
    vec2 uvA = pw * uFloorMap.x;
    vec2 uvB = floorRotB(pw) * uFloorMap.y + oB;
    vec4 aA = vec4(0.0), nA = vec4(0.5, 0.5, 0.0, 1.0), sA = vec4(1.0, 1.0, 0.0, 0.0);
    vec4 aB = aA, nB = nA, sB = sA;
    if (mk < 0.9999 && !buried) {
      aA = textureGrad(tFloorA, uvA, sAx, sAy);
      nA = textureGrad(tFloorN, uvA, sAx, sAy);
      sA = textureGrad(tFloorS, uvA, sAx, sAy);
    }
    if (mk > 0.0001 && !buried) {
      aB = textureGrad(tFloorA, uvB, sBx, sBy);
      nB = textureGrad(tFloorN, uvB, sBx, sBy);
      sB = textureGrad(tFloorS, uvB, sBx, sBy);
    }
    float tB = mk <= 0.0001 ? 0.0 : (mk >= 0.9999 ? 1.0 : floorPickB(nA.b, nB.b, mk));
    vec3 col = mix(aA.rgb, aB.rgb, tB);
    float rough = mix(aA.a, aB.a, tB);
    float h = mix(nA.b, nB.b, tB);
    float ao = mix(nA.a, nB.a, tB);
    float sunVis = mix(sA.r, sB.g, tB);
    float cover = mix(sA.b, sB.b, tB);
    float wetA = mix(sA.a, sB.a, tB);
    // slopes in world xz (sample B's texture axes are rotated)
    vec2 gA = nA.rg * 2.0 - 1.0;
    gA /= sqrt(max(1.0 - dot(gA, gA), 0.04));
    vec2 gB = nB.rg * 2.0 - 1.0;
    gB = floorRotBInv(gB / sqrt(max(1.0 - dot(gB, gB), 0.04)));
    vec2 slope = mix(gA, gB, tB) * uFloorTune.w;

    // the same light and tint as the regular ground: brightness pulled toward its needle litter,
    // its macro variation (blueberry shade, damp hollows, sunburnt patches) and the season tint
    vec3 meanA = textureLod(tFloorA, vec2(0.5), 16.0).rgb; // the whole tile's average (its 1 × 1 mip)
    float lMine = dot(meanA, vec3(0.2126, 0.7152, 0.0722));
    float lBase = dot(textureLod(uLitC, vec2(0.5), 16.0).rgb, vec3(0.2126, 0.7152, 0.0722));
    float gain = mix(1.0, clamp(lBase / max(lMine, 1e-4), 0.45, 1.6), uFloorTune.x);
    col *= gain;
    vec4 eco = textureLod(uEco, (w - uEcoRect.xy) / uEcoRect.zw, 0.0);
    vec4 nzm = textureLod(uNoise, w * 0.021, 0.0);
    vec3 macro = vec3(mix(1.0, 0.62, eco.g * 0.8) * mix(1.0, 0.78, eco.b) * (0.86 + 0.28 * nzm.b));
    macro = mix(macro, macro * vec3(1.12, 1.02, 0.78), smoothstep(0.55, 0.8, nzm.g) * 0.5);
    col *= macro * uSGround;

    // damp: dark duff and low, porous litter soak up water, go darker and glossier; dew films the top needles
    float wet = clamp(uFloorSeason.x * (0.3 + 0.7 * wetA) * (1.15 - 0.6 * h) + eco.b * 0.3 * uFloorSeason.x, 0.0, 1.0);
    col *= 1.0 - 0.32 * wet;
    rough = mix(rough, rough * 0.42, wet);
    float dewFilm = uFloorSeason.y * smoothstep(0.45, 0.9, h) * (1.0 - 0.5 * wetA);
    rough = mix(rough, 0.34, dewFilm * 0.5);
    col *= 1.0 - 0.06 * dewFilm;
    fTop = h;

    // the ground under the close-up as it would be without the regular ground's own coarse snow: its colour
    // un-mixed where that snow is light, its moss fetched afresh where it is heavy
    vec3 under = diffuseColor.rgb;
    if (gSnow > 0.001) {
      vec3 un = (under - vec3(0.74, 0.77, 0.82) * gSnow) / max(1.0 - gSnow, 0.2);
      vec3 mossC = textureGrad(uMossC, w / 1.7, dwx / 1.7, dwy / 1.7).rgb * macro * uSGround;
      under = mix(max(un, vec3(0.0)), mossC, smoothstep(0.4, 0.8, gSnow));
    }
    vec2 sBase = gN.xy * 1.6 / max(gN.z, 0.25); // the slope the regular ground's normal code would apply
    // where the ground is moss, only what lies on top of it (needles, twigs, bark, lichen) shows; the bake
    // filtered each needle's edge together with the dark mat beside it, so take that share out of the colour
    // there, or every needle on the moss would carry a dark outline
    float gmK = gMoss * uFloorMoss;
    vec3 u0 = meanA * gain * macro * uSGround; // the mat's average colour, toned like col
    vec3 colN = mix(col, max((col - (1.0 - cover) * u0) / max(cover, 0.25), vec3(0.0)), gmK);
    float wN = mix(1.0, cover, gmK);
    vec3 lay = mix(under, colN, wN);
    float layRough = mix(gRough, rough, wN);
    vec2 laySlope = mix(sBase, slope, wN);
    float layAO = mix(1.0, ao, wN);
    float laySun = mix(1.0, sunVis, wN);
    float sCov = 0.0;

    // winter: snow over all of it
    if (uSnowK.x > 0.001) {
      float sEff = sS.z;
      float T = sS.y;
      // a granular crust: white-noise grains of ≈ 0.65 mm (mipmapped away with distance) …
      vec2 gu = w * 6.0;
      vec2 gdx = dwx * 6.0, gdy = dwy * 6.0;
      float g0 = textureGrad(uNoise, gu, gdx, gdy).a;
      float g1 = textureGrad(uNoise, gu + vec2(0.00390625, 0.0), gdx, gdy).a;
      float g2 = textureGrad(uNoise, gu + vec2(0.0, 0.00390625), gdx, gdy).a;
      // … on a crust that undulates over a few centimetres, wind-packed and sun-glazed in patches
      vec2 cu = w * 2.2 + vec2(0.61, 0.17);
      vec2 cdx = dwx * 2.2, cdy = dwy * 2.2;
      float c0 = textureGrad(uNoise, cu, cdx, cdy).g;
      float c1 = textureGrad(uNoise, cu + vec2(0.0035, 0.0), cdx, cdy).g;
      float c2 = textureGrad(uNoise, cu + vec2(0.0, 0.0035), cdx, cdy).g;
      fCrust = smoothstep(0.45, 0.75, nzP.g);
      // the snow fills the mat (needles where they lie, moss shoots elsewhere) from below wherever it is thick
      // enough; a few mm of noise on its thickness spread the edge over 2–6 cm of ragged, granular mat
      float hMat = mix(0.55, h, wN);
      float ragged = (c0 - 0.5) * 0.008 + (g0 - 0.5) * 0.003;
      float lvl = (T + ragged) / ${f5(FLOOR_DEPTH)};
      float fill = buried ? 1.0 : 1.0 - smoothstep(lvl - 0.12, lvl + 0.03, hMat);
      // and from the first flakes on, grains settle on whatever faces up and lies open to the sky
      float up = inversesqrt(1.0 + dot(laySlope, laySlope));
      // (tufts in loose clouds, shared with the moss: floorSnowDustAt in SNOW_FIELD_GLSL)
      // (on needle tops and moss tips more than on the flat between them: the bake's height)
      float dust = floorSnowDustAt(w, sEff, up * up * (0.45 + 0.55 * layAO) * mix(0.35, 1.0, smoothstep(0.2, 0.8, hMat)), fFoot);
      fDust = dust;
      sCov = max(fill, dust);
      // its surface: over what it buries; with depth, wind ripples where it lies open and pits where clumps
      // fell from the branches; the crust and its grain wherever there is snow
      vec2 sSlope = vSnow * uFloorSnowA.x;
      float rip = uFloorSnowA.z * smoothstep(0.45, 0.7, nzP.b) * (1.0 - smoothstep(0.15, 0.4, sF.w)) * smoothstep(0.01, 0.03, T);
      const vec2 wd = vec2(0.8, 0.6);
      float ph = dot(w, wd) * 125.0 + nzP.g * 9.0; // ≈ 5 cm, wavering
      sSlope -= wd * (rip * 125.0 * (cos(ph) + 0.35 * cos(2.0 * ph + 1.3)));
      float pitAO = 1.0;
      vec2 pc = w * 4.0; // 25 cm cells
      vec2 pid = floor(pc);
      vec3 pr = hash32(pid + 3.7);
      if (pr.x < uFloorSnowA.w * (0.35 + 0.65 * sF.w) * smoothstep(0.015, 0.04, T)) {
        float R = mix(0.025, 0.055, hash12(pid + 1.3));
        vec2 pq = (fract(pc) - 0.5 - (pr.yz - 0.5) * 0.3) * 0.25; // m from the pit's centre
        float pd = length(pq);
        // a ragged outline: the clump broke as it landed
        float pa = atan(pq.y, pq.x);
        float r = pd / (R * (1.0 + 0.2 * sin(3.0 * pa + pr.y * 6.3) + 0.12 * sin(5.0 * pa + pr.z * 6.3)));
        if (r < 1.5) {
          // a bowl with a soft raised rim: h(r) = −D (1 − r²)² + 0.3 D exp(−((r − 1.05) / 0.2)²)
          float D = R * 0.22;
          float bowl = r < 1.0 ? 4.0 * D * r * (1.0 - r * r) : 0.0;
          float e = (r - 1.05) / 0.2;
          float rim = -3.0 * D * e * exp(-e * e);
          // and lumps of the broken clump inside it
          float lump = r < 1.0 ? (c1 - c0) * 3.0 : 0.0;
          sSlope -= (pq / max(pd, 1e-5)) * ((bowl + rim) / R) + vec2(lump, (c2 - c0) * 3.0 * step(r, 1.0));
          float b = r < 1.0 ? (1.0 - r * r) : 0.0;
          pitAO = 1.0 - 0.28 * b * b;
        }
      }
      vec2 crust = vec2(c1 - c0, c2 - c0) * 1.4 + vec2(g1 - g0, g2 - g0) * uFloorSnowB.x;
      sSlope -= crust;
      // thin grains are translucent: a little greyer than lying snow, which lights the same way as everything else
      lay = mix(lay, vec3(0.74, 0.77, 0.82) * (0.96 + 0.08 * g0) * mix(0.88, 1.0, fill), sCov);
      layRough = mix(layRough, mix(0.62, 0.5, fill), sCov);
      laySlope = mix(laySlope, sSlope + laySlope * 0.12, fill) - crust * (sCov - fill) * 0.5; // a dusting keeps the shapes below
      layAO = mix(layAO, pitAO * (1.0 - 0.15 * clamp(-sF.y / 0.012, 0.0, 1.0)), fill);
      laySun = mix(laySun, 1.0, fill);
    }

    // into the regular ground: the close-up takes over toward the core and near the camera
    diffuseColor.rgb = mix(diffuseColor.rgb, lay, fLayer);
    gRough = mix(gRough, layRough, fLayer);
    vec2 sFinal = mix(sBase, laySlope, fLayer);
    gN = normalize(vec3(sFinal / 1.6, 1.0));
    fSnowN = normalize(normalize(vGN) + vec3(sFinal.x, 0.0, sFinal.y));
    fAO = mix(1.0, mix(1.0, layAO, uFloorTune.y), fLayer);
    fSunVis = mix(1.0, mix(1.0, laySun, uFloorTune.z), fLayer);
    fGlint = fLayer * max(wN, sCov);
    fSnow = sCov * fLayer;
    fDust *= fLayer;
    fBaseGlint = 1.0 - fGlint;
  }
}
`;

// After all lights: ambient occlusion, needle-on-needle sun shadows, light glowing through snow, and tiny
// glints of ice crystals and dew.
const FLOOR_LIGHT = /* glsl */ `
reflectedLight.indirectDiffuse *= fAO;
reflectedLight.indirectSpecular *= fAO;
reflectedLight.directDiffuse *= fSunVis;
reflectedLight.directSpecular *= fSunVis;
#if NUM_DIR_LIGHTS > 0
if (fSnow > 0.01) {
  // snow is translucent: sunlight wraps a little past the terminator of every bump, cool and blue-ish
  float sNL = dot(normal, directLight.direction);
  float sWrap = max((sNL + 0.45) / 1.45, 0.0) - max(sNL, 0.0);
  reflectedLight.directDiffuse += directLight.color * sWrap * BRDF_Lambert(material.diffuseColor) * vec3(0.7, 0.88, 1.0) * (fSnow * uFloorSnowB.z);
}
if (fGlint > 0.01) {
  // single ice crystals, only where the sun reaches, denser where the crust is; a few dew glints in summer
  float gDens = fSnow * uFloorSnowB.y * (0.08 + 0.92 * fCrust * fCrust) + fDust * uFloorSnowB.y * 0.25 + uFloorSeason.y * 0.05 * smoothstep(0.55, 0.9, fTop) * (1.0 - fSnow);
  if (gDens > 0.001) {
    float cs = mix(760.0, 1100.0, fSnow); // ≈ 1.3 mm (dew) … 0.9 mm (crystals) cells
    vec2 cp = fW * cs;
    vec2 cid = floor(cp);
    vec3 gr = hash32(cid + 41.0);
    if (gr.x < gDens) {
      vec2 off = (hash22(cid + 9.1) - 0.5) * 0.6;
      float rad = max(0.16, fFoot * cs * 0.6); // at least about a pixel wide
      float spot = 1.0 - smoothstep(rad * 0.4, rad, length(fract(cp) - 0.5 - off));
      // the crystal's facet tilts at random around the snow surface, so glints follow its bumps and ripples
      vec2 rr = gr.yz * 2.0 - 1.0;
      vec3 fnW = normalize(fSnowN + vec3(rr.x, 0.0, rr.y) * mix(0.6, 0.35, fSnow));
      vec3 fnV = normalize((viewMatrix * vec4(fnW, 0.0)).xyz);
      vec3 gR = reflect(-geometryViewDir, fnV);
      float gs = pow(max(dot(gR, directLight.direction), 0.0), 900.0);
      float energy = (0.16 / rad) * (0.16 / rad);
      // now and then a crystal splits the light into a colour
      float hue = hash12(cid + 5.5);
      vec3 rainbow = clamp(abs(fract(hue + vec3(0.0, 0.333, 0.667)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
      vec3 tint = mix(vec3(1.0), rainbow, step(0.75, hash12(cid + 2.2)) * 0.45 * fSnow);
      float bright = mix(25.0, 90.0, fSnow) * (0.4 + 1.2 * hash12(cid + 7.1));
      reflectedLight.directSpecular += directLight.color * tint * gs * spot * energy * fGlint * fSunVis * bright;
    }
  }
}
#endif
`;

const BASE_GLINT = 'float glint = max(uDew * 1.0, gSnow * 1.3);';

function patchShader(sh, hooks) {
  const missing = [];
  const rep = (key, src, find, replace) => {
    if (!sh[src].includes(find)) {
      missing.push(key);
      return;
    }
    sh[src] = sh[src].replace(find, replace);
  };
  rep('vertex pars', 'vertexShader', '#include <common>', '#include <common>\nattribute vec2 aFloor;\nattribute vec2 aSnow;\nvarying vec2 vFloor;\nvarying vec2 vSnow;');
  rep('vertex main', 'vertexShader', '#include <fog_vertex>', '#include <fog_vertex>\nvFloor = aFloor;\nvSnow = aSnow;');
  rep('fragment pars', 'fragmentShader', 'void main() {', `${FLOOR_PARS}\nvoid main() {`);
  rep('fragment main', 'fragmentShader', '#include <color_fragment>', `${FLOOR_MAIN}\n#include <color_fragment>`);
  rep('fragment light', 'fragmentShader', '#include <aomap_fragment>', `#include <aomap_fragment>\n${FLOOR_LIGHT}`);
  // the regular ground's dew glints are a few millimetres wide: right from afar, blobs from 0.85 m
  if (sh.fragmentShader.includes(BASE_GLINT)) sh.fragmentShader = sh.fragmentShader.replace(BASE_GLINT, BASE_GLINT.replace(';', ' * fBaseGlint;'));
  else missing.push('base glint (harmless)');
  // the ground block must have run before ours: it declares gMoss, gSnow, gRough, gN, vWP, uNoise, uEco …
  if (!/float gMoss\b/.test(sh.fragmentShader) || !sh.fragmentShader.includes('uniform vec4 uEcoRect')) missing.push('ground material block');
  hooks.missing = missing;
  if (missing.length) console.warn('[flyover] floor shader hooks not found:', missing.join(', '));
}

/**
 * The uniforms of SNOW_FIELD_GLSL for a snow field (or an empty one). Share these objects to read the same
 * snow: uSnowK.x is the season's sp.snow, set by the floor's applySeason.
 */
export function snowUniforms(snow = null) {
  return {
    tSnowField: { value: snow?.texture ?? null },
    uSnowMapA: { value: new THREE.Vector4(PATCH.center.x, PATCH.center.y, 1 / (2 * PATCH.halfL), 1 / (2 * PATCH.halfW)) },
    uSnowMapB: { value: new THREE.Vector4(PATCH.u.x, PATCH.u.y, PATCH.v.x, PATCH.v.y) },
    uSnowK: { value: new THREE.Vector4(0, FLOOR.snowThin, SNOW.depth, SNOW.drape) },
  };
}

/**
 * The floor material: the regular groundMaterial (identical look at the border, its parallax on high tiers
 * included) with the close-up layer patched in after it. `tex` = bakeFloorTextures() output (or placeholders),
 * `snow` = the snow field (snowField()).
 */
export function floorMaterial(ctx, tex, { pom = false, snow = null } = {}) {
  const mat = groundMaterial({
    moss: ctx.surfaces.moss,
    litter: ctx.surfaces.litter,
    noise: ctx.noise,
    eco: ctx.eco.texture,
    ecoRect: ctx.eco.rect,
  });
  const u = {
    tFloorA: { value: tex.albedo },
    tFloorN: { value: tex.normal },
    tFloorS: { value: tex.extra },
    uFloorMap: { value: new THREE.Vector4(1 / FLOOR_MAP.tileA, 1 / FLOOR_MAP.tileB, Math.cos(FLOOR_MAP.rotB), Math.sin(FLOOR_MAP.rotB)) },
    uFloorView: { value: new THREE.Vector4(1, FLOOR.distFade[0], FLOOR.distFade[1], pom ? FLOOR_DEPTH * FLOOR.pomDepth : 0) },
    uFloorSeason: { value: new THREE.Vector4(0.2, 1, 0, 0) },
    uFloorTune: { value: new THREE.Vector4(FLOOR.match, FLOOR.ao, FLOOR.microShadow, FLOOR.normal) },
    uFloorMoss: { value: FLOOR.mossKeep },
    uFloorSnowA: { value: new THREE.Vector4(FLOOR.snowRelief, FLOOR.snowThin, FLOOR.snowRipple, FLOOR.snowPits) },
    uFloorSnowB: { value: new THREE.Vector4(FLOOR.snowGrain, FLOOR.snowSparkle, FLOOR.snowSSS, 0) },
    ...snowUniforms(snow),
  };
  const hooks = { missing: null };
  const baseCompile = mat.onBeforeCompile;
  const baseKey = mat.customProgramCacheKey.call(mat);
  mat.onBeforeCompile = (sh, renderer) => {
    baseCompile.call(mat, sh, renderer);
    Object.assign(sh.uniforms, u);
    patchShader(sh, hooks);
  };
  mat.customProgramCacheKey = () => `flyover-floor-${baseKey}-${pom ? 'pom' : 'flat'}`;
  mat.defines = { ...(mat.defines ?? {}), ...(pom ? { FLOOR_POM: '' } : {}) };
  mat.userData.floor = u;
  mat.userData.hooks = hooks;
  return mat;
}

// ── the module ──────────────────────────────────────────────

// Smooth 0 … 1 window over months [a, b] (wrapping over New Year), like config.js phenology.
function months(m, a, b, ramp) {
  const inside = (x) => smoothstep(a - ramp, a + ramp, x) * (1 - smoothstep(b - ramp, b + ramp, x));
  return Math.max(inside(m), inside(m + 12), inside(m - 12));
}

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

/**
 * buildFloor(ctx) → { group, update(dt, time, state), applySeason(sp, v), stats, material, textures }
 * ctx.scene must already hold the regular ground (named 'ground'). If nobody has lowered it under the patch,
 * the floor does so itself (sinkTerrain) once it is built; if other code lowered it, that is left as it is.
 */
export async function buildFloor(ctx) {
  const q = ctx.quality ?? {};
  const tier = q.tier ?? 'medium';
  const pom = q.pom ?? (tier === 'high' || tier === 'ultra');
  const ground = ctx.scene?.getObjectByName?.('ground') ?? null;
  const tState = terrainState(ground);
  const terrain = terrainSurface(ground, { pendingSink: tState === 'plain' });
  if (!terrain) console.warn('[flyover] floor: regular ground grid not found, meeting heightAt at the border instead');
  else if (tState === 'lowered') console.info('[flyover] floor: terrain already lowered elsewhere; the close-up yields where it comes close');

  const t0 = performance.now();
  const textures = await bakeFloorTextures(ctx.renderer, { size: floorTextureSize(q), anisotropy: q.anisotropy ?? 8 });
  const bakeMs = performance.now() - t0;
  if (!textures.ok) console.warn('[flyover] floor: close-up bake came out empty, showing the regular ground only');

  const mesh = await buildFloorGeometry({ tier, terrain, tick: yieldToBrowser, trees: ctx.trees ?? [] });
  if (terrain && tState === 'plain') sinkTerrain(ground.geometry);
  const material = floorMaterial(ctx, textures, { pom, snow: mesh.snow });
  const layerOn = textures.ok ? 1 : 0;
  lastSnowField = mesh.snow;
  const floor = new THREE.Mesh(mesh.geometry, material);
  floor.name = 'flyover-floor';
  floor.receiveShadow = !!(q.shadows ?? true);
  floor.castShadow = false;
  const group = new THREE.Group();
  group.name = 'flyover-floor';
  group.add(floor);

  const U = material.userData.floor;
  U.uFloorView.value.x = layerOn;
  // a coarse (512²) close-up is a soft tone more than single needles: gentler micro shadows and normals
  if (textures.size <= 512) {
    U.uFloorTune.value.z *= 0.6;
    U.uFloorTune.value.w *= 0.8;
  }
  const base = material.userData.uniforms;
  const stats = { drawCalls: 1, triangles: mesh.triangles, instances: 0, vertices: mesh.vertices, texture: textures.size, bakeMs: Math.round(bakeMs), terrain: tState };
  const snowOut = {};
  // the snow field, for the moss shells (GPU) and litter / life (CPU): see SNOW and SNOW_FIELD_GLSL
  const snowFieldPart = {
    texture: mesh.snow.texture,
    uniforms: { tSnowField: U.tSnowField, uSnowMapA: U.uSnowMapA, uSnowMapB: U.uSnowMapB, uSnowK: U.uSnowK },
    glsl: SNOW_FIELD_GLSL,
    constants: SNOW,
    depthAt: (x, z, snow, out) => mesh.snow.depthAt(x, z, snow, out),
    formula:
      'f = texture(st: s along u, t along v over the patch); G = f.r·gScale (m above heroHeightAt), e = (f.g − 0.5)·eScale (m), ' +
      'thin = f.b·tScale, canopy = f.a; sEff = clamp(snow − thin·thinning·(1 − 0.75·smoothstep(0.9, 1, snow)), 0, 1); ' +
      'depth = SNOW.depth·smoothstep(SNOW.start, 1, sEff)^1.5; thickness = depth − (1 − SNOW.drape)·e − SNOW.lag·(1 − smoothstep(0, SNOW.lagDepth, depth)); ' +
      'surface = G + max(thickness, 0); ' +
      'dusting = SNOW.dust·smoothstep(0.03, 0.45, sEff)',
  };

  return {
    group,
    material,
    textures,
    stats,
    snowField: snowFieldPart,
    /**
     * World y of the snow as the floor draws it at (x, z): its relief is shading only, so the drawn snow lies on
     * the floor mesh (heroHeightAt), and things that sit on it (cones, tracks) belong there; plants sink instead.
     * For "is it under the snow?" use snowField.depthAt / snowDepthAt (thickness, physical surface).
     */
    snowTopAt: (x, z, snow) => heroHeightAt(x, z) + (snow > 0.001 && mesh.snow.depthAt(x, z, snow, snowOut).thickness > 0 ? 0.0005 : 0),
    update(dt, time, state) {
      const dist = state?.dist ?? 0;
      const near = state?.near ?? 1;
      // the close-up layer only costs anything while the camera is close; parallax only right above it
      U.uFloorView.value.x = layerOn * (1 - smoothstep(FLOOR.farOff[0], FLOOR.farOff[1], dist));
      U.uFloorView.value.w = pom ? FLOOR_DEPTH * FLOOR.pomDepth * smoothstep(0.15, 0.85, near) : 0;
    },
    applySeason(sp, v) {
      // the regular ground's own season inputs, exactly as world.js sets them on the terrain
      base.uSGround.value.set(sp.ground[0], sp.ground[1], sp.ground[2]);
      base.uSLitter.value = sp.litter;
      base.uDew.value = sp.dew;
      U.uSnowK.value.x = sp.snow ?? 0;
      const m = monthOf(v ?? 1.5);
      const autumn = months(m, 9.2, 11.9, 0.5); // rainy autumn: darker, glossier
      const melt = months(m, 3.5, 4.9, 0.35) * (1 - sp.snow); // snowmelt in April
      U.uFloorSeason.value.set(Math.min(1, 0.18 * sp.dew + 0.62 * autumn + 0.45 * melt), sp.dew, autumn, 0);
    },
  };
}
