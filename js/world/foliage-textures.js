import * as THREE from 'three';
import { RNG } from '../lib/random.js';

// Hand-"painted" alpha textures for needles, leaves, fronds and moss, drawn with Canvas 2D.
// Every texture is drawn bottom-up: v = 0 at the bottom edge (stem/base), v = 1 at the top.

let RES = 1;
let ANISO = 8;

// Every texture is drawn in a fixed coordinate space and rendered at RES× that size.
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * RES);
  c.height = Math.round(h * RES);
  const ctx = c.getContext('2d');
  ctx.scale(RES, RES);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return [c, ctx];
}

const rgb = (r, g, b, a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

// Canvas → DataTexture with colour bled into the transparent texels (no dark halos in mipmaps).
// The bleed uses the browser's own blur, so it stays fast at 2048 px. The texture also carries
// `userData.alphaAt(u, v)` so dew drops can be placed on real leaf pixels.
function toTexture(cv, { anisotropy = ANISO } = {}) {
  const w = cv.width;
  const h = cv.height;
  const srcImg = cv.getContext('2d').getImageData(0, 0, w, h);
  const src = srcImg.data;
  const bc = document.createElement('canvas');
  bc.width = w;
  bc.height = h;
  const bctx = bc.getContext('2d');
  bctx.filter = `blur(${Math.max(2, Math.round(3 * RES))}px)`;
  bctx.drawImage(cv, 0, 0);
  bctx.drawImage(bc, 0, 0);
  bctx.filter = `blur(${Math.max(4, Math.round(10 * RES))}px)`;
  bctx.drawImage(bc, 0, 0);
  bctx.filter = 'none';
  const blur = bctx.getImageData(0, 0, w, h).data;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sn = 0;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] > 10) {
      sr += src[i];
      sg += src[i + 1];
      sb += src[i + 2];
      sn++;
    }
  }
  const avg = sn ? [sr / sn, sg / sn, sb / sn] : [80, 100, 60];
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y; // flip so canvas top = v 1
    const row = y * w * 4;
    out.set(src.subarray(sy * w * 4, (sy + 1) * w * 4), row);
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const a = out[i + 3];
      if (a >= 250) continue;
      const j = (sy * w + x) * 4;
      if (blur[j + 3] > 2) {
        const t = a / 255;
        out[i] = blur[j] + (out[i] - blur[j]) * t;
        out[i + 1] = blur[j + 1] + (out[i + 1] - blur[j + 1]) * t;
        out[i + 2] = blur[j + 2] + (out[i + 2] - blur[j + 2]) * t;
      } else if (a === 0) {
        out[i] = avg[0];
        out[i + 1] = avg[1];
        out[i + 2] = avg[2];
      }
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  tex.userData.alphaAt = (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    return out[(y * w + x) * 4 + 3] / 255;
  };
  return tex;
}

function needle(ctx, x0, y0, x1, y1, bend, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  const mx = (x0 + x1) / 2 + bend[0];
  const my = (y0 + y1) / 2 + bend[1];
  ctx.quadraticCurveTo(mx, my, x1, y1);
  ctx.stroke();
}

// ── Scots pine: a brush of paired, blue-green needles around a shoot ──
// (bx,by) shoot base → (tx,ty) shoot tip, needle length in px.
function drawTuft(ctx, rng, bx, by, tx, ty, nLen, count, twigW) {
  ctx.strokeStyle = '#5c4029';
  ctx.lineWidth = twigW;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.quadraticCurveTo((bx + tx) / 2 + rng.float(-4, 4), (by + ty) / 2, tx, ty);
  ctx.stroke();
  const ax = tx - bx;
  const ay = ty - by;
  const al = Math.hypot(ax, ay);
  const ux = ax / al;
  const uy = ay / al;
  const list = [];
  for (let i = 0; i < count; i++) {
    const t = Math.pow(rng.next(), 0.55);
    const along = 0.12 + 0.88 * t;
    const px = bx + ax * along + rng.float(-1.5, 1.5);
    const py = by + ay * along;
    const theta = ((18 + 52 * rng.next()) * Math.PI) / 180 * (1 - 0.45 * t * t);
    const phi = rng.next() * Math.PI * 2;
    const side = Math.sin(theta) * Math.cos(phi);
    const fwd = Math.cos(theta);
    const depth = Math.sin(theta) * Math.sin(phi);
    // rotate (side, fwd) into the shoot frame
    const dx = ux * fwd - uy * side;
    const dy = uy * fwd + ux * side;
    const len = nLen * (0.75 + 0.45 * rng.next());
    list.push({ px, py, dx, dy, len, depth, t });
  }
  list.sort((a, b) => a.depth - b.depth);
  for (const n of list) {
    const shade = 0.5 + 0.5 * (n.depth * 0.5 + 0.5);
    const tipFresh = n.t > 0.85 ? 1.15 : 1;
    const r = (62 + 26 * rng.next()) * shade * tipFresh;
    const g = (88 + 34 * rng.next()) * shade * tipFresh;
    const b = (64 + 22 * rng.next()) * shade;
    needle(
      ctx,
      n.px,
      n.py,
      n.px + n.dx * n.len,
      n.py + n.dy * n.len,
      [rng.float(-0.08, 0.08) * n.len, rng.float(-0.06, 0.08) * n.len],
      Math.max(1.3, nLen * 0.022) * (0.9 + rng.next() * 0.5),
      rgb(r, g, b),
    );
  }
  ctx.fillStyle = '#7a5434';
  ctx.beginPath();
  ctx.ellipse(tx, ty, twigW * 0.6, twigW * 1.3, Math.atan2(uy, ux) + Math.PI / 2, 0, Math.PI * 2);
  ctx.fill();
}

