// engine.js — shared renderer + scene/camera, reused across all games.
// Adds: PBR environment reflections (PMREM), and a post stack — bloom on the emissive neon +
// a "dread" grade (vignette · chromatic aberration · film grain). Post is gated by POST.
import * as THREE from 'three';
import { makeLoop } from './loop.js';
import { updateAtmosphere } from './materials.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const POST = true;

// Dread grade (runs in linear space, before OutputPass tone-maps): radial chromatic aberration,
// vignette, and animated film grain. Restraint = uncanny.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    uVig: { value: 0.62 }, uCA: { value: 0.020 }, uGrain: { value: 0.045 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uTime,uVig,uCA,uGrain; uniform vec2 uRes;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r2 = dot(c, c);
      vec2 off = c * r2 * uCA;                              // CA grows toward the edges
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= clamp(1.0 - smoothstep(0.16, 0.62, r2) * uVig, 0.0, 1.0); // vignette
      col += (hash(vUv * uRes + uTime) - 0.5) * uGrain;     // grain
      gl_FragColor = vec4(col, 1.0);
    }`
};

export function makeEngine(mount) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // hyper-real range (applied by OutputPass under post)
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.05, 500);

  // PBR reflections: a PMREM env makes metal/lacquer/latex read as real; kept low so the
  // scene stays dark and clinical.
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
  } catch (e) { /* headless / no-context: skip IBL */ }

  // --- post stack ---
  let composer = null, grade = null, bloom = null;
  if (POST) {
    try {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 0.85); // strength,radius,threshold
      composer.addPass(bloom);
      grade = new ShaderPass(GradeShader); grade.uniforms.uRes.value.set(innerWidth, innerHeight);
      composer.addPass(grade);
      composer.addPass(new OutputPass()); // tone-map + sRGB as the final step
    } catch (e) { composer = null; }
  }

  let active = null; // current game module { step(dt), render(alpha), teardown() }
  let input = null;  // kinetic input; snap() folds one InputFrame per substep before the game reads it

  const loop = makeLoop(
    (dt) => { input?.snap(); if (active) active.step(dt); },
    (alpha) => {
      if (active) active.render?.(alpha);
      updateAtmosphere();                                // flickering fluorescents
      if (composer) { grade.uniforms.uTime.value = performance.now() * 0.001; composer.render(); }
      else renderer.render(scene, camera);
    }
  );

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer?.setSize(innerWidth, innerHeight);
    bloom?.setSize(innerWidth, innerHeight);
    grade?.uniforms.uRes.value.set(innerWidth, innerHeight);
  });

  return {
    THREE, renderer, scene, camera,
    setActive(g) { active = g; },
    attachInput(i) { input = i; },
    clearScene() {
      // dispose everything the previous game added (avoid GPU leaks between booths)
      for (let i = scene.children.length - 1; i >= 0; i--) {
        const o = scene.children[i];
        o.traverse?.((n) => {
          n.geometry?.dispose?.();
          const m = n.material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { x.map?.dispose?.(); x.normalMap?.dispose?.(); x.roughnessMap?.dispose?.(); x.dispose?.(); });
        });
        scene.remove(o);
      }
    },
    start: loop.start, stop: loop.stop
  };
}
