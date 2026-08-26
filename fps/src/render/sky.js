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
    uTime: { value: 0 },                   // call-count clock owned by update(), NOT wall-clock
    uCloudCoverage: { value: 0.55 },
    uCloudSpeed: { value: 0.6 },
    uSunIntensity: { value: 11.0 },        // HDR core value; must clear the bloom threshold
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
    uniform float uExposure, uTurbidity, uTime, uCloudCoverage, uCloudSpeed, uSunIntensity;
    varying vec3 vDir;

    // Cheap hash-based value noise. No lattice-array indexing (the fractional-
    // period NaN trap in textures.js does not apply here), but pow()/smoothstep()
    // args below are all kept in safe, ordered ranges on purpose.
    float hash21(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0)), e = hash21(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
    }
    float fbm(vec2 p){                      // 4 octaves -- every extra one is real ALU
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.55; }
      return v;
    }

    void main(){
      vec3 d = normalize(vDir);
      float el = d.y;                                   // -1..1

      // Sky gradient: horizon haze falls off as a high power of (1-elevation).
      float h = pow(clamp(1.0 - abs(el), 0.0, 1.0), uTurbidity);
      vec3 sky = mix(uZenith, uHorizon, h);

      // Ground half, with a soft horizon blend so there is no hard seam.
      sky = mix(sky, uGround, smoothstep(0.02, -0.06, el));

      // --- cloud deck ---------------------------------------------------
      // Project the view ray onto a notional layer above the camera so cloud
      // shapes compress toward the horizon like real cumulus (elc clamps the
      // divisor -- no div-by-zero at the horizon, where the mask fades to 0
      // anyway). One noise octave warps the UV into itself before the fbm so
      // edges read as billowy rather than as a flat noise wash.
      float elc = max(el, 0.12);
      vec2 wind = vec2(0.80, 0.35) * uTime * uCloudSpeed;
      vec2 cuv = d.xz / elc * 0.85 + wind;
      vec2 warp = vec2(vnoise(cuv * 0.6 + 4.1), vnoise(cuv * 0.6 - 7.3)) - 0.5;
      float n = fbm(cuv + warp * 0.5);
      float cshape = pow(smoothstep(uCloudCoverage - 0.22, uCloudCoverage + 0.22, n), 1.4);
      float horizonFade = smoothstep(0.03, 0.22, el);    // dissolve into the haze, don't clip it
      float zenithFade = 1.0 - smoothstep(0.88, 1.0, el);
      float cloudAlpha = cshape * horizonFade * zenithFade;

      vec3 cloudLit = mix(mix(uHorizon, vec3(1.0), 0.30), uSunColor, 0.22);
      vec3 cloudShadow = mix(uZenith, uGround, 0.20) * 0.62;
      float sunFace = smoothstep(-0.3, 0.7, dot(d, normalize(uSunDir)));
      float dense = smoothstep(0.15, 0.85, n);
      vec3 cloudColor = mix(cloudShadow, cloudLit, clamp(sunFace * 0.7 + (1.0 - dense) * 0.35, 0.0, 1.0));
      sky = mix(sky, cloudColor, cloudAlpha);

      // --- sun disc -------------------------------------------------------
      // Radial falloff from the center approximates limb darkening (dimmer at
      // the rim than the core) instead of a hard-edged coin. A tight near-
      // threshold ring plus a wide Mie lobe feed the bloom pass; cloud in the
      // same view direction dims the sun using the cloudAlpha already sampled
      // there, so a cloud crossing the disc darkens it without a second raymarch.
      float cosT = max(dot(d, normalize(uSunDir)), 0.0);
      float rim = 1.0 - cosT;
      float discR = 0.00060;                             // ~2 deg apparent radius
      float disc = 1.0 - smoothstep(0.0, discR, rim);
      float limb = mix(0.55, 1.0, disc);
      float core = disc * limb * uSunIntensity;
      float glowWide = pow(cosT, 24.0) * 0.6;             // broad forward-scatter halo
      float glowTight = pow(cosT, 500.0) * 3.0;           // hot pre-bloom ring
      vec3 sunAdd = uSunColor * (core + glowTight + glowWide);
      sunAdd *= smoothstep(-0.08, 0.06, el) * (1.0 - cloudAlpha * 0.85);
      sky += sunAdd;

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

  // Cloud drift clock: advanced by a fixed synthetic step per update() call, NOT
  // by wall-clock delta. update(camera) is the frozen contract -- no dt param --
  // and driving it off real time would make headless capture (fixed settle(n)
  // call counts) produce a different sky on every run. This makes it reproduce.
  const CLOCK_STEP = 1 / 60;
  let clock = 0;

  return {
    mesh, material: mat, uniforms: mat.uniforms,
    // Sky follows the camera so it can never be walked out of.
    update(camera) {
      mesh.position.copy(camera.position);
      clock += CLOCK_STEP;
      mat.uniforms.uTime.value = clock;
    },
    dispose() { mesh.geometry.dispose(); mat.dispose(); scene.remove(mesh); },
  };
}