// Pine atlas: left half = single tuft (close-up detail), right half = branchlet with several tufts (crown bulk).
function pineAtlas(seed) {
  const S = 512;
  const [cv, ctx] = canvas(S * 2, S);
  const rng = new RNG(seed);
  drawTuft(ctx, rng, S * 0.5, S * 0.99, S * 0.5 + rng.float(-14, 14), S * 0.42, S * 0.11, 420, 9);
  // branchlet
  const ox = S;
  const bx = ox + S * 0.5;
  const by = S * 0.995;
  const tips = [];
  const main = [bx + rng.float(-20, 20), S * 0.3];
  tips.push([bx, by, main[0], main[1], 1]);
  for (let k = 0; k < 6; k++) {
    const t = 0.25 + k * 0.1;
    const px = bx + (main[0] - bx) * t;
    const py = by + (main[1] - by) * t;
    const side = k % 2 ? 1 : -1;
    const len = S * (0.26 - k * 0.018) * rng.float(0.85, 1.1);
    const a = -Math.PI / 2 + side * rng.float(0.55, 0.85);
    tips.push([px, py, px + Math.cos(a) * len, py + Math.sin(a) * len, 0.75]);
  }
  ctx.strokeStyle = '#5c4029';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(main[0], main[1]);
  ctx.stroke();
  // draw farthest first
  for (const [x0, y0, x1, y1, sc] of tips.slice(1).concat([tips[0]])) {
    const tx = x0 + (x1 - x0) * 0.35;
    const ty = y0 + (y1 - y0) * 0.35;
    ctx.strokeStyle = '#5c4029';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    drawTuft(ctx, rng, tx, ty, x1, y1, S * 0.085 * sc, Math.round(150 * sc), 4);
  }
  return toTexture(cv);
}

// ── Norway spruce: flat, fishbone spray of short dark needles (seen from above) ──
function drawSpruceTwig(ctx, rng, x0, y0, ang, len, width, depth, fresh) {
  const steps = Math.max(4, Math.floor(len / 5));
  const pts = [];
  let a = ang;
  let x = x0;
  let y = y0;
  for (let i = 0; i <= steps; i++) {
    pts.push([x, y, a]);
    a += rng.float(-0.03, 0.03);
    x += Math.cos(a) * (len / steps);
    y += Math.sin(a) * (len / steps);
  }
  ctx.strokeStyle = '#4a3324';
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  for (let i = 0; i < pts.length; i++) {
    const [px, py, pa] = pts[i];
    const t = i / (pts.length - 1);
    const isFresh = t > 1 - fresh;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const na = pa + side * rng.float(0.7, 1.25) - 0.25 * side * k;
        const nl = rng.float(11, 17) * (1 - 0.25 * t) * (depth > 0 ? 1 : 0.9);
        const sh = 0.75 + 0.35 * rng.next();
        const col = isFresh
          ? rgb(98 * sh, 138 * sh, 56 * sh)
          : rgb((34 + 14 * rng.next()) * sh, (58 + 20 * rng.next()) * sh, (30 + 10 * rng.next()) * sh);
        needle(ctx, px, py, px + Math.cos(na) * nl, py + Math.sin(na) * nl, [0, 0], 2.1, col);
      }
    }
  }
  return pts;
}

