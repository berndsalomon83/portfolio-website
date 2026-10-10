import * as THREE from 'three';
import { smoothstep } from '../../lib/random.js';
import { PATCH, heroHeightAt } from './config.js';

// The forest-floor close-up under the flyover: builds every module, wires them together (moss tips and
// leaf tips get dew, a lingon leaf gets its ladybird) and keeps everything cheap while the camera is far away.
// A module that fails to load or build is skipped with a warning, so the rest of the forest always renders.

const MODULES = [
  ['floor', () => import('./floor.js'), 'buildFloor'],
  ['moss', () => import('./moss.js'), 'buildMoss'],
  ['litter', () => import('./litter.js'), 'buildLitter'],
  ['plants', () => import('./plants.js'), 'buildFloorPlants'],
  ['life', () => import('./life.js'), 'buildLife'],
  ['dew', () => import('./dew.js'), 'buildDew'],
];

export async function buildFlyover(ctx, tick = async () => {}) {
  const group = new THREE.Group();
  group.name = 'flyover';
  const parts = {};
  const timings = {};
  for (const [name, load, fn] of MODULES) {
    const t0 = performance.now();
    try {
      const mod = await load();
      const part = await mod[fn](ctx);
      if (!part.group.name) part.group.name = `flyover-${name}`;
      group.add(part.group);
      parts[name] = part;
    } catch (err) {
      console.warn(`[flyover] ${name} skipped`, err);
    }
    timings[name] = Math.round(performance.now() - t0);
    await tick();
  }
  console.info('[flyover] build ms', JSON.stringify(timings));

  // dew on the moss tips and still leaves; the spider's thread runs from a buckler-fern tip to a dead twig
  const silk = parts.plants?.silkAnchor && parts.litter?.silkAnchor ? { from: parts.plants.silkAnchor, to: parts.litter.silkAnchor } : undefined;
  parts.dew?.setSites?.({ mossTips: parts.moss?.tips ?? [], leafSites: parts.plants?.dewSites ?? [], silk });
  parts.life?.setPerches?.(parts.plants?.perches ?? []);
  // moss and litter snow from the floor's snow field, so all three agree
  parts.moss?.setSnowField?.(parts.floor?.snowField);
  parts.litter?.setSnowField?.(parts.floor?.snowField);
  // prints in the snow sit on the snow as the floor draws it
  if (parts.floor?.snowTopAt) parts.life?.setSnowTop?.(parts.floor.snowTopAt);

  const centre = new THREE.Vector3(PATCH.center.x, heroHeightAt(PATCH.center.x, PATCH.center.y), PATCH.center.y);
  const state = { camera: ctx.camera, dist: Infinity, near: 0, look: null };
  const list = Object.values(parts);

  return {
    group,
    parts,
    update(dt, time, look) {
      const d = ctx.camera.position.distanceTo(centre);
      state.dist = d;
      state.near = 1 - smoothstep(2.5, 4.0, d);
      state.look = look;
      group.visible = d < 30;
      if (!group.visible) return;
      for (const p of list) p.update?.(dt, time, state);
    },
    applySeason(sp, v) {
      for (const p of list) p.applySeason?.(sp, v);
    },
    stats() {
      const out = {};
      for (const [name, p] of Object.entries(parts)) out[name] = typeof p.stats === 'function' ? p.stats() : p.stats;
      return out;
    },
  };
}
