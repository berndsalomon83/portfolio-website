import * as THREE from 'three';
import { HASH_GLSL, PERIODIC_GLSL } from './noise.glsl.js';
import { fullscreenTriangle } from '../lib/geometry.js';

// GPU texture baker: every bark / moss / litter / rock texture is painted by a shader into a
// tileable render target once at start-up (colour + roughness, normal + height).

export const SURF = {
  PINE_LOWER: 0,
  PINE_UPPER: 1,
  SPRUCE: 2,
  BIRCH: 3,
  BIRCH_BASE: 4,
  MOSS: 5,
  LITTER: 6,
  ROCK: 7,
  NOISE: 8,
  DEADWOOD: 9,
};

const SURFACES_GLSL = /* glsl */ `
uniform int uType;
uniform int uMode;
uniform vec2 uRes;
uniform float uNormalStrength;

struct Surf { float h; vec3 col; float rough; };

vec2 warp2(vec2 uv, float f, float seed, int oct) {
  return vec2(pfbm(uv * f + seed, vec2(f), oct), pfbm(uv * f + seed + vec2(5.2, 1.3), vec2(f), oct));
}

// Thick, deeply fissured plates (old Scots pine foot, birch base).
Surf platedBark(vec2 uv, vec2 rep, vec3 cPlate, vec3 cPlate2, vec3 cFiss, vec3 cWall, float seed) {
  vec2 w = warp2(uv, 4.0, seed, 4);
  vec3 c = pworley(uv * rep + w * vec2(1.0, 0.8), rep, 0.95);
  float edge = c.y - c.x;
  float plate = smoothstep(0.02, 0.28, edge);
  vec2 rep2 = rep * 3.0;
  vec3 c2 = pworley(uv * rep2 + w * 2.5 + c.z * 7.0, rep2, 0.9);
  float crack2 = smoothstep(0.0, 0.14, c2.y - c2.x);
  float fl = pfbm(uv * vec2(16.0, 32.0) + seed, vec2(16.0, 32.0), 5);
  float strata = pfbm(vec2(uv.x * 8.0, uv.y * 64.0) + seed, vec2(8.0, 64.0), 3);
  float h = plate * (0.55 + 0.2 * c.z + 0.15 * fl + 0.08 * strata) * mix(0.8, 1.0, crack2);
  h += 0.035 * pfbm(uv * 128.0 + seed, vec2(128.0), 3);
  vec3 top = mix(cPlate, cPlate2, smoothstep(0.5, 0.85, h + 0.15 * fl));
  top = mix(top, cWall, (1.0 - crack2) * 0.35);
  vec3 fis = mix(cFiss, cWall, smoothstep(0.0, 0.2, edge) * 0.8);
  vec3 col = mix(fis, top, plate);
  col *= 0.82 + 0.36 * c.z;
  col *= 0.92 + 0.16 * strata;
  Surf s; s.h = h; s.col = col; s.rough = mix(1.0, 0.86, plate);
  return s;
}

// Thin, papery, fox-red flakes of the upper Scots pine trunk.
Surf pineUpper(vec2 uv) {
  vec2 rep = vec2(8.0, 18.0);
  vec2 w = warp2(uv, 6.0, 3.7, 3);
  vec3 c = pworley(uv * rep + w * 0.7, rep, 0.95);
  float edge = c.y - c.x;
  float flake = smoothstep(0.0, 0.18, edge);
  float fib = pfbm(vec2(uv.x * 24.0, uv.y * 96.0), vec2(24.0, 96.0), 4);
  float big = pfbm(uv * vec2(3.0, 6.0) + 1.3, vec2(3.0, 6.0), 4);
  float curl = smoothstep(0.2, 0.9, 1.0 - c.x);
  float h = flake * (0.45 + 0.35 * c.z + 0.2 * curl) + 0.08 * fib;
  vec3 col = mix(vec3(0.50, 0.24, 0.12), vec3(0.80, 0.45, 0.24), flake);
  col = mix(col, vec3(0.92, 0.66, 0.45), flake * smoothstep(0.55, 1.0, c.z * 0.7 + curl * 0.5));
  col = mix(col, vec3(0.60, 0.52, 0.47), smoothstep(0.15, 0.55, big) * 0.3);
  col *= 0.9 + 0.2 * fib;
  Surf s; s.h = h; s.col = col; s.rough = 0.78;
  return s;
}

// Norway spruce: grey-brown round scales with lichen.
Surf spruceBark(vec2 uv) {
  vec2 rep = vec2(12.0, 18.0);
  vec2 w = warp2(uv, 5.0, 8.1, 3);
  vec3 c = pworley(uv * rep + w * 0.6, rep, 0.95);
  float edge = c.y - c.x;
  float sc = smoothstep(0.0, 0.2, edge);
  float dome = 1.0 - smoothstep(0.0, 0.75, c.x);
  float fine = pfbm(uv * 64.0, vec2(64.0), 4);
  float lich = smoothstep(0.18, 0.4, pfbm(uv * vec2(4.0, 6.0) + 2.0, vec2(4.0, 6.0), 5));
  float lichDots = smoothstep(0.5, 0.68, pfbm(uv * vec2(20.0, 30.0), vec2(20.0, 30.0), 3));
  float h = sc * (0.45 + 0.35 * dome + 0.15 * c.z) + 0.06 * fine;
  vec3 col = mix(vec3(0.15, 0.11, 0.09), mix(vec3(0.42, 0.33, 0.28), vec3(0.52, 0.37, 0.28), c.z), sc);
  col = mix(col, vec3(0.30, 0.25, 0.22), smoothstep(0.3, 0.0, dome) * sc * 0.5);
  float L = max(lich * 0.6, lichDots) * sc;
  col = mix(col, vec3(0.62, 0.67, 0.55), L * 0.7);
  h += L * 0.08;
  Surf s; s.h = h; s.col = col * (0.9 + 0.2 * fine); s.rough = 0.92;
  return s;
}

// Silver birch: chalk-white with horizontal lenticels and black patches.
Surf birchBark(vec2 uv) {
  float n = pfbm(uv * vec2(4.0, 8.0), vec2(4.0, 8.0), 5);
  float band = pfbm(vec2(uv.x * 3.0, uv.y * 56.0) + 4.0, vec2(3.0, 56.0), 3);
  vec3 col = mix(vec3(0.84, 0.83, 0.80), vec3(0.95, 0.93, 0.90), n * 0.6 + 0.5);
  col = mix(col, vec3(0.90, 0.79, 0.71), smoothstep(0.15, 0.55, band) * 0.35);
  vec2 rep = vec2(4.0, 72.0);
  vec3 c = pworley(uv * rep + vec2(n * 0.8, 0.0), rep, 0.9);
  float dens = smoothstep(0.15, 0.75, pfbm(uv * vec2(2.0, 7.0) + 21.0, vec2(2.0, 7.0), 3) * 0.5 + 0.5);
  float len = smoothstep(0.5, 0.2, c.x) * step(0.55 - 0.3 * dens, c.z);
  vec2 rep2 = vec2(2.0, 110.0);
  vec3 c2l = pworley(uv * rep2 + vec2(n * 0.5, 3.0), rep2, 0.9);
  float len2 = smoothstep(0.42, 0.12, c2l.x) * step(0.72, c2l.z);
  len = max(len, len2);
  col = mix(col, vec3(0.17, 0.14, 0.13), len * 0.92);
  float grime = smoothstep(0.3, 0.7, pfbm(uv * vec2(3.0, 4.0) + 13.0, vec2(3.0, 4.0), 4) * 0.5 + 0.5);
  col = mix(col, col * vec3(0.78, 0.78, 0.76), grime * 0.35);
  float blk = pfbm(uv * vec2(3.0, 5.0) + 9.0, vec2(3.0, 5.0), 6);
  float blkM = smoothstep(0.38, 0.44, blk);
  vec3 c2 = pworley(uv * vec2(6.0, 20.0), vec2(6.0, 20.0), 0.9);
  float crk = (1.0 - smoothstep(0.0, 0.1, c2.y - c2.x)) * smoothstep(0.15, 0.3, blk);
  col = mix(col, vec3(0.10, 0.09, 0.085), max(blkM, crk));
  col = mix(col, vec3(0.70, 0.74, 0.66), smoothstep(0.1, 0.5, pfbm(uv * vec2(2.0, 3.0) + 3.0, vec2(2.0, 3.0), 3)) * 0.22);
  float h = 0.55 + 0.12 * n - 0.25 * blkM - 0.2 * len - 0.3 * crk + 0.06 * band;
  Surf s; s.h = h; s.col = col; s.rough = mix(0.55, 0.9, blkM);
  return s;
}

// Feather-moss carpet (Hylocomium / Pleurozium).
Surf mossSurf(vec2 uv) {
  vec2 w = warp2(uv, 6.0, 1.1, 3);
  vec3 c = pworley(uv * 24.0 + w * 1.2, vec2(24.0), 1.0);
  float clump = 1.0 - smoothstep(0.0, 0.95, c.x);
  float r1 = 1.0 - abs(pfbm(uv * 96.0 + w, vec2(96.0), 4));
  float r2 = pfbm(uv * 256.0, vec2(256.0), 2);
  float h = clump * 0.55 + pow(r1, 3.0) * 0.35 + r2 * 0.1;
  float region = pfbm(uv * 3.0 + 7.0, vec2(3.0), 4) * 0.5 + 0.5;
  vec3 deep = vec3(0.17, 0.27, 0.06), mid = vec3(0.40, 0.50, 0.12), tip = vec3(0.64, 0.68, 0.27), dry = vec3(0.50, 0.40, 0.21);
  vec3 col = mix(deep, mid, smoothstep(0.25, 0.75, region + (clump - 0.5) * 0.4));
  col = mix(col, tip, smoothstep(0.55, 0.95, h) * 0.55);
  col = mix(col, dry, smoothstep(0.62, 0.8, pfbm(uv * 12.0 + 3.0, vec2(12.0), 3) * 0.5 + 0.5) * 0.5);
  col *= mix(0.35, 1.0, smoothstep(0.05, 0.55, h));
  Surf s; s.h = h; s.col = col; s.rough = 0.62;
  return s;
}

float segD(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

// Needle litter: thousands of fallen pine needles on dark humus.
Surf litterSurf(vec2 uv) {
  const float G = 16.0;
  vec2 p = uv * G;
  vec2 ip = floor(p);
  float best = -1.0, bestProf = 0.0;
  vec3 bestCol = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(ip + g, G);
      for (int k = 0; k < 6; k++) {
        vec3 r = hash32(cell * 1.37 + float(k) * 17.13);
        vec2 ctr = ip + g + hash22(cell + float(k) * 5.71);
        float ang = r.x * 6.28318;
        float len = 0.6 + 0.4 * r.y;
        vec2 d = vec2(cos(ang), sin(ang)) * len * 0.5;
        float dist = segD(p, ctr - d, ctr + d);
        float wdt = 0.022 + 0.01 * r.z;
        if (dist < wdt) {
          float layer = r.z + float(k) * 0.013;
          if (layer > best) {
            best = layer;
            bestProf = 1.0 - dist / wdt;
            float hc = hash12(cell + float(k) * 3.1);
            bestCol = mix(vec3(0.50, 0.31, 0.17), vec3(0.66, 0.53, 0.38), hc);
            bestCol = mix(bestCol, vec3(0.36, 0.26, 0.17), step(0.72, hash12(cell * 2.3 + float(k))));
          }
        }
      }
    }
  }
  float soil = pfbm(uv * 32.0, vec2(32.0), 4);
  vec3 base = mix(vec3(0.11, 0.075, 0.05), vec3(0.24, 0.17, 0.11), soil * 0.5 + 0.5);
  float sp = smoothstep(0.35, 0.6, pfbm(uv * 8.0 + 11.0, vec2(8.0), 4));
  base = mix(base, vec3(0.28, 0.36, 0.10), sp * 0.6);
  float has = step(0.0, best);
  float prof = sqrt(max(bestProf, 0.0));
  float h = mix(0.2 + 0.15 * soil, 0.45 + 0.4 * best + 0.15 * prof, has);
  vec3 col = mix(base, bestCol * (0.72 + 0.28 * prof), has);
  Surf s; s.h = h; s.col = col; s.rough = mix(0.95, 0.72, has);
  return s;
}

// Swedish granite with lichen crusts.
Surf rockSurf(vec2 uv) {
  float n = pfbm(uv * 6.0, vec2(6.0), 6);
  float n2 = pfbm(uv * 24.0 + 3.0, vec2(24.0), 4);
  vec2 gc = mod(floor(uv * 512.0), 512.0);
  float g = hash12(gc);
  vec3 col = mix(vec3(0.36, 0.355, 0.35), vec3(0.56, 0.54, 0.52), n * 0.5 + 0.5);
  col = mix(col, vec3(0.64, 0.50, 0.45), step(0.82, g) * 0.45);
  col = mix(col, vec3(0.12, 0.12, 0.13), step(0.94, hash12(gc + 7.0)) * 0.6);
  float lc = smoothstep(0.12, 0.22, pfbm(uv * 5.0 + 9.0, vec2(5.0), 5));
  float lc2 = smoothstep(0.2, 0.3, pfbm(uv * 9.0 + 2.0, vec2(9.0), 4));
  col = mix(col, vec3(0.70, 0.73, 0.62), lc * 0.75);
  col = mix(col, vec3(0.76, 0.75, 0.42), lc2 * (1.0 - lc) * 0.55);
  float h = 0.5 + 0.3 * n + 0.12 * n2 + 0.03 * g + 0.06 * lc;
  Surf s; s.h = h; s.col = col; s.rough = mix(0.72, 0.9, lc);
  return s;
}

// Weathered dead wood (fallen log without bark / broken branch ends).
Surf deadwood(vec2 uv) {
  float grain = pfbm(vec2(uv.x * 40.0, uv.y * 3.0), vec2(40.0, 3.0), 5);
  float cracks = smoothstep(0.02, 0.0, abs(pfbm(vec2(uv.x * 10.0, uv.y * 1.0) + 2.0, vec2(10.0, 1.0), 4)));
  float n = pfbm(uv * 4.0, vec2(4.0), 4);
  vec3 col = mix(vec3(0.42, 0.37, 0.32), vec3(0.62, 0.58, 0.52), grain * 0.5 + 0.5);
  col = mix(col, vec3(0.30, 0.22, 0.16), smoothstep(0.0, 0.5, n) * 0.4);
  col = mix(col, vec3(0.08, 0.06, 0.05), cracks);
  float h = 0.5 + 0.25 * grain - 0.4 * cracks;
  Surf s; s.h = h; s.col = col; s.rough = 0.9;
  return s;
}

Surf evalSurf(vec2 uv) {
  Surf s;
  s.h = 0.0;
  s.col = vec3(0.0);
  s.rough = 1.0;
  if (uType == 0) s = platedBark(uv, vec2(5.0, 4.0), vec3(0.40, 0.34, 0.30), vec3(0.57, 0.54, 0.50), vec3(0.10, 0.06, 0.045), vec3(0.54, 0.28, 0.15), 0.0);
  else if (uType == 1) s = pineUpper(uv);
  else if (uType == 2) s = spruceBark(uv);
  else if (uType == 3) s = birchBark(uv);
  else if (uType == 4) s = platedBark(uv, vec2(4.0, 5.0), vec3(0.20, 0.19, 0.18), vec3(0.40, 0.39, 0.37), vec3(0.04, 0.035, 0.03), vec3(0.17, 0.14, 0.12), 3.3);
  else if (uType == 5) s = mossSurf(uv);
  else if (uType == 6) s = litterSurf(uv);
  else if (uType == 7) s = rockSurf(uv);
  else s = deadwood(uv);
  return s;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  if (uType == 8) {
    // three independent tileable fbm channels for macro variation
    gl_FragColor = vec4(
      pfbm(uv * 4.0, vec2(4.0), 5) * 0.5 + 0.5,
      pfbm(uv * 8.0 + 3.1, vec2(8.0), 5) * 0.5 + 0.5,
      pfbm(uv * 2.0 + 7.7, vec2(2.0), 4) * 0.5 + 0.5,
      hash12(gl_FragCoord.xy));
    return;
  }
  Surf s = evalSurf(uv);
  if (uMode == 0) {
    gl_FragColor = vec4(pow(clamp(s.col, 0.0, 1.0), vec3(2.2)), clamp(s.rough, 0.0, 1.0));
  } else {
    vec2 e = 1.0 / uRes;
    float hx = evalSurf(uv + vec2(e.x, 0.0)).h;
    float hy = evalSurf(uv + vec2(0.0, e.y)).h;
    vec3 n = normalize(vec3((s.h - hx) * uNormalStrength, (s.h - hy) * uNormalStrength, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, clamp(s.h, 0.0, 1.0));
  }
}
`;

