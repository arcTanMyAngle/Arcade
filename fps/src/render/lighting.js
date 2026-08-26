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
  // starving it crushes all away-facing geometry to black — the single biggest
  // "no global illumination" tell. Real courtyards are filled by sky dome +
  // bounce; keep it strong enough to read, low enough to keep contrast.
  //
  // materials.js's PMREM env also feeds indirect diffuse (three sums
  // getIBLIrradiance into the SAME irradiance accumulator this light writes to,
  // at PI x envMapIntensity) — that used to be pushed hard to compensate for a
  // starved hemisphere term, which stacked two blue sky fills on every shadowed
  // surface (measured: shadowed trim hit blue-minus-red +38 vs +18 for shadowed
  // ground). envMapIntensity now sits near 1.0 for plausible specular sheen only;
  // this light carries the deliberate, colour-balanced diffuse fill instead, so
  // its intensity and hue are chosen for the LOOK, not to patch a darkness bug.
  // groundColor lifted (was 0x4a4034): down-facing trim (soffits, drips) mixes
  // toward it as dotNL -> -1, so a too-dark, too-neutral ground term was reading
  // as "just less blue" instead of contributing real bounce warmth of its own.
  const hemi = new THREE.HemisphereLight(0x9ec4f5, 0x6b5a44, 0.72);
  hemi.layers.enable(2);
  scene.add(hemi);

  // Cheap one-bounce approximation: a dim, warm, up-facing light from the
  // opposite azimuth standing in for sunlight bouncing off the ground plane.
  // Real GI would be view-dependent; this is the 5%-cost version that removes
  // the dead-black shadow side without flattening the key. Not shadow-mapped, so
  // it is the one fill term that still reaches ground sitting in another
  // surface's cast shadow (GTAO then multiplies whatever floor this leaves it) —
  // raised and warmed to do more of that specific job now that envMapIntensity
  // no longer over-fills everything with blue sky irradiance as a side effect.
  const bounce = new THREE.DirectionalLight(0xffcb96, 0.95);
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
