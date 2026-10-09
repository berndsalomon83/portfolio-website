// Liquid-glass rims: near the edges of every glass panel the blurred forest behind it bends gently
// inward, like light through the curved edge of a lens.
//
// Works in Chromium browsers (Chrome, Edge, Brave, Opera), which accept SVG filters inside
// `backdrop-filter`. Elsewhere the panels simply keep their frosted glass.

const SVG_NS = 'http://www.w3.org/2000/svg';

function supported() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand).join(' ') ?? '';
  const chromium = /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/.test(brands) || (/Chrome\//.test(ua) && !/Firefox|FxiOS|CriOS/.test(ua));
  if (!chromium) return false;
  if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return false;
  if (matchMedia('(pointer: coarse)').matches) return false; // keep phones light
  return CSS.supports('backdrop-filter', 'url(#a) blur(1px)');
}

// Displacement map for a rounded rectangle: neutral grey inside, and within `band` px of the edge
// a vector pointing inward that grows smoothly toward the rim (R = x offset, G = y offset).
function displacementMap(w, h, radius, band, k = 0.5) {
  const W = Math.max(8, Math.round(w * k));
  const H = Math.max(8, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const bx = w / 2;
  const by = h / 2;
  const r = Math.min(radius, bx, by);
  const sdf = (x, y) => {
    const qx = Math.abs(x) - (bx - r);
    const qy = Math.abs(y) - (by - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / k - bx;
      const y = (j + 0.5) / k - by;
      const inside = -sdf(x, y);
      let t = 1 - inside / band;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const m = t * t * (3 - 2 * t);
      let gx = sdf(x + 0.75, y) - sdf(x - 0.75, y);
      let gy = sdf(x, y + 0.75) - sdf(x, y - 0.75);
      const gl = Math.hypot(gx, gy) || 1;
      gx /= gl;
      gy /= gl;
      const o = (j * W + i) * 4;
      d[o] = 128 - gx * 127 * m;
      d[o + 1] = 128 - gy * 127 * m;
      d[o + 2] = 255 * Math.pow(m, 1.4); // B: how strongly the crisp, bent rim shows through
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

export function initLiquidGlass(selector = '.glass, .btn:not(.btn--primary), .nav__cta') {
  if (!supported()) return;
  document.documentElement.classList.add('liquid');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);

  const state = new Map();
  let uid = 0;

  const node = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const OPAQUE = '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1';

  const build = (el) => {
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (w < 8 || h < 8) return;
    let s = state.get(el);
    if (s && Math.abs(s.w - w) < 2 && Math.abs(s.h - h) < 2) return;
    if (!s) {
      // the CSS backdrop (blur + tone) is split: the blur moves into the SVG filter, the tone stays in CSS
      const css = getComputedStyle(el).backdropFilter || '';
      const blur = parseFloat((css.match(/blur\(([\d.]+)px\)/) || [])[1] || 16);
      const tone = css.replace(/blur\([^)]*\)/, '').trim();
      s = { id: `liquid-${++uid}`, blur, tone: tone === 'none' ? '' : tone };
      state.set(el, s);
    }
    s.w = w;
    s.h = h;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const big = el.classList.contains('glass');
    // gentle: a narrow rim and a few pixels of bend at most
    const band = big ? Math.min(24, Math.max(14, Math.min(w, h) * 0.075)) : Math.min(13, h * 0.4);
    const scale = big ? 20 : 12;
    const box = { x: 0, y: 0, width: w, height: h };

    const filter = node('filter', { id: s.id, ...box, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    filter.append(
      node('feImage', { href: displacementMap(w, h, radius, band), ...box, preserveAspectRatio: 'none', result: 'map' }),
      // frosted centre. Blurs fade toward transparent at the filter border; resetting alpha to 1
      // (feColorMatrix works on un-premultiplied colour) restores the true colour there — no dark rims.
      node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: s.blur, edgeMode: 'duplicate', result: 'frostRaw' }),
      node('feColorMatrix', { in: 'frostRaw', type: 'matrix', values: OPAQUE, result: 'frost' }),
      // the rim: the unblurred forest, bent inward (sampling always stays inside the panel)
      node('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'lens' }),
      // the map's blue channel says how much rim shows: none in the middle, most right at the edge
      node('feColorMatrix', { in: 'map', type: 'matrix', values: `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 ${big ? 0.8 : 0.7} 0 0`, result: 'edge' }),
      node('feComposite', { in: 'lens', in2: 'edge', operator: 'in', result: 'rim' }),
      node('feMerge', {}),
    );
    const merge = filter.lastChild;
    merge.append(node('feMergeNode', { in: 'frost' }), node('feMergeNode', { in: 'rim' }));
    document.getElementById(s.id)?.remove();
    defs.appendChild(filter);
    el.style.backdropFilter = `url(#${s.id}) ${s.tone}`.trim();
  };

  const elements = [...document.querySelectorAll(selector)];
  let queued = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const el of queued) build(el);
    queued = new Set();
  };
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) queued.add(e.target);
    if (!frame) frame = setTimeout(flush, 60);
  });
  elements.forEach((el) => ro.observe(el));
}