function spruceSpray(seed) {
  const S = 512;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  const main = drawSpruceTwig(ctx, rng, S * 0.5, S * 0.99, -Math.PI / 2 + rng.float(-0.06, 0.06), S * 0.9, 5, 1, 0.12);
  const nSide = 11;
  for (let k = 0; k < nSide; k++) {
    const t = 0.08 + (k / nSide) * 0.84;
    const p = main[Math.floor(t * (main.length - 1))];
    const side = k % 2 ? 1 : -1;
    const len = S * 0.34 * (1 - t * 0.65) * rng.float(0.8, 1.1);
    const pts = drawSpruceTwig(ctx, rng, p[0], p[1], p[2] + side * rng.float(0.65, 0.95), len, 3, 1, 0.22);
    if (len > 70) {
      for (let j = 0; j < 2; j++) {
        const q = pts[Math.floor(rng.float(0.3, 0.7) * (pts.length - 1))];
        drawSpruceTwig(ctx, rng, q[0], q[1], q[2] + (j ? 1 : -1) * 0.8, len * 0.38, 2, 1, 0.3);
      }
    }
  }
  return toTexture(cv);
}

// Hanging "comb" twigs that curtain below the branches of Swedish spruces.
function spruceComb(seed) {
  const S = 512;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  const top = drawSpruceTwig(ctx, rng, S * 0.02, S * 0.05, 0.02, S * 0.96, 5, 1, 0.08);
  const n = 9;
  for (let k = 0; k < n; k++) {
    const p = top[Math.floor(((k + 0.5) / n) * (top.length - 1))];
    const len = S * rng.float(0.55, 0.9);
    const pts = drawSpruceTwig(ctx, rng, p[0], p[1], Math.PI / 2 + rng.float(-0.18, 0.18), len, 2.5, 1, 0.15);
    for (let j = 0; j < 2; j++) {
      const q = pts[Math.floor(rng.float(0.25, 0.65) * (pts.length - 1))];
      drawSpruceTwig(ctx, rng, q[0], q[1], q[2] + (j ? 0.5 : -0.5), len * 0.3, 1.8, 1, 0.3);
    }
  }
  return toTexture(cv);
}

// ── Leaves ───────────────────────────────────────────────────
function leafShape(ctx, len, wid, profile, serr = 0, teeth = 18) {
  const N = 40;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let w = profile(t) * wid;
    if (serr) {
      const tooth = Math.abs(Math.sin(t * teeth * Math.PI));
      w *= 1 - serr * (1 - tooth);
    }
    pts.push([w, -t * len]);
  }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(-pts[i][0], pts[i][1]);
  ctx.closePath();
}

const birchProfile = (t) => (t < 0.32 ? Math.pow(Math.sin(((t / 0.32) * Math.PI) / 2), 0.7) : Math.pow(1 - (t - 0.32) / 0.68, 1.15));

function drawLeaf(ctx, rng, x, y, ang, len, wid, base, profile, serr, veins = 7) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const [r, g, b] = base;
  const sh = rng.float(0.82, 1.12);
  const grad = ctx.createLinearGradient(-wid, 0, wid, 0);
  grad.addColorStop(0, rgb(r * 0.82 * sh, g * 0.85 * sh, b * 0.8 * sh));
  grad.addColorStop(0.5, rgb(r * 1.08 * sh, g * 1.06 * sh, b * sh));
  grad.addColorStop(1, rgb(r * 0.78 * sh, g * 0.82 * sh, b * 0.78 * sh));
  ctx.fillStyle = grad;
  leafShape(ctx, len, wid, profile, serr);
  ctx.fill();
  ctx.strokeStyle = rgb(r * 1.35, g * 1.25, b * 1.2, 0.55);
  ctx.lineWidth = Math.max(1, len * 0.025);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.95);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.7, len * 0.012);
  for (let i = 1; i <= veins; i++) {
    const t = i / (veins + 1);
    const w = profile(Math.min(1, t + 0.12)) * wid * 0.85;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, -t * len);
      ctx.lineTo(s * w, -(t + 0.12) * len);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Silver birch: a pendulous twig with small diamond-shaped leaves.
