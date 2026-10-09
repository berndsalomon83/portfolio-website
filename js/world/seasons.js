// The year in the forest. A season value runs continuously from 0 to 4 and wraps around:
// 0 = 1 March, 1 = 1 June, 2 = 1 September, 3 = 1 December. Each season's look below is its
// mid-point (mid-April, mid-July, mid-October, mid-January); everything in between is blended.

export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];

export function seasonFromDate(d = new Date()) {
  const m = d.getMonth() + (d.getDate() - 1) / 31; // 0 … 12
  return ((((m - 2) / 3) % 4) + 4) % 4;
}

export function seasonIndex(v) {
  return Math.floor(((v % 4) + 4) % 4);
}

const one = [1, 1, 1];

// Plant groups: `color` = the season's leaf colour (linear RGB of an average leaf), `amount` = how far the
// leaves are recoloured toward it (0 = their natural summer colour), `loss` = share of leaves/plants gone.
const g = (color, amount = 0, loss = 0) => ({ color, amount, loss });

const PRESETS = [
  // ── Spring: thin, fresh light-green birches, pollen in the air, cooler clear light ──
  {
    sun: [1.0, 0.93, 0.8], sunI: 3.3,
    sky: [0.97, 1.0, 1.02], hemiSky: [0.6, 0.74, 0.88], hemiGround: [0.13, 0.15, 0.08], hemiI: 0.86,
    fog: [0.3, 0.37, 0.34], fogMul: 0.9, volMul: 0.9, exposure: 1.0, warmth: 0.55, saturation: 1.04,
    birch: g([0.3, 0.6, 0.08], 0.55, 0.22),
    conifer: g([0.08, 0.16, 0.06]),
    berry: g([0.2, 0.45, 0.07], 0.35),
    lingon: g([0.06, 0.14, 0.04]),
    fern: g([0.22, 0.5, 0.07], 0.35, 0.3),
    grass: g([0.2, 0.42, 0.07], 0.35, 0.1),
    moss: g([0.3, 0.42, 0.06], 0.3),
    ground: [0.98, 1.02, 0.95], litter: 0.08, snow: 0,
    leaves: 0, snowfall: 0, dust: 1.35, dew: 1,
  },
  // ── Summer: the original midsummer morning ──
  {
    sun: [1.0, 0.86, 0.68], sunI: 3.4,
    sky: one, hemiSky: [0.58, 0.7, 0.84], hemiGround: [0.13, 0.13, 0.075], hemiI: 0.82,
    fog: [0.3, 0.36, 0.34], fogMul: 1.0, volMul: 1.0, exposure: 1.0, warmth: 1.0, saturation: 1.0,
    birch: g([0.22, 0.42, 0.06]),
    conifer: g([0.08, 0.16, 0.06]),
    berry: g([0.12, 0.26, 0.05]),
    lingon: g([0.06, 0.14, 0.04]),
    fern: g([0.14, 0.3, 0.05]),
    grass: g([0.12, 0.22, 0.04]),
    moss: g([0.2, 0.28, 0.05]),
    ground: one, litter: 0, snow: 0,
    leaves: 0, snowfall: 0, dust: 1.0, dew: 1,
  },
  // ── Autumn: golden birches, red blueberry shrubs, copper ferns, misty and warm ──
  {
    sun: [1.0, 0.76, 0.5], sunI: 3.15,
    sky: [1.04, 0.98, 0.9], hemiSky: [0.62, 0.66, 0.72], hemiGround: [0.16, 0.12, 0.07], hemiI: 0.8,
    fog: [0.33, 0.34, 0.3], fogMul: 1.0, volMul: 0.88, exposure: 0.95, warmth: 1.45, saturation: 1.06,
    birch: g([0.62, 0.34, 0.03], 0.92, 0.32),
    conifer: g([0.08, 0.16, 0.06]),
    berry: g([0.55, 0.09, 0.04], 0.8, 0.08),
    lingon: g([0.06, 0.14, 0.04]),
    fern: g([0.42, 0.17, 0.04], 0.85, 0.22),
    grass: g([0.42, 0.34, 0.13], 0.75, 0.1),
    moss: g([0.3, 0.3, 0.07], 0.3),
    ground: [1.06, 0.95, 0.82], litter: 1, snow: 0,
    leaves: 1, snowfall: 0, dust: 0.55, dew: 1,
  },
  // ── Winter: snow on the ground and on the crowns, bare birches, pale low light ──
  {
    sun: [0.93, 0.94, 1.0], sunI: 2.6,
    sky: [0.92, 0.97, 1.08], hemiSky: [0.62, 0.72, 0.9], hemiGround: [0.3, 0.32, 0.36], hemiI: 0.9,
    fog: [0.36, 0.41, 0.46], fogMul: 0.85, volMul: 0.55, exposure: 0.62, warmth: -0.35, saturation: 0.86,
    birch: g([0.22, 0.42, 0.06], 0, 1),
    conifer: g([0.06, 0.12, 0.08], 0.25),
    berry: g([0.25, 0.1, 0.06], 0.7, 0.97),
    lingon: g([0.06, 0.14, 0.04], 0, 0.93),
    fern: g([0.3, 0.16, 0.07], 0.9, 0.98),
    grass: g([0.4, 0.34, 0.2], 0.9, 0.95),
    moss: g([0.2, 0.28, 0.05], 0.1, 0.9),
    ground: one, litter: 0.25, snow: 1,
    leaves: 0, snowfall: 1, dust: 0.25, dew: 0,
  },
];

function blend(a, b, t) {
  if (typeof a === 'number') return a + (b - a) * t;
  if (Array.isArray(a)) return a.map((v, i) => v + (b[i] - v) * t);
  const out = {};
  for (const k of Object.keys(a)) out[k] = blend(a[k], b[k], t);
  return out;
}

const ease = (t) => t * t * (3 - 2 * t);

export function seasonParams(v) {
  const x = (((v - 0.5) % 4) + 4) % 4; // 0 at mid-spring
  const i = Math.floor(x);
  const t = ease(x - i);
  return blend(PRESETS[i], PRESETS[(i + 1) % 4], t);
}

// The value shown in the scene glides toward the chosen one along the shorter way round the year.
export class SeasonState {
  constructor(value = seasonFromDate()) {
    this.target = value;
    this.value = value;
    this.params = seasonParams(value);
  }

  set(v) {
    this.target = ((v % 4) + 4) % 4;
  }

  update(dt) {
    let d = this.target - this.value;
    if (d > 2) d -= 4;
    if (d < -2) d += 4;
    const k = 1 - Math.exp(-dt * 2.2);
    this.value = (((this.value + d * k) % 4) + 4) % 4;
    if (Math.abs(d) < 1e-4) this.value = this.target;
    this.params = seasonParams(this.value);
    return this.params;
  }
}
