import * as THREE from 'three';
import { installFog, shared, seasonUniforms } from '../gl/patches.js';
import { Baker, SURF } from '../gl/bake.js';
import { createFoliageTextures } from './foliage-textures.js';
import { createSky } from './sky.js';
import { heightAt, groundGeometry, buildEcology } from './terrain.js';
import { groundMaterial, setMaterialOptions } from './materials.js';
import { placeTrees, buildForest } from './trees.js';
import { buildPlants } from './plants.js';
import { buildProps } from './props.js';
import { buildSapling } from './sapling.js';
import { dewField, dewPoints, spiderWeb, dustMotes, forestBackdrop, shadowUniforms, fallingLeaves, snowfall, sunHDR } from './details.js';
import { RNG } from '../lib/random.js';
import { SUN_DIR, SUN_COLOR, SAPLING } from './layout.js';
import { buildFlyover } from './flyover/index.js';
import { patchFade } from './flyover/config.js';
import { flyoverShadow } from './flyover/light.js';

// Yield to the browser so the loader can repaint (rAF alone stalls in background tabs).
const tick = () =>
  new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 60);
  });

export async function createWorld(renderer, quality, progress = () => {}) {
  // ground mist; ?nomist, ?mist=1.6 and ?mistk=0.55 for tuning
  const mp = new URLSearchParams(location.search);
  installFog({
    falloff: 0.07,
    mist: mp.has('nomist') ? 0 : Number(mp.get('mist') ?? 1.6),
    mistK: Number(mp.get('mistk') ?? 0.55),
    mistTaps: { ultra: 3, high: 2, medium: 1, low: 1 }[quality.tier] ?? 1,
  });
  setMaterialOptions({ pom: !!quality.pom, pbr: !!quality.pbrFoliage });

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(0.3, 0.36, 0.34), 0.008);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1000);
  camera.position.set(0, 2, 6);

  // ── light ────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(SUN_COLOR, 3.4);
  sun.castShadow = quality.shadows;
  const SH = quality.shadowExtent;
  sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 280 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(new THREE.Color(0.58, 0.7, 0.84), new THREE.Color(0.13, 0.13, 0.075), 0.82);
  scene.add(hemi);

  const sky = createSky();
  scene.add(sky);

  // ── textures ─────────────────────────────────────────────
  progress(0.04, 'Painting bark and moss');
  await tick();
  const baker = new Baker(renderer, quality.anisotropy);
  const surfaces = {};
  const T = quality.tex;
  const jobs = [
    ['pineLower', SURF.PINE_LOWER, 512, 1024, 6],
    ['pineUpper', SURF.PINE_UPPER, 512, 1024, 3],
    ['spruce', SURF.SPRUCE, 512, 1024, 4],
    ['birch', SURF.BIRCH, 512, 1024, 1.6],
    ['birchBase', SURF.BIRCH_BASE, 512, 1024, 5],
    ['moss', SURF.MOSS, 1024, 1024, 4],
    ['litter', SURF.LITTER, 1024, 1024, 5],
    ['rock', SURF.ROCK, 1024, 1024, 3],
    ['deadwood', SURF.DEADWOOD, 512, 1024, 3],
  ];
  const pot = (v) => Math.pow(2, Math.round(Math.log2(v)));
  for (let i = 0; i < jobs.length; i++) {
    const [name, type, w, h, ns] = jobs[i];
    surfaces[name] = baker.surface(type, pot(w * T), pot(h * T), ns * Math.sqrt(T));
    progress(0.04 + 0.3 * ((i + 1) / jobs.length));
    await tick();
  }
  const noise = baker.noise(256);
  baker.dispose();

  progress(0.36, 'Growing needles and leaves');
  await tick();
  const foliage = createFoliageTextures({ res: quality.foliageRes, anisotropy: quality.anisotropy });
  progress(0.5, 'Planting the forest');
  await tick();

  // ── forest ───────────────────────────────────────────────
  const trees = placeTrees(quality);
  const forest = buildForest({ trees, surfaces, foliage, quality });
  scene.add(forest.group);
  progress(0.68, 'Spreading moss over the ground');
  await tick();

  // ── ground ───────────────────────────────────────────────
  const eco = buildEcology(trees);
  const ground = new THREE.Mesh(
    groundGeometry(quality.groundSegs, 150),
    groundMaterial({ moss: surfaces.moss, litter: surfaces.litter, noise, eco: eco.texture, ecoRect: eco.rect }),
  );
  ground.receiveShadow = quality.shadows;
  ground.name = 'ground';
  // (under the flyover's close-up patch, flyover/floor.js sinks this ground a little once its own floor is built)
  scene.add(ground);
  progress(0.74, 'Blueberries, ferns and lingon');
  await tick();

  // ── undergrowth & props ──────────────────────────────────
  const plants = buildPlants({ foliage, trees, eco, quality });
  scene.add(plants.group);
  const props = buildProps({ surfaces, foliage, trees, quality });
  scene.add(props.group);
  // the flyover patch has its own hand-placed floor: regular undergrowth thins out toward it and is gone inside
  clearPatch(plants.group);
  clearPatch(props.group);
  progress(0.8, 'Something new is growing');
  await tick();

  // ── the sapling ──────────────────────────────────────────
  const sapling = buildSapling({ foliage, quality });
  scene.add(sapling.group, sapling.fleck, sapling.fleck.target);

  // ── morning details ──────────────────────────────────────
  progress(0.84, 'Morning dew');
  await tick();
  const details = new THREE.Group();
  details.name = 'details';
  const drng = new RNG(5150);
  const S = SAPLING;
  const webCenter = new THREE.Vector3(S.x + 0.78, heightAt(S.x + 0.78, S.y + 0.3) + 0.2, S.y + 0.3);
  const webNormal = new THREE.Vector3(-1.0, 0, 2.3);
  const web = spiderWeb(webCenter, webNormal, 0.11, drng);
  details.add(web.lines);
  const drops = dewPoints(plants.mossPoints, plants.grassPoints, Math.round(7000 * quality.plants), drng)
    .concat(web.beads, plants.leafDew ?? [])
    .filter((p) => keepOutsidePatch(p.x ?? p[0], p.z ?? p[2]));
  const dew = dewField(drops);
  details.add(dew);
  const dust = dustMotes(quality.tier === 'low' ? 600 : 1600);
  details.add(dust);
  const backdrop = forestBackdrop();
  details.add(backdrop);
  const leavesFx = fallingLeaves(quality.tier === 'low' ? 120 : 280);
  const snowFx = snowfall(quality.tier === 'low' ? 900 : 2400);
  details.add(leavesFx, snowFx);
  scene.add(details);

  // ── seasons: light, mist, sky, plants, snow and what drifts through the air ──
  const groundU = ground.material.userData.uniforms;
  const groups = ['conifer', 'birch', 'berry', 'lingon', 'fern', 'grass', 'moss'];
  let season = null;
  let flyover = null;
  let seasonV = 0;
  const applySeason = (sp, v = 0) => {
    season = sp;
    seasonV = v;
    flyover?.applySeason(sp, v);
    sun.color.setRGB(sp.sun[0], sp.sun[1], sp.sun[2]);
    sun.intensity = sp.sunI;
    sapling.fleck.color.copy(sun.color);
    sunHDR.set(sp.sun[0], sp.sun[1], sp.sun[2]).multiplyScalar(sp.sunI);
    hemi.color.setRGB(sp.hemiSky[0], sp.hemiSky[1], sp.hemiSky[2]);
    hemi.groundColor.setRGB(sp.hemiGround[0], sp.hemiGround[1], sp.hemiGround[2]);
    hemi.intensity = sp.hemiI;
    scene.fog.color.setRGB(sp.fog[0], sp.fog[1], sp.fog[2]);
    sky.material.uniforms.uTint.value.set(sp.sky[0], sp.sky[1], sp.sky[2]);
    sky.material.uniforms.uSunCol.value.set(sp.sun[0], sp.sun[1] * 0.93, sp.sun[2] * 0.76);
    shared.uSnow.value = sp.snow;
    for (const g of groups) {
      seasonUniforms[g].uSColor.value.set(sp[g].color[0], sp[g].color[1], sp[g].color[2]);
      seasonUniforms[g].uSAmount.value = sp[g].amount;
      seasonUniforms[g].uSLoss.value = sp[g].loss;
    }
    groundU.uSGround.value.set(sp.ground[0], sp.ground[1], sp.ground[2]);
    groundU.uSLitter.value = sp.litter;
    groundU.uDew.value = sp.dew;
    leavesFx.material.uniforms.uAmount.value = sp.leaves;
    snowFx.material.uniforms.uAmount.value = sp.snowfall;
    dust.material.uniforms.uStrength.value = sp.dust;
    sapling.setDew(sp.dew);
  };

  const ctx = { scene, camera, sun, surfaces, foliage, noise, trees, eco, quality, renderer };
  const updaters = [];
  const size = new THREE.Vector2();
  updaters.push((dt, time, look) => {
    const map = sun.shadow && sun.shadow.map ? sun.shadow.map.texture : null;
    shadowUniforms.tShadow.value = map;
    shadowUniforms.uHasShadow.value = map ? 1 : 0;
    shadowUniforms.uShadowMatrix.value.copy(sun.shadow.matrix);
    renderer.getDrawingBufferSize(size);
    dew.material.uniforms.uViewport.value.copy(size);
    dew.material.uniforms.uStrength.value = (0.35 + 0.65 * THREE.MathUtils.smoothstep(Math.max(look.growth, look.fly ?? 0), 0, 0.6)) * (season ? season.dew : 1);
    dew.visible = !season || season.dew > 0.02;
    const px = (size.y * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    for (const fx of [dust, leavesFx, snowFx]) {
      fx.material.uniforms.uTime.value = time;
      fx.material.uniforms.uCam.value.copy(camera.position);
      fx.material.uniforms.uPx.value = px;
    }
    leavesFx.visible = !season || season.leaves > 0.01;
    snowFx.visible = !season || season.snowfall > 0.01;
    backdrop.material.uniforms.uFog.value.copy(scene.fog.color);
    sapling.grow(look.growth, time);
  });

  // ── the forest floor close-up under the flyover ──────────
  // Built in the background once the page is up: visitors start in the treetops, the glide comes much later.
  // Each part's shaders compile off the main thread before it joins the scene, so nothing stutters.
  updaters.push((dt, time, look) => flyover?.update(dt, time, look));
  const flyoverReady = (async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const built = await buildFlyover(ctx, tick);
    try {
      await renderer.compileAsync(built.group, camera, scene);
    } catch {
      /* compileAsync is an optimisation only */
    }
    scene.add(built.group);
    flyover = built;
    world.flyover = built;
    if (season) built.applySeason(season, seasonV);
    return built;
  })().catch((err) => console.warn('[flyover] not available', err));
  const world = {
    scene,
    camera,
    sun,
    ctx,
    stats: forest.stats,
    flyover: null,
    flyoverReady,
    saplingGroundY: heightAt(SAPLING.x, SAPLING.y),
    addUpdater(fn) {
      updaters.push(fn);
    },
    applySeason,
    update(dt, time, look) {
      shared.uTime.value = time;
      scene.fog.density = look.fog;
      updateShadowFrustum(sun, camera, quality);
      flyoverShadow(sun, camera, quality, look.fly ?? 0);
      // while gliding low over the floor, the shade gets a photographer's fill (sky and green bounce under the canopy)
      hemi.intensity = (season ? season.hemiI : 0.82) * (1 + 0.6 * (look.fly ?? 0));
      // the custom shadow lookups (dust, dew) copy this matrix before the shadow pass renders: keep it current
      if (sun.castShadow) sun.shadow.updateMatrices(sun);
      for (const fn of updaters) fn(dt, time, look);
    },
  };
  return world;
}

