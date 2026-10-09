import * as THREE from 'three';
import { detectQuality, hasWebGL2 } from './quality.js';
import { createWorld } from './world/world.js';
import { Pipeline } from './post/pipeline.js';
import { Story } from './story.js';
import { initUI } from './ui.js';

const ui = initUI();

async function boot() {
  const canvas = document.getElementById('forest');
  if (!hasWebGL2()) {
    document.documentElement.classList.add('no-webgl');
    ui.done();
    return;
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
  });
  const quality = detectQuality(renderer.getContext());
  const params = new URLSearchParams(location.search);
  if (params.has('novol')) quality.volumetric = false;
  if (params.has('noshadow')) quality.shadows = false;
  if (params.has('msaa')) quality.msaa = Number(params.get('msaa'));
  if (params.has('pixels')) quality.pixels = Number(params.get('pixels')) * 1e6;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = params.has('softshadow') ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const world = await createWorld(renderer, quality, ui.progress);
  const pipeline = new Pipeline(renderer, world, quality);
  const story = new Story(ui.chapters);
  if (params.has('s')) story.s = story.force = Number(params.get('s'));

  for (const name of ['ground', 'forest', 'plants', 'props', 'details']) {
    if (params.has(`no${name}`)) world.scene.getObjectByName(name)?.removeFromParent();
  }

  // Render at a fixed pixel budget (the DOM text stays crisp; the 3D layer is upscaled softly).
  const baseRatio = () =>
    Math.min(window.devicePixelRatio || 1, quality.maxDpr, Math.sqrt(quality.pixels / Math.max(1, innerWidth * innerHeight)));
  let resScale = 1;
  const size = new THREE.Vector2();
  const resize = () => {
    renderer.setPixelRatio(baseRatio() * resScale);
    const cw = Math.max(16, innerWidth);
    const ch = Math.max(16, innerHeight);
    renderer.setSize(cw, ch, false);
    world.camera.aspect = cw / ch;
    world.camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(size);
    pipeline.setSize(size.x, size.y);
    story.measure();
  };
  resize();
  // resizing clears the canvas, so it always happens right before a frame is drawn
  let wantResize = false;
  addEventListener('resize', () => (wantResize = true));

  // warm-up: compile every shader before the curtain lifts
  ui.progress(0.88, 'Letting the light in');
  let time = 0;
  story.applyCamera(world.camera, time);
  let look = story.look();
  world.update(0, time, look);
  renderer.shadowMap.needsUpdate = true;
  try {
    await renderer.compileAsync(world.scene, world.camera);
  } catch {
    /* compileAsync is an optimisation only */
  }
  pipeline.render({ ...look, fade: 0 }, time);
  ui.progress(1);
  await new Promise((r) => setTimeout(r, 120));
  ui.done();
  console.info(`[forest] ready in ${Math.round(performance.now())} ms · ${quality.tier} quality · ${world.stats.instances} trees`);
  console.info();

  const clock = new THREE.Clock();
  let frame = 0;
  let fade = params.has('s') ? 1 : 0;
  if (params.has('clean')) document.documentElement.classList.add('clean');
  let acc = 0;
  let accN = 0;
  let slow = 0;
  const shadowEvery = quality.shadowEvery;

  document.addEventListener('visibilitychange', () => clock.getDelta());

  let hud = null;
  let hudAcc = 0;
  let hudN = 0;
  if (params.has('debug')) {
    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:12px/1.4 monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:6px;pointer-events:none';
    document.body.appendChild(hud);
  }

  const loop = () => {
    requestAnimationFrame(loop);
    if (wantResize) {
      wantResize = false;
      resize();
    }
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    time += dt;
    fade = Math.min(1, fade + dt / 1.6);

    story.update(dt);
    story.applyCamera(world.camera, time);
    look = story.look();
    story.height = look.height;
    look.fade = fade * fade * (3 - 2 * fade);
    if (window.forest?.override) Object.assign(look, window.forest.override);
    world.update(dt, time, look);

    renderer.shadowMap.needsUpdate = frame % shadowEvery === 0;
    pipeline.render(look, time);
    ui.gauge(story);
    frame++;
    if (hud) {
      hudAcc += dt;
      hudN++;
      if (hudAcc > 0.5) {
        hud.textContent = `${(hudN / hudAcc).toFixed(1)} fps · ${size.x}×${size.y} · scale ${resScale.toFixed(2)} · ${quality.tier} · s ${story.s.toFixed(2)}`;
        window.__fps = hudN / hudAcc;
        hudAcc = 0;
        hudN = 0;
      }
    }

    // dynamic resolution: keep the forest fluid on slower GPUs
    if (rawDt < 0.1 && time > 2.5) {
      acc += dt;
      accN++;
    }
    if (acc > 1.2 && !params.has('nodynres')) {
      const avg = acc / accN;
      acc = 0;
      accN = 0;
      if (avg > 1 / 38 && resScale > 0.5) {
        if (++slow >= 2) {
          resScale = Math.max(0.5, resScale * 0.86);
          slow = 0;
          wantResize = true;
        }
      } else if (avg < 1 / 57 && resScale < 1) {
        slow = 0;
        resScale = Math.min(1, resScale * 1.08);
        wantResize = true;
      } else {
        slow = 0;
      }
    }
  };
  loop();

  // handy for tweaking in the console
  window.forest = {
    renderer,
    world,
    pipeline,
    story,
    quality,
    // GPU benchmark independent of requestAnimationFrame: ms per frame (synchronised with readPixels)
    bench(n = 8, s = null) {
      const px = new Uint8Array(4);
      const gl = renderer.getContext();
      if (s !== null) {
        story.s = story.target = s;
        story.applyCamera(world.camera, time);
        look = story.look();
        world.update(0, time, look);
      }
      let k = 0;
      const once = () => {
        renderer.shadowMap.needsUpdate = k++ % quality.shadowEvery === 0;
        pipeline.render(look, time);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      };
      once();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) once();
      return +((performance.now() - t0) / n).toFixed(2);
    },
  };
}

boot().catch((err) => {
  console.error(err);
  document.documentElement.classList.add('no-webgl');
  ui.done();
});
