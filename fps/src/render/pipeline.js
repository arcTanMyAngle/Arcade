// HDR post chain: world AO -> temporal resolve -> unclipped viewmodel -> bloom ->
// restrained grade -> output transform -> FXAA safety net for the viewmodel.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { createTAA, JITTER, JITTER_N } from './passes/taa.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.30 },
    uGrain: { value: 0.018 }, uAberration: { value: 0.0007 },
    uContrast: { value: 1.045 }, uSaturation: { value: 1.025 },
    uLift: { value: new THREE.Vector3(0.004, 0.007, 0.013) },
    uGain: { value: new THREE.Vector3(1.018, 1.0, 0.982) },
  },
  vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime,uVignette,uGrain,uAberration,uContrast,uSaturation;
    uniform vec3 uLift,uGain; varying vec2 vUv;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){
      vec2 d=vUv-.5; float r2=dot(d,d); vec2 off=d*uAberration*r2*4.; vec3 c;
      c.r=texture2D(tDiffuse,vUv+off).r;c.g=texture2D(tDiffuse,vUv).g;c.b=texture2D(tDiffuse,vUv-off).b;
      c=c*uGain+uLift;c=(c-.5)*uContrast+.5;float l=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(l),c,uSaturation);
      c*=1.-uVignette*pow(r2*2.,1.35);c+=(hash(vUv*1024.+fract(uTime)*91.7)-.5)*uGrain*(1.-l*.7);
      gl_FragColor=vec4(max(c,0.),1.);
    }`,
};

const CopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `uniform sampler2D tDiffuse;varying vec2 vUv;void main(){gl_FragColor=texture2D(tDiffuse,vUv);}`,
};

class TemporalPass extends Pass {
  constructor(renderer, w, h) {
    super(); this.taa = createTAA({ renderer, width: w, height: h });
    this.mat = new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.quad = new FullScreenQuad(this.mat); this.invVP = new THREE.Matrix4(); this.prevVP = new THREE.Matrix4(); this.reset = true;
  }
  render(renderer, writeBuffer, readBuffer) {
    const out = this.taa.resolve({ curTexture: readBuffer.texture, depthTexture: writeBuffer.depthTexture, invVP: this.invVP, prevVP: this.prevVP, reset: this.reset });
    this.mat.uniforms.tDiffuse.value = out.texture; renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer); this.reset = false;
  }
  setSize(w, h) { this.taa.resize(w, h); }
  dispose() { this.taa.dispose(); this.quad.dispose(); this.mat.dispose(); }
}

class ViewmodelPass extends Pass {
  constructor(scene, camera) { super(); this.scene = scene; this.camera = camera; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) {
    const mask = this.camera.layers.mask, auto = renderer.autoClear;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer); renderer.autoClear = false; renderer.clearDepth();
    this.camera.layers.set(2); renderer.render(this.scene, this.camera); this.camera.layers.mask = mask; renderer.autoClear = auto;
  }
}

export function createPipeline({ rc, scene, quality }) {
  const { renderer, camera } = rc, size = rc.size(), pr = renderer.getPixelRatio();
  const target = rc.hdrTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr));
  target.depthTexture = new THREE.DepthTexture(target.width, target.height, THREE.FloatType);
  const composer = new EffectComposer(renderer, target); composer.setPixelRatio(pr);
  composer.addPass(new RenderPass(scene, camera));

  let gtao = null;
  if (quality.ssao) {
    gtao = new GTAOPass(scene, camera, size.x * pr, size.y * pr); gtao.output = GTAOPass.OUTPUT.Default;
    gtao.updateGtaoMaterial({ radius: 0.34, distanceExponent: 1.7, thickness: 0.75, scale: 1, samples: 12, screenSpaceRadius: false });
    composer.addPass(gtao);
  }
  const taa = quality.taa ? new TemporalPass(renderer, size.x * pr, size.y * pr) : null;
  if (taa) composer.addPass(taa);
  composer.addPass(new ViewmodelPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr, size.y * pr), 0.23, 0.55, 1.08); composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader); composer.addPass(grade); composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa);

  const setFxaa = (w, h) => fxaa.material.uniforms.resolution.value.set(1 / Math.max(1, w * renderer.getPixelRatio()), 1 / Math.max(1, h * renderer.getPixelRatio()));
  setFxaa(size.x, size.y);
  const vp = new THREE.Matrix4(), inv = new THREE.Matrix4(), baseProj = new THREE.Matrix4(), prevVP = new THREE.Matrix4();
  const lastP = new THREE.Vector3().copy(camera.position), lastQ = new THREE.Quaternion().copy(camera.quaternion);
  let frame = 0, t = 0, havePrev = false;

  return {
    composer,
    params: { bloom, grade: grade.material.uniforms, gtao, taa },
    render() {
      t += 1 / 60; grade.material.uniforms.uTime.value = t;
      camera.updateMatrixWorld(); baseProj.copy(camera.projectionMatrix);
      const reset = camera.position.distanceToSquared(lastP) > 4 || 1 - Math.abs(camera.quaternion.dot(lastQ)) > 0.04;
      if (taa) {
        const j = (frame++ % JITTER_N) * 2, rw = Math.max(1, size.x * renderer.getPixelRatio()), rh = Math.max(1, size.y * renderer.getPixelRatio());
        camera.projectionMatrix.elements[8] += JITTER[j] * 2 / rw; camera.projectionMatrix.elements[9] += JITTER[j + 1] * 2 / rh;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        camera.updateMatrixWorld(); vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); inv.copy(vp).invert();
        taa.invVP.copy(inv); taa.prevVP.copy(havePrev ? prevVP : vp); taa.reset = taa.reset || reset || !havePrev;
      }
      composer.render();
      camera.projectionMatrix.copy(baseProj); camera.projectionMatrixInverse.copy(baseProj).invert();
      camera.updateMatrixWorld(); prevVP.multiplyMatrices(baseProj, camera.matrixWorldInverse); havePrev = true; lastP.copy(camera.position); lastQ.copy(camera.quaternion);
    },
    resize(w, h) {
      size.set(w, h); composer.setSize(w, h); composer.setPixelRatio(renderer.getPixelRatio()); gtao?.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()); bloom.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()); setFxaa(w, h); if (taa) taa.reset = true;
    },
    dispose() { taa?.dispose(); composer.dispose(); },
  };
}
