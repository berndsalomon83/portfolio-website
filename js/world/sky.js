import * as THREE from 'three';
import { SUN_DIR } from './layout.js';

// Morning sky: pale haze at the horizon, soft blue above, warm Mie glow and an HDR sun disc.
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uIntensity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + (modelMatrix * vec4(position, 0.0)).xyz, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uIntensity;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 zenith = vec3(0.28, 0.46, 0.76);
        vec3 horizon = vec3(0.70, 0.76, 0.76);
        vec3 col = mix(horizon, zenith, pow(max(y, 0.0), 0.55));
        float c = max(dot(d, uSunDir), 0.0);
        col += vec3(1.0, 0.80, 0.52) * (pow(c, 8.0) * 0.7 + pow(c, 64.0) * 1.6 + pow(c, 600.0) * 8.0);
        col += vec3(1.0, 0.93, 0.80) * smoothstep(0.99985, 0.99993, c) * 90.0;
        col = mix(col, vec3(0.32, 0.36, 0.34), smoothstep(0.02, -0.2, y));
        gl_FragColor = vec4(col * uIntensity, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}
