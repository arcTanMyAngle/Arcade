// Physical-ish sky dome + sun disc. OWNED BY: render agent.
//
// Renders on a large inverted sphere with depth-write off, drawn first. The same
// analytic function feeds materials.js's PMREM env capture, so sky and ambient
// specular always agree — mismatched sky/IBL is an instant "fake" tell.

import * as THREE from 'three';

export const SkyShader = {
  uniforms: {
    uSunDir: { value: new THREE.Vector3(-0.42, 0.78, 0.46).normalize() },
    uZenith: { value: new THREE.Color(0x2a4a7a) },
    uHorizon: { value: new THREE.Color(0xa8b8c8) },
    uGround: { value: new THREE.Color(0x1a1712) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uExposure: { value: 1.0 },
    uTurbidity: { value: 2.6 },
  },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main(){
      vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w;         // force to far plane
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uSunDir, uZenith, uHorizon, uGround, uSunColor;
    uniform float uExposure, uTurbidity;
    varying vec3 vDir;

    void main(){
      vec3 d = normalize(vDir);
      float el = d.y;                                   // -1..1

      // Sky gradient: horizon haze falls off as a high power of (1-elevation).
      float h = pow(clamp(1.0 - abs(el), 0.0, 1.0), uTurbidity);
      vec3 sky = mix(uZenith, uHorizon, h);

      // Ground half, with a soft horizon blend so there is no hard seam.
      sky = mix(sky, uGround, smoothstep(0.02, -0.06, el));

      // Mie forward-scatter glow around the sun + a tight disc.
      float cosT = max(dot(d, normalize(uSunDir)), 0.0);
      float glow = pow(cosT, 26.0) * 0.55 + pow(cosT, 900.0) * 6.0;
      float disc = smoothstep(0.9993, 0.9997, cosT) * 24.0;
      sky += uSunColor * (glow + disc) * smoothstep(-0.08, 0.06, el);

      gl_FragColor = vec4(sky * uExposure, 1.0);
    }
  `,
};

export function createSky({ scene, sunDir }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
    vertexShader: SkyShader.vertexShader,
    fragmentShader: SkyShader.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
  if (sunDir) mat.uniforms.uSunDir.value.copy(sunDir).normalize();

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.scale.setScalar(500);
  scene.add(mesh);

  return {
    mesh, material: mat, uniforms: mat.uniforms,
    // Sky follows the camera so it can never be walked out of.
    update(camera) { mesh.position.copy(camera.position); },
    dispose() { mesh.geometry.dispose(); mat.dispose(); scene.remove(mesh); },
  };
}
