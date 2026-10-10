// Pick a rendering budget for this device. Override with ?quality=low|medium|high|ultra
// `pixels` caps the 3D drawing buffer (the HTML layer always stays sharp).
const PRESETS = {
  ultra: {
    tier: 'ultra',
    maxDpr: 2.0,
    pixels: 5.6e6,
    msaa: 4,
    shadows: true,
    softShadows: true,
    shadowSize: 4096,
    shadowExtent: 36,
    shadowEvery: 1,
    volumetric: true,
    volScale: 0.5,
    volSteps: 56,
    trees: 760,
    nearRadius: 28,
    plants: 1.3,
    dof: true,
    groundSegs: 440,
    tex: 2, // baked surface textures: 2 → 1024×2048 bark, 2048² moss and litter
    foliageRes: 2, // canvas-painted leaves and needles
    anisotropy: 16,
    detail: 2, // tessellation of the trees nearest the walk
    pom: true, // parallax occlusion mapping on bark and the forest floor
    ssao: true, // screen-space ambient occlusion
    pbrFoliage: true, // physically based leaves with a wet sheen
    leafDew: true, // dew drops on the shrubs around the sapling
  },
  high: {
    tier: 'high',
    maxDpr: 1.5,
    pixels: 2.6e6,
    msaa: 4,
    shadows: true,
    softShadows: true,
    shadowSize: 4096,
    shadowExtent: 40,
    shadowEvery: 1,
    volumetric: true,
    volScale: 0.5,
    volSteps: 36,
    trees: 620,
    nearRadius: 24,
    plants: 1,
    dof: true,
    groundSegs: 380,
    tex: 1.5,
    foliageRes: 1.5,
    anisotropy: 8,
    detail: 1.5,
    pom: true,
    ssao: true,
    pbrFoliage: true,
    leafDew: true,
  },
  medium: {
    tier: 'medium',
    maxDpr: 1.5,
    pixels: 1.25e6,
    msaa: 4,
    shadows: true,
    softShadows: true, // bilinear PCF: same cost as hard PCF here, and the glide's canopy dapples stay smooth instead of blocky
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
    tex: 1,
    foliageRes: 1,
    anisotropy: 8,
    detail: 1,
    pom: false,
    ssao: true,
    pbrFoliage: false,
    leafDew: false,
  },
  low: {
    tier: 'low',
    maxDpr: 1.0,
    pixels: 0.65e6,
    msaa: 0,
    shadows: true,
    softShadows: true, // bilinear PCF: same cost as hard PCF here, and the glide's canopy dapples stay smooth instead of blocky
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
    tex: 0.5,
    foliageRes: 1,
    anisotropy: 4,
    detail: 0.7,
    pom: false,
    ssao: false,
    pbrFoliage: false,
    leafDew: false,
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
  const cores = navigator.hardwareConcurrency || 8;
  let tier = coarse || smallScreen ? 'low' : 'high';
  if (tier === 'high' && cores <= 4) tier = 'medium';

  const name = gpuName(gl);
  const software = /swiftshader|llvmpipe|software|basic render/i.test(name);
  // Apple silicon and discrete GPUs have the headroom for the full-fidelity forest.
  const appleSilicon = /apple m\d|apple gpu|apple a1[5-9]|apple a2/i.test(name) || (/apple/i.test(name) && /metal/i.test(name));
  const discrete = /rtx|gtx|rx\s?\d|arc|quadro|radeon pro/i.test(name);
  // integrated GPUs: Intel UHD/Iris, AMD "Radeon(TM) 780M/890M Graphics", Vega, mobile chips
  const integrated =
    /intel|uhd|iris|mali|adreno|powervr|vega/i.test(name) || /radeon\(tm\)\s*(\d+m\s+)?graphics/i.test(name);
  if (software) tier = 'low';
  else if (tier === 'high' && (discrete || (appleSilicon && cores >= 8))) tier = 'ultra';
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