function birchTwig(seed) {
  const S = 512;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  const pts = [];
  let x = S * 0.5;
  let y = S * 0.01;
  let a = Math.PI / 2 + rng.float(-0.2, 0.2);
  for (let i = 0; i < 40; i++) {
    pts.push([x, y, a]);
    a += rng.float(-0.04, 0.04) + (S * 0.5 - x) * 0.0004;
    x += Math.cos(a) * 12;
    y += Math.sin(a) * 12;
  }
  ctx.strokeStyle = '#4a3528';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  const leaves = [];
  for (let i = 3; i < pts.length; i += 2) {
    const [px, py, pa] = pts[i];
    const side = (i / 2) % 2 ? 1 : -1;
    const n = rng.int(1, 2);
    for (let k = 0; k < n; k++) {
      const len = rng.float(52, 82) * (0.75 + 0.25 * (i / pts.length));
      const ang = pa - Math.PI / 2 + side * rng.float(0.5, 1.2) + Math.PI;
      leaves.push({ px, py, ang, len, depth: rng.next() });
    }
  }
  leaves.sort((p, q) => p.depth - q.depth);
  for (const l of leaves) {
    const fore = rng.float(0.65, 1.0);
    const base = rng.chance(0.15) ? [150, 170, 62] : [104, 146, 46];
    // petiole
    ctx.strokeStyle = '#6f7a3a';
    ctx.lineWidth = 1.6;
    const ex = l.px + Math.sin(l.ang) * -10;
    const ey = l.py + Math.cos(l.ang) * 10;
    ctx.beginPath();
    ctx.moveTo(l.px, l.py);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    drawLeaf(ctx, rng, ex, ey, l.ang, l.len, l.len * 0.42 * fore, base, birchProfile, 0.12, 6);
  }
  return toTexture(cv);
}

// Fallen birch leaves, yellow to brown, for the litter that gathers under the birches.
function birchLitter(seed) {
  const S = 256;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  for (let i = 0; i < 6; i++) {
    const x = S * rng.float(0.2, 0.8);
    const y = S * rng.float(0.3, 0.92);
    const len = rng.float(62, 92);
    const pick = rng.next();
    const base = pick < 0.45 ? [198, 150, 42] : pick < 0.75 ? [160, 98, 32] : [112, 72, 34];
    drawLeaf(ctx, rng, x, y, rng.float(0, 6.28), len, len * 0.46, base, birchProfile, 0.1, 5);
  }
  return toTexture(cv);
}

