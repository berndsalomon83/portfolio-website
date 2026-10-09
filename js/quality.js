// Pick a rendering budget for this device. Override with ?quality=low|medium|high
// `pixels` caps the 3D drawing buffer (the HTML layer always stays sharp).
const PRESETS = {
  high: {
    tier: 'high',
    maxDpr: 1.5,
    pixels: 2.4e6,
    msaa: 4,
    shadows: true,
    shadowSize: 4096,
    shadowExtent: 44,
    shadowEvery: 1,
    volumetric: true,
    volScale: 0.5,
    volSteps: 36,
    trees: 620,
    nearRadius: 24,
    plants: 1,
    dof: true,
    groundSegs: 380,
  },
  medium: {
    tier: 'medium',
    maxDpr: 1.5,
    pixels: 1.25e6,
    msaa: 4,
    shadows: true,
    shadowSize: 2048,
    shadowExtent: 34,
    shadowEvery: 2,
    volumetric: true,
    volScale: 0.3,
    volSteps: 22,
    trees: 480,
    nearRadius: 20,
    plants: 0.7,
    dof: true,
    groundSegs: 300,
  },
  low: {
    tier: 'low',
    maxDpr: 1.0,
    pixels: 0.65e6,
    msaa: 0,
    shadows: true,
    shadowSize: 1024,
    shadowExtent: 26,
    shadowEvery: 3,
    volumetric: false,
    volScale: 0.25,
    volSteps: 16,
    trees: 260,
    nearRadius: 14,
    plants: 0.35,
    dof: false,
    groundSegs: 200,
  },
};

export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

export function detectQuality(gl) {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && PRESETS[forced]) return { ...PRESETS[forced] };

  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(screen.width, screen.height) < 720;
  let tier = coarse || smallScreen ? 'low' : 'high';
  if (tier === 'high' && (navigator.hardwareConcurrency || 8) <= 4) tier = 'medium';

  const name = gpuName(gl);
  const software = /swiftshader|llvmpipe|software|basic render/i.test(name);
  // integrated GPUs: Intel UHD/Iris, AMD "Radeon(TM) 780M/890M Graphics", Vega, mobile chips
  const integrated =
    /intel|uhd|iris|mali|adreno|powervr|apple gpu|vega/i.test(name) || /radeon\(tm\)\s*(\d+m\s+)?graphics/i.test(name);
  const discrete = /rtx|gtx|rx\s?\d|arc|quadro|radeon pro/i.test(name);
  if (software) tier = 'low';
  else if (tier === 'high' && integrated && !discrete) tier = 'medium';
  return { ...PRESETS[tier] };
}

export function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}
