// WebGL2 renderer + color management. Everything downstream assumes:
//   - scene/material colors authored in sRGB, lit in LINEAR, tonemapped ACES, output sRGB
//   - HDR float target for the post chain (bloom/TAA need values > 1.0)
// Getting this wrong is the #1 reason hobby WebGL looks flat vs. a shipped engine.

import * as THREE from 'three';

export const QUALITY = {
  ultra: { shadowMap: 4096, cascades: 4, ssao: true, ssr: true, taa: true, motionBlur: true, pixelRatioCap: 2 },
  high:  { shadowMap: 2048, cascades: 3, ssao: true, ssr: true, taa: true, motionBlur: true, pixelRatioCap: 1.5 },
  med:   { shadowMap: 2048, cascades: 3, ssao: true, ssr: false, taa: true, motionBlur: false, pixelRatioCap: 1.25 },
  low:   { shadowMap: 1024, cascades: 2, ssao: false, ssr: false, taa: false, motionBlur: false, pixelRatioCap: 1 },
};

export function createRenderer(canvas, quality = 'ultra') {
  const q = QUALITY[quality] ?? QUALITY.ultra;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,            // TAA/FXAA handles AA; MSAA can't resolve HDR post correctly
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    logarithmicDepthBuffer: false,
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ACES rolls shadows off hard. Slightly over-exposing before the curve keeps
  // mid-tones where the eye expects them instead of sitting in the toe.
  renderer.toneMappingExposure = 1.15;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.info.autoReset = false;   // we reset manually per frame to read accurate draw counts

  // 16F is enough headroom for our exposure range and halves bandwidth vs 32F.
  const hdrTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  });

  const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.02, 900);
  // Near 0.02 keeps the viewmodel out of the clip plane without wrecking depth precision;
  // the viewmodel additionally renders in its own pass with a separate near plane.

  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    api.onResize?.(w, h, renderer.getPixelRatio());
  };
  window.addEventListener('resize', onResize);

  const api = {
    renderer, camera, quality: q, qualityName: quality, hdrTarget,
    onResize: null,
    get drawCalls() { return renderer.info.render.calls; },
    get triangles() { return renderer.info.render.triangles; },
    resetStats() { renderer.info.reset(); },
    size() { const v = new THREE.Vector2(); renderer.getSize(v); return v; },
    dispose() { window.removeEventListener('resize', onResize); renderer.dispose(); },
  };
  return api;
}