// Oak leaf for the sapling: lobed, fresh spring-green with a bronze blush.
function oakLeaf() {
  const S = 512;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(77);
  const len = S * 0.9;
  const lobes = 5;
  const profile = (t) => {
    const env = t < 0.08 ? 0.18 + t * 2.5 : Math.pow(Math.sin(Math.min(1, (t - 0.02) / 0.98) * Math.PI), 0.75) * (0.55 + 0.45 * t);
    const lobe = 0.58 + 0.42 * Math.pow(Math.abs(Math.cos((t * lobes + 0.15) * Math.PI)), 0.55);
    return t > 0.94 ? env * 0.9 : env * lobe;
  };
  ctx.save();
  ctx.translate(S * 0.5, S * 0.97);
  const grad = ctx.createRadialGradient(0, -len * 0.5, 10, 0, -len * 0.5, len * 0.6);
  grad.addColorStop(0, '#a9c552');
  grad.addColorStop(0.65, '#86ad3c');
  grad.addColorStop(1, '#9a8a3a');
  ctx.fillStyle = grad;
  leafShape(ctx, len, S * 0.36, profile, 0);
  ctx.fill();
  ctx.strokeStyle = 'rgba(214, 232, 150, 0.6)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.96);
  ctx.stroke();
  ctx.lineWidth = 2;
  for (let i = 0; i < lobes; i++) {
    const t = (i + 0.35) / lobes;
    const w = profile(Math.min(0.98, t + 0.06)) * S * 0.36 * 0.92;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, -t * len * 0.92);
      ctx.quadraticCurveTo(s * w * 0.5, -(t + 0.02) * len, s * w, -(t + 0.07) * len);
      ctx.stroke();
    }
  }
  // dew-darkened speckles / micro-variation
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(60, 90, 20, ${rng.float(0.03, 0.08)})`;
    const t = rng.next();
    ctx.beginPath();
    ctx.arc(rng.float(-0.3, 0.3) * S * profile(t), -t * len, rng.float(2, 7), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return toTexture(cv);
}

// ── Undergrowth ──────────────────────────────────────────────

// A single fern frond (Dryopteris-like), 256 × 1024.
function fernFrond(seed) {
  const W = 256;
  const H = 1024;
  const [cv, ctx] = canvas(W, H);
  const rng = new RNG(seed);
  const rach = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    rach.push([W * 0.5 + Math.sin(t * 2.4) * 6, H * (0.995 - t * 0.985)]);
  }
  const N = 26;
  for (let k = 0; k < N; k++) {
    const t = 0.1 + (k / N) * 0.88;
    const idx = Math.floor(t * 60);
    const [px, py] = rach[idx];
    const shape = Math.pow(Math.sin(Math.min(1, (t - 0.04) / 0.98) * Math.PI), 0.75) * (t < 0.3 ? 0.65 + t : 1);
    const L = W * 0.47 * shape;
    for (const side of [-1, 1]) {
      const ang = -Math.PI / 2 + side * (Math.PI / 2 - 0.42 - 0.2 * t);
      const nLob = Math.max(3, Math.floor(L / 9));
      for (let j = 0; j < nLob; j++) {
        const s = j / nLob;
        const lx = px + Math.cos(ang) * L * s * side * side;
        const ly = py + Math.sin(ang) * L * s - L * s * 0.12;
        const r = (L / nLob) * 0.95 * (1 - s * 0.55) + 2;
        const sh = rng.float(0.85, 1.1) * (0.85 + 0.25 * t);
        ctx.fillStyle = rgb(70 * sh, 112 * sh, 36 * sh);
        ctx.beginPath();
        ctx.ellipse(lx, ly, r * 1.05, r * 0.62, ang + Math.PI / 2 + side * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(150, 190, 90, 0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(ang) * L * 0.95, py + Math.sin(ang) * L * 0.95 - L * 0.11);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = '#7d8f42';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(rach[0][0], rach[0][1]);
  for (const p of rach) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
  return toTexture(cv);
}

// Blueberry (blåbär) sprigs: angular green stems with small oval leaves and a few berries.
function blueberry(seed) {
  const S = 256;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  const stems = rng.int(4, 6);
  const berries = [];
  for (let s = 0; s < stems; s++) {
    let x = S * rng.float(0.25, 0.75);
    let y = S;
    let a = -Math.PI / 2 + rng.float(-0.45, 0.45);
    const len = rng.int(8, 13);
    for (let i = 0; i < len; i++) {
      const nx = x + Math.cos(a) * 15;
      const ny = y + Math.sin(a) * 15;
      ctx.strokeStyle = '#5f8a2c';
      ctx.lineWidth = 2.6 - i * 0.12;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
      a += (i % 2 ? 1 : -1) * rng.float(0.15, 0.35);
      if (i > 2) {
        const side = i % 2 ? 1 : -1;
        const l = rng.float(18, 28);
        drawLeaf(ctx, rng, x, y, a + Math.PI / 2 + side * rng.float(0.8, 1.3), l, l * 0.5, [66, 106, 36], (t) => Math.pow(Math.sin(t * Math.PI), 0.7), 0.05, 3);
        if (rng.chance(0.12)) berries.push([x + side * 6, y + 8]);
      }
    }
  }
  for (const [bx, by] of berries) {
    const g = ctx.createRadialGradient(bx - 2, by - 2, 1, bx, by, 7);
    g.addColorStop(0, '#7d8cb4');
    g.addColorStop(0.45, '#33406a');
    g.addColorStop(1, '#1b2140');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(cv);
}

// Lingonberry (lingon): glossy dark leaves with clusters of red berries.
function lingon(seed) {
  const S = 256;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  for (let s = 0; s < 5; s++) {
    let x = S * rng.float(0.2, 0.8);
    let y = S;
    let a = -Math.PI / 2 + rng.float(-0.3, 0.3);
    for (let i = 0; i < 7; i++) {
      const nx = x + Math.cos(a) * 16;
      const ny = y + Math.sin(a) * 16;
      ctx.strokeStyle = '#6b5a33';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
      a += rng.float(-0.25, 0.25);
      for (const side of [-1, 1]) {
        const l = rng.float(20, 28);
        drawLeaf(ctx, rng, x, y, a + Math.PI / 2 + side * rng.float(0.9, 1.4), l, l * 0.55, [62, 104, 40], (t) => Math.pow(Math.sin(t * Math.PI), 0.55), 0, 2);
      }
    }
    if (rng.chance(0.7)) {
      for (let b = 0; b < rng.int(3, 6); b++) {
        const bx = x + rng.float(-10, 10);
        const by = y - rng.float(0, 14);
        const g = ctx.createRadialGradient(bx - 2, by - 2, 1, bx, by, 7);
        g.addColorStop(0, '#ff8a76');
        g.addColorStop(0.4, '#c8261c');
        g.addColorStop(1, '#6e0d0b');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(cv);
}

// Feather moss sprig (Pleurozium: red stem, yellow-green pinnate branches).
function featherMoss(seed) {
  const S = 256;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(seed);
  for (let s = 0; s < 3; s++) {
    let x = S * (0.3 + s * 0.2) + rng.float(-10, 10);
    let y = S;
    let a = -Math.PI / 2 + rng.float(-0.35, 0.35);
    const len = rng.int(14, 20);
    for (let i = 0; i < len; i++) {
      const nx = x + Math.cos(a) * 11;
      const ny = y + Math.sin(a) * 11;
      ctx.strokeStyle = '#8a4f2a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
      a += rng.float(-0.12, 0.12);
      const t = i / len;
      for (const side of [-1, 1]) {
        const bl = (1 - t) * 34 + 6;
        const ba = a + side * 0.95;
        let bx = x;
        let by = y;
        for (let k = 0; k < 6; k++) {
          const ex = bx + Math.cos(ba) * (bl / 6);
          const ey = by + Math.sin(ba) * (bl / 6);
          const sh = rng.float(0.8, 1.15) * (0.75 + 0.35 * t);
          ctx.strokeStyle = rgb(116 * sh, 134 * sh, 44 * sh);
          ctx.lineWidth = 3.2 - k * 0.35;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          bx = ex;
          by = ey;
        }
      }
    }
  }
  return toTexture(cv);
}

// Beard lichen (skägglav) hanging from dead spruce branches.
function beardLichen(seed) {
  const W = 128;
  const H = 512;
  const [cv, ctx] = canvas(W, H);
  const rng = new RNG(seed);
  for (let i = 0; i < 90; i++) {
    let x = W * 0.5 + rng.float(-30, 30);
    let y = 2;
    const len = rng.float(0.3, 0.98) * H;
    ctx.strokeStyle = rgb(170 + rng.float(-20, 20), 180 + rng.float(-20, 20), 150 + rng.float(-20, 20), 0.95);
    ctx.lineWidth = rng.float(1, 2.2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (y < len) {
      x += rng.float(-2.5, 2.5) + (W * 0.5 - x) * 0.01;
      y += rng.float(5, 10);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // canvas y grows downward; the lichen hangs from v = 1 (top) → we drew from top already.
  return toTexture(cv);
}

// Cut end of a log: growth rings, radial cracks, a bit of rot.
function woodEnd() {
  const S = 256;
  const [cv, ctx] = canvas(S, S);
  const rng = new RNG(5);
  const c = S / 2;
  for (let r = c; r > 0; r -= 1) {
    const ring = Math.sin(r * 0.9 + Math.sin(r * 0.13) * 3) * 0.5 + 0.5;
    const shade = 0.72 + 0.28 * ring;
    ctx.fillStyle = rgb(150 * shade, 118 * shade, 82 * shade);
    ctx.beginPath();
    ctx.arc(c + rng.float(-0.4, 0.4), c + rng.float(-0.4, 0.4), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(40, 26, 16, 0.85)';
  for (let i = 0; i < 9; i++) {
    const a = rng.float(0, Math.PI * 2);
    ctx.lineWidth = rng.float(1, 3);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 10, c + Math.sin(a) * 10);
    ctx.lineTo(c + Math.cos(a + 0.05) * c * rng.float(0.5, 0.98), c + Math.sin(a + 0.05) * c * rng.float(0.5, 0.98));
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(c, c, c * 0.75, c, c, c);
  g.addColorStop(0, 'rgba(60,40,25,0)');
  g.addColorStop(1, 'rgba(60,40,25,0.9)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(cv);
}

export function createFoliageTextures({ res = 1, anisotropy = 8 } = {}) {
  RES = res;
  ANISO = anisotropy;
  return {
    pine: [pineAtlas(11), pineAtlas(23), pineAtlas(37)],
    spruce: [spruceSpray(31), spruceSpray(47), spruceSpray(59)],
    spruceComb: spruceComb(53),
    birch: [birchTwig(61), birchTwig(73), birchTwig(89)],
    oak: oakLeaf(),
    fern: [fernFrond(81), fernFrond(97)],
    blueberry: blueberry(101),
    lingon: lingon(113),
    moss: featherMoss(127),
    lichen: beardLichen(131),
    litter: birchLitter(137),
    woodEnd: woodEnd(),
  };
}