export class Baker {
  constructor(renderer, anisotropy = 8) {
    this.renderer = renderer;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uType: { value: 0 },
        uMode: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uNormalStrength: { value: 4 },
      },
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: HASH_GLSL + PERIODIC_GLSL + SURFACES_GLSL,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(fullscreenTriangle(), this.material);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.anisotropy = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  }

  target(w, h, srgb) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: this.anisotropy,
      depthBuffer: false,
    });
  }

  draw(rt, type, mode, normalStrength = 4) {
    const u = this.material.uniforms;
    u.uType.value = type;
    u.uMode.value = mode;
    u.uRes.value.set(rt.width, rt.height);
    u.uNormalStrength.value = normalStrength;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(this.mesh, this.camera);
    r.setRenderTarget(prev);
  }

  // → { color (sRGB rgb + roughness in a), normal (xyz + height in a) }
  surface(type, w, h, normalStrength) {
    const color = this.target(w, h, true);
    const normal = this.target(w, h, false);
    this.draw(color, type, 0);
    this.draw(normal, type, 1, normalStrength);
    return { color: color.texture, normal: normal.texture };
  }

  noise(size = 256) {
    const rt = this.target(size, size, false);
    this.draw(rt, SURF.NOISE, 0);
    return rt.texture;
  }

  dispose() {
    this.material.dispose();
  }
}
