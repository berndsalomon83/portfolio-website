import * as THREE from 'three';
import { RNG } from '../lib/random.js';
import { injectFoliage } from '../gl/patches.js';
import { heightAt } from './terrain.js';
import { SAPLING, SUN_DIR, SUN_COLOR } from './layout.js';
import { dewSphereMaterial } from './details.js';

// "Something new": a young oak pushing up from its acorn in a fleck of sunlight.
// grow(g) unfolds it — internodes stretch one after another, leaves open from folded, bronze buds.

const UP = new THREE.Vector3(0, 1, 0);
const ease = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 6, 12);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    // V-fold along the midrib, gentle cup and a backward arch toward the tip
    const z = Math.abs(x) * 0.18 - x * x * 0.25 - Math.pow(y, 2.0) * 0.12 + Math.sin(y * 9.0) * 0.006;
    p.setZ(i, z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildSapling({ foliage, quality }) {
  const rng = new RNG(31);
  const dewRng = new RNG(7);
  const group = new THREE.Group();
  group.name = 'sapling';
  const gy = heightAt(SAPLING.x, SAPLING.y);
  group.position.set(SAPLING.x, gy, SAPLING.y);

  // ── acorn, cup and first root ──
  const acornMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.3, 0.16, 0.05), roughness: 0.32 });
  const cupMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.24, 0.2, 0.13), roughness: 0.95 });
  const acorn = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 24, 16).scale(1, 1.45, 1), acornMat);
  acorn.position.set(0.012, 0.004, 0.006);
  acorn.rotation.set(1.2, 0.3, 0.4);
  const cup = new THREE.Mesh(new THREE.SphereGeometry(0.0118, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.9, 1), cupMat);
  cup.position.set(0.03, 0.0, -0.004);
  cup.rotation.set(2.2, 0.2, 0.9);
  const rootMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.3, 0.18), roughness: 0.8 });
  const root = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.005, 0.006, 0.004), new THREE.Vector3(-0.004, -0.004, 0.01), new THREE.Vector3(-0.012, -0.03, 0.012)]), 8, 0.0016, 6),
    rootMat,
  );
  group.add(acorn, cup, root);

  // ── stem: a chain of internodes ──
  const lengths = [0.075, 0.064, 0.058, 0.052, 0.046, 0.04, 0.034];
  const N = lengths.length;
  const stemGeo = new THREE.CylinderGeometry(0.78, 1, 1, 10, 1, true).translate(0, 0.5, 0);
  const nodes = [];
  const internodes = [];
  let parent = new THREE.Object3D();
  parent.position.set(0.004, 0.008, 0.002);
  group.add(parent);
  const leafGeo = leafGeometry();
  const leaves = [];
  const dewMat = dewSphereMaterial();
  const dropGeo = new THREE.SphereGeometry(1, 18, 12);
  const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: foliage.oak, alphaTest: 0.5, side: THREE.DoubleSide });

  // The seedling stays fresh green and full in every season: it stands for what is being built.
  const leafMat = (tint) => {
    const m = new THREE.MeshStandardMaterial({
      map: foliage.oak,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0,
      color: tint,
      alphaToCoverage: quality.msaa > 0,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTrans = { value: new THREE.Vector3(0.6, 0.66, 0.26) };
      injectFoliage(sh, { power: 3, flipNormals: true });
    };
    m.customProgramCacheKey = () => 'oak-leaf';
    return m;
  };

  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const stemCol = new THREE.Color().lerpColors(new THREE.Color(0.3, 0.14, 0.07), new THREE.Color(0.32, 0.42, 0.12), t);
    const seg = new THREE.Mesh(stemGeo, new THREE.MeshStandardMaterial({ color: stemCol, roughness: 0.6 }));
    const r = 0.0034 * (1 - t * 0.55);
    seg.userData = { r, len: lengths[k] };
    seg.castShadow = true;
    parent.add(seg);
    internodes.push(seg);
    const node = new THREE.Object3D();
    // a gentle zig-zag at every node, typical of young oak shoots
    node.userData.rest = new THREE.Euler((k % 2 ? 1 : -1) * 0.07 + rng.float(-0.03, 0.03), rng.float(-0.4, 0.4), (k % 2 ? -1 : 1) * 0.06);
    node.rotation.copy(node.userData.rest);
    parent.add(node);
    nodes.push(node);

    // leaves: alternate spiral on the upper nodes, a rosette at the very top (as oaks do)
    const leafCount = k < 1 ? 0 : k === N - 1 ? 5 : k > 2 ? 2 : 1;
    for (let l = 0; l < leafCount; l++) {
      const pivot = new THREE.Object3D();
      const az = k === N - 1 ? (l / leafCount) * Math.PI * 2 + 0.4 : k * 2.4 + l * Math.PI;
      const size = (k === N - 1 ? rng.float(0.12, 0.15) : rng.float(0.1, 0.13)) * (1.1 - 0.15 * (l % 2));
      const mesh = new THREE.Mesh(leafGeo, leafMat(new THREE.Color(1, 1, 1)));
      mesh.scale.set(size * 0.95, size, size);
      mesh.position.y = 0.006; // petiole
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = leafDepth;
      pivot.add(mesh);
      // dew, unevenly: most leaves stay dry, some hold a bead or two, the odd tip a hanging drop.
      // (`rng` is still consumed as before so the seedling keeps its exact shape; `dewRng` decides.)
      const drops = [];
      const nd = rng.int(2, 4);
      const wet = dewRng.next();
      const beads = wet < 0.45 ? 0 : wet < 0.8 ? 1 : 2;
      const hangs = (k === N - 1 && l === 0) || dewRng.chance(0.15);
      for (let d = 0; d < nd + 1; d++) {
        const tip = d === nd;
        const ry = tip ? 0.99 : rng.float(0.3, 0.8);
        const rx = tip ? 0 : rng.float(-0.18, 0.18);
        const rad = (tip ? 0.0042 : rng.float(0.0018, 0.0032) * dewRng.float(0.55, 1.1)) / size;
        if (tip ? !hangs : d >= beads) continue;
        const drop = new THREE.Mesh(dropGeo, dewMat);
        drop.position.set(rx, ry, Math.abs(rx) * 0.18 - rx * rx * 0.25 - ry * ry * 0.12 + 0.012 + (tip ? -0.03 : 0));
        drop.scale.set(rad, rad * (tip ? 1.25 : 0.82), rad);
        mesh.add(drop);
        drops.push(drop);
      }
      pivot.userData = {
        az,
        open: k === N - 1 ? rng.float(0.65, 0.95) : rng.float(0.95, 1.25),
        born: k + 0.55 + l * 0.15,
        mesh,
        drops,
        phase: rng.float(0, 6.28),
      };
      node.add(pivot);
      leaves.push(pivot);
    }
    parent = node;
  }

  // terminal bud
  const bud = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 12, 8).scale(1, 1.8, 1), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.2, 0.08), roughness: 0.5 }));
  bud.position.y = 0.004;
  nodes[N - 1].add(bud);

  // ── a warm fleck of sunlight finding the seedling ──
  const fleck = new THREE.SpotLight(SUN_COLOR, 0, 0, THREE.MathUtils.degToRad(4.2), 0.85, 2);
  fleck.position.copy(group.position).addScaledVector(SUN_DIR, 22);
  fleck.target.position.copy(group.position).add(new THREE.Vector3(0, 0.15, 0));
  fleck.userData.full = 3.4 * 22 * 22 * 0.24;

  const state = { g: -1 };
  // dew only forms when it isn't frozen; the leaves themselves never change with the season
  let dewAmount = 1;
  const setDew = (dew) => {
    dewAmount = dew;
  };
  function grow(g, time) {
    const G = g * (N + 1.2);
    let y = 0;
    for (let k = 0; k < N; k++) {
      const seg = internodes[k];
      const gk = ease(clamp01(G - k));
      const len = seg.userData.len * Math.max(gk, 0.0001);
      const r = seg.userData.r * (0.35 + 0.65 * gk);
      seg.scale.set(r, len, r);
      seg.visible = gk > 0.001;
      nodes[k].position.set(0, len, 0);
      // breeze: the young shoot sways a little more at the top
      const sway = Math.sin(time * 1.3 + k * 0.6) * 0.012 * k * gk + Math.sin(time * 2.9 + k) * 0.004 * k * gk;
      nodes[k].rotation.set(nodes[k].userData.rest.x * gk + sway, nodes[k].userData.rest.y, nodes[k].userData.rest.z * gk + sway * 0.6);
      y += len;
    }
    bud.scale.setScalar(clamp01(G - N + 1) > 0 ? 1 : 0.0001);
    for (const p of leaves) {
      const u = p.userData;
      const lk = clamp01((G - u.born) / 1.4);
      const e = ease(lk);
      p.visible = lk > 0.001;
      // leaves start folded upright and bronze, then open out and green up
      const tilt = THREE.MathUtils.lerp(0.12, u.open, e);
      const flutter = Math.sin(time * 2.2 + u.phase) * 0.05 * e + Math.sin(time * 5.3 + u.phase * 2.0) * 0.015;
      p.rotation.set(0, u.az, 0);
      p.rotateX(-(tilt + flutter));
      const s = Math.max(e, 0.0001);
      u.mesh.scale.x = (0.25 + 0.75 * e) * u.mesh.scale.y;
      p.scale.setScalar(0.35 + 0.65 * s);
      u.mesh.material.color.setRGB(1.0 - 0.18 * e, 0.6 + 0.3 * e, 0.42 + 0.33 * e);
      for (const d of u.drops) d.visible = e > 0.85 && dewAmount > 0.5;
    }
    fleck.intensity = fleck.userData.full * ease(clamp01(g * 1.6 - 0.1));
    state.g = g;
    return y;
  }
  grow(0, 0);

  return { group, fleck, grow, setDew, leaves, dewMaterial: dewMat };
}
