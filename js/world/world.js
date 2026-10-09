import * as THREE from 'three';
import { installFog, shared } from '../gl/patches.js';
import { Baker, SURF } from '../gl/bake.js';
import { createFoliageTextures } from './foliage-textures.js';
import { createSky } from './sky.js';
import { heightAt, groundGeometry, buildEcology } from './terrain.js';
import { groundMaterial } from './materials.js';
import { placeTrees, buildForest } from './trees.js';
import { buildPlants } from './plants.js';
import { buildProps } from './props.js';
import { buildSapling } from './sapling.js';
import { dewField, dewPoints, spiderWeb, dustMotes, forestBackdrop, shadowUniforms } from './details.js';
import { RNG } from '../lib/random.js';
import { SUN_DIR, SUN_COLOR, SAPLING } from './layout.js';

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
  installFog({ falloff: 0.07 });

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

  scene.add(createSky());

  // ── textures ─────────────────────────────────────────────
  progress(0.04, 'Painting bark and moss');
  await tick();
  const baker = new Baker(renderer);
  const surfaces = {};
  const jobs = [
    ['pineLower', SURF.PINE_LOWER, 512, 1024, 6],
    ['pineUpper', SURF.PINE_UPPER, 512, 1024, 3],
    ['spruce', SURF.SPRUCE, 512, 1024, 4],
    ['birch', SURF.BIRCH, 512, 1024, 1.5],
    ['birchBase', SURF.BIRCH_BASE, 512, 1024, 5],
    ['moss', SURF.MOSS, 1024, 1024, 4],
    ['litter', SURF.LITTER, 1024, 1024, 5],
    ['rock', SURF.ROCK, 1024, 1024, 3],
    ['deadwood', SURF.DEADWOOD, 512, 1024, 3],
  ];
  for (let i = 0; i < jobs.length; i++) {
    const [name, type, w, h, ns] = jobs[i];
    surfaces[name] = baker.surface(type, quality.tier === 'low' ? w / 2 : w, quality.tier === 'low' ? h / 2 : h, ns);
    progress(0.04 + 0.3 * ((i + 1) / jobs.length));
    await tick();
  }
  const noise = baker.noise(256);
  baker.dispose();

  progress(0.36, 'Growing needles and leaves');
  await tick();
  const foliage = createFoliageTextures();
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
  scene.add(ground);
  progress(0.74, 'Blueberries, ferns and lingon');
  await tick();

  // ── undergrowth & props ──────────────────────────────────
  const plants = buildPlants({ foliage, trees, eco, quality });
  scene.add(plants.group);
  const props = buildProps({ surfaces, foliage, trees, quality });
  scene.add(props.group);
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
  const drops = dewPoints(plants.mossPoints, plants.grassPoints, Math.round(4200 * quality.plants), drng).concat(web.beads);
  const dew = dewField(drops);
  details.add(dew);
  const dust = dustMotes(quality.tier === 'low' ? 600 : 1600);
  details.add(dust);
  const backdrop = forestBackdrop();
  details.add(backdrop);
  scene.add(details);

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
    dew.material.uniforms.uStrength.value = 0.35 + 0.65 * THREE.MathUtils.smoothstep(look.growth, 0, 0.6);
    dust.material.uniforms.uTime.value = time;
    dust.material.uniforms.uCam.value.copy(camera.position);
    dust.material.uniforms.uPx.value = (size.y * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    backdrop.material.uniforms.uFog.value.copy(scene.fog.color);
    sapling.grow(look.growth, time);
  });
  const world = {
    scene,
    camera,
    sun,
    ctx,
    stats: forest.stats,
    saplingGroundY: heightAt(SAPLING.x, SAPLING.y),
    addUpdater(fn) {
      updaters.push(fn);
    },
    update(dt, time, look) {
      shared.uTime.value = time;
      scene.fog.density = look.fog;
      updateShadowFrustum(sun, camera, quality);
      for (const fn of updaters) fn(dt, time, look);
    },
  };
  return world;
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
