// Temporal anti-aliasing. OWNED BY: render agent.
//
// Sub-pixel jitter (Halton 2,3) is applied to the *projection* matrix by the
// pipeline; this module owns the resolve: reproject last frame's resolved image
// through the depth buffer, clip it to the current 3x3 neighbourhood, and blend.
//
// Two decisions that matter:
//  1. Blend weight is 1/n, where n is a PER-PIXEL accumulated sample count stored
//     in the history alpha channel and clamped to MAX_COUNT. A pure exponential
//     feedback (a = 0.09) needs ~40 frames to converge; a running mean converges
//     exactly in n frames, which is what makes `__GAME__.settle(12)` produce a
//     resolved image instead of a half-melted one. Once n saturates it degrades
//     to a normal exponential filter (a = 1/MAX_COUNT) so motion stays responsive.
//  2. Blending happens in a tonemapped (Karis) space, so one blown-out specular
//     sample cannot drag a pixel around — that is the firefly fix.
//
// Reprojection uses camera motion only (depth + previous view-projection). There
// is no per-object velocity buffer, so ghosting behind *moving* geometry is held
// off by neighbourhood variance clipping alone. See report notes.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MAX_COUNT = 12;          // min blend weight 1/12 -> 12-frame effective window

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

export const JITTER_N = 8;
// Halton(2,3) offsets in [-0.5, 0.5] pixel units.
export const JITTER = new Float32Array(JITTER_N * 2);
for (let i = 0; i < JITTER_N; i++) {
  JITTER[i * 2] = halton(i + 1, 2) - 0.5;
  JITTER[i * 2 + 1] = halton(i + 1, 3) - 0.5;
}

const TAAShader = {
  uniforms: {
    tCur: { value: null },
    tHist: { value: null },
    tDepth: { value: null },
    uInvVP: { value: new THREE.Matrix4() },     // inverse of current (jittered) view-proj
    uPrevVP: { value: new THREE.Matrix4() },    // previous UNjittered view-proj
    uTexel: { value: new THREE.Vector2() },
    uReset: { value: 1 },
    uMaxCount: { value: MAX_COUNT },
    uClipGamma: { value: 1.25 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tCur, tHist, tDepth;
    uniform mat4 uInvVP, uPrevVP;
    uniform vec2 uTexel;
    uniform float uReset, uMaxCount, uClipGamma;
    varying vec2 vUv;

    // Karis weighting: blend in a range-compressed space so a single fireflies'
    // worth of energy cannot dominate the average, then undo it.
    vec3 tm(vec3 c){ return c / (1.0 + max(max(c.r, c.g), c.b)); }
    vec3 itm(vec3 c){ return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }

    void main(){
      vec3 cur = max(texture2D(tCur, vUv).rgb, 0.0);
      vec3 ct  = tm(cur);

      // 3x3 moments + hard min/max, in tonemapped space.
      vec3 m1 = vec3(0.0), m2 = vec3(0.0), nmin = vec3(1e6), nmax = vec3(-1e6);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 s = tm(max(texture2D(tCur, vUv + vec2(float(x), float(y)) * uTexel).rgb, 0.0));
          m1 += s; m2 += s * s;
          nmin = min(nmin, s); nmax = max(nmax, s);
        }
      }
      vec3 mean = m1 / 9.0;
      vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
      vec3 lo = max(mean - uClipGamma * sigma, nmin);
      vec3 hi = min(mean + uClipGamma * sigma, nmax);

      // Reproject this pixel's world position into the previous frame.
      float d = texture2D(tDepth, vUv).x;
      vec4 wp = uInvVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      wp /= wp.w;
      vec4 pc = uPrevVP * vec4(wp.xyz, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;

      float onscreen = (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) ? 1.0 : 0.0;
      float keep = onscreen * (1.0 - step(0.5, uReset));

      vec4 h = texture2D(tHist, puv);
      vec3 ht = tm(max(h.rgb, 0.0));
      vec3 clamped = clamp(ht, lo, hi);

      // How far the history had to move to fit the neighbourhood == disocclusion
      // or a moving object. Reset the sample count so the pixel re-converges.
      float rej = smoothstep(0.75, 3.0, length(clamped - ht) / (length(sigma) + 1e-3));
      float cnt = min(h.a * keep * (1.0 - rej) + 1.0, uMaxCount);
      float a = 1.0 / cnt;

      // Explicit branch, not mix(): a NaN in an uninitialised history survives
      // mix(x, y, 1.0) because it evaluates x * 0.0.
      vec3 outT = (a >= 0.999) ? ct : mix(clamped, ct, a);
      gl_FragColor = vec4(itm(outT), cnt);
    }
  `,
};

export function createTAA({ renderer, width, height }) {
  const mk = (w, h) => {
    const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, samples: 0,
    });
    t.texture.generateMipmaps = false;
    return t;
  };

  let hist = mk(width, height), work = mk(width, height);

  const mat = new THREE.ShaderMaterial({
    name: 'TAAResolve',
    uniforms: THREE.UniformsUtils.clone(TAAShader.uniforms),
    vertexShader: TAAShader.vertexShader,
    fragmentShader: TAAShader.fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const u = mat.uniforms;
  const quad = new FullScreenQuad(mat);

  const clearBoth = () => {
    const prev = renderer.getRenderTarget();
    for (const t of [hist, work]) { renderer.setRenderTarget(t); renderer.clear(true, false, false); }
    renderer.setRenderTarget(prev);
  };
  u.uTexel.value.set(1 / width, 1 / height);
  clearBoth();

  return {
    get history() { return hist; },
    // Returns the render target holding the resolved frame (valid until the
    // next resolve). Targets are pooled; nothing is allocated per frame.
    resolve({ curTexture, depthTexture, invVP, prevVP, reset }) {
      u.tCur.value = curTexture;
      u.tHist.value = hist.texture;
      u.tDepth.value = depthTexture;
      u.uInvVP.value.copy(invVP);
      u.uPrevVP.value.copy(prevVP);
      u.uReset.value = reset ? 1 : 0;

      renderer.setRenderTarget(work);
      quad.render(renderer);

      const out = work;
      work = hist; hist = out;           // resolved frame becomes next frame's history
      return out;
    },
    resize(w, h) {
      hist.setSize(Math.max(1, w), Math.max(1, h));
      work.setSize(Math.max(1, w), Math.max(1, h));
      u.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      clearBoth();
    },
    dispose() { hist.dispose(); work.dispose(); quad.dispose(); mat.dispose(); },
  };
}