// Deterministic "keep this?" for things near the flyover patch: certain removal inside, thinning across its fade band.
function keepOutsidePatch(x, z) {
  const f = patchFade(x, z);
  if (f <= 0) return true;
  const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
  return f < h * 0.98 + 0.01;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c2 = new THREE.Vector3();
// Small objects go or stay whole; big merged meshes (scattered twigs …) lose the triangles inside the patch,
// decided per 25 cm cell so that pieces disappear together instead of being cut apart.
function clearPatch(group) {
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (o.isInstancedMesh) {
      let changed = false;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _m);
        _p.setFromMatrixPosition(_m).applyMatrix4(o.matrixWorld);
        if (!keepOutsidePatch(_p.x, _p.z)) {
          o.setMatrixAt(i, _zero);
          changed = true;
        }
      }
      if (changed) o.instanceMatrix.needsUpdate = true;
      return;
    }
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (g.boundingSphere.radius < 0.6) {
      _p.copy(g.boundingSphere.center).applyMatrix4(o.matrixWorld);
      if (!keepOutsidePatch(_p.x, _p.z)) o.visible = false;
      return;
    }
    const pos = g.attributes.position;
    const idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const keep = [];
    let dropped = 0;
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      _a.fromBufferAttribute(pos, i0);
      _b.fromBufferAttribute(pos, i1);
      _c2.fromBufferAttribute(pos, i2);
      _p.copy(_a).add(_b).add(_c2).multiplyScalar(1 / 3).applyMatrix4(o.matrixWorld);
      const cx = Math.floor(_p.x / 0.25) * 0.25 + 0.125;
      const cz = Math.floor(_p.z / 0.25) * 0.25 + 0.125;
      if (keepOutsidePatch(cx, cz)) keep.push(i0, i1, i2);
      else dropped++;
    }
    if (dropped) g.setIndex(keep);
  });
}

const _fwd = new THREE.Vector3();
const _c = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// Keep the shadow map centred where the camera looks, snapped to texels so shadows never shimmer.
function updateShadowFrustum(sun, camera, quality) {
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
  _fwd.normalize();
  _c.copy(camera.position).addScaledVector(_fwd, quality.tier === 'low' ? 10 : 16);
  _c.y = heightAt(_c.x, _c.z);
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
  _rot.lookAt(SUN_DIR, _origin, _up);
  _inv.copy(_rot).invert();
  _c.applyMatrix4(_inv);
  _c.x = Math.round(_c.x / texel) * texel;
  _c.y = Math.round(_c.y / texel) * texel;
  _c.applyMatrix4(_rot);
  sun.target.position.copy(_c);
  sun.position.copy(_c).addScaledVector(SUN_DIR, 140);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}
