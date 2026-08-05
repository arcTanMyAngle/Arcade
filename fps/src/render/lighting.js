// Scene lighting rig. OWNED BY: render agent.
//
// Single directional sun + hemisphere fill. The render agent's job is to replace
// the single shadow map with proper cascades (CSM) — one 2048 map stretched over
// a 40 m radius gives ~2 cm texels, which is why contact shadows look mushy.

import * as THREE from 'three';

export function createLighting({ scene, sunDir, quality }) {
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.4);
  sun.position.copy(sunDir).multiplyScalar(80);
  sun.castShadow = true;

  const res = quality?.shadowMap ?? 2048;
  sun.shadow.mapSize.set(res, res);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  const S = 40;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  // normalBias beats constant bias for peter-panning on thin geometry; keep
  // constant bias small and negative to kill acne on near-parallel surfaces.
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.028;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  sun.layers.enable(2);

  // Sky/ground ambient. This carries EVERY surface the sun doesn't reach, so
  // starving it (it was 0.42) crushes all away-facing geometry to black — the
  // single biggest "no global illumination" tell. Real courtyards are filled by
  // sky dome + bounce; keep it strong enough to read, low enough to keep contrast.
  const hemi = new THREE.HemisphereLight(0x9ec4f5, 0x4a4034, 0.95);
  hemi.layers.enable(2);
  scene.add(hemi);

  // Cheap one-bounce approximation: a dim, warm, up-facing light from the
  // opposite azimuth standing in for sunlight bouncing off the ground plane.
  // Real GI would be view-dependent; this is the 5%-cost version that removes
  // the dead-black shadow side without flattening the key.
  const bounce = new THREE.DirectionalLight(0xffd9b0, 0.55);
  bounce.position.set(-sunDir.x * 40, Math.max(6, sunDir.y * 12), -sunDir.z * 40);
  bounce.castShadow = false;
  bounce.layers.enable(2);
  scene.add(bounce, bounce.target);

  return {
    sun, hemi, bounce,
    // Keep the shadow frustum centred on the player, snapped to texel increments
    // so shadows don't shimmer as the camera moves.
    update(target) {
      const texel = (S * 2) / res;
      sun.target.position.set(
        Math.round(target.x / texel) * texel, 0, Math.round(target.z / texel) * texel
      );
      sun.position.copy(sun.target.position).addScaledVector(sunDir, 80);
      sun.target.updateMatrixWorld();
    },
    dispose() {
      sun.shadow.map?.dispose();
      scene.remove(sun, sun.target, hemi, bounce, bounce.target);
    },
  };
}
