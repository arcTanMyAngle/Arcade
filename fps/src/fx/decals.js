// Surface-typed impact decals. Ring-buffered InstancedMesh, one draw call per
// surface kind (4 total), hard-capped so a long firefight can never grow memory.
//
// Why the decals are LIT (MeshStandardMaterial) rather than an unlit multiply:
// an unlit decal has one fixed brightness, so a bullet hole in shadow glows and
// a bullet hole in sun goes flat. Rendering them through the standard shader
// means the crater is lit by exactly the same sun/env as the wall it sits on —
// glass cracks read white in light and grey in shade for free. The cost is that
// they participate in the transparent pass; with depthWrite off, a normal push
// and a negative polygon offset, they neither z-fight nor occlude each other.

import * as THREE from 'three';
import { decalRGBA, DECAL_KINDS } from './sprites.js';

const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);   // PlaneGeometry faces +Z

// Per-kind surface response. Roughness/metalness are what sell "this hole is in
// steel, not in concrete" as much as the albedo does.
const SURF = {
  concrete: { roughness: 0.94, metalness: 0.0, size: [0.15, 0.24] },
  metal: { roughness: 0.42, metalness: 0.85, size: [0.10, 0.16] },
  glass: { roughness: 0.18, metalness: 0.0, size: [0.22, 0.34] },
  wood: { roughness: 0.82, metalness: 0.0, size: [0.13, 0.21] },
};

export function createDecals({ perKind = 32, size = 128, seed = 1 } = {}) {
  const kinds = new Map();
  const group = new THREE.Group();
  group.name = 'fx.decals';
  const owned = [];

  DECAL_KINDS.forEach((kind, ki) => {
    const img = decalRGBA(kind, seed + ki * 977, size);
    const tex = new THREE.DataTexture(img.data, img.size, img.size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;          // it is an albedo — must be sRGB
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    const s = SURF[kind] ?? SURF.concrete;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.02,
      roughness: s.roughness,
      metalness: s.metalness,
      envMapIntensity: 1.7,               // matches the level materials
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      side: THREE.FrontSide,
      name: `decal.${kind}`,
    });

    // Per-instance age fade. Three has no built-in instance opacity, so this is
    // the one place we patch the standard shader — three lines, cache-keyed so
    // it cannot collide with the level's programs.
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(perKind).fill(1), 1);
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aFade;\nvarying float vFade;\n' +
        sh.vertexShader.replace('void main() {', 'void main() {\n\tvFade = aFade;');
      sh.fragmentShader = 'varying float vFade;\n' +
        sh.fragmentShader.replace('#include <alphatest_fragment>',
          'diffuseColor.a *= vFade;\n#include <alphatest_fragment>');
    };
    mat.customProgramCacheKey = () => 'fxDecalFade';

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aFade', fade);

    const mesh = new THREE.InstancedMesh(geo, mat, perKind);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;                 // before particles, after opaque
    mesh.name = `fx.decals.${kind}`;
    group.add(mesh);
    owned.push(geo, mat, tex);

    kinds.set(kind, {
      mesh, fade, head: 0, n: 0, perKind,
      age: new Float32Array(perKind), life: new Float32Array(perKind).fill(1),
      sz: s.size,
    });
  });

  // Pooled scratch — place() must allocate nothing.
  const _q = new THREE.Quaternion();
  const _n = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _roll = new THREE.Quaternion();

  /**
   * @param {string} kind  one of DECAL_KINDS
   * @param {number} x,y,z world hit point
   * @param {number} nx,ny,nz surface normal (need not be normalized)
   * @param {number} scale world size in metres
   * @param {number} roll  radians about the normal
   * @param {number} life  seconds before the decal fades out
   */
  function place(kind, x, y, z, nx, ny, nz, scale, roll, life) {
    const K = kinds.get(kind) ?? kinds.get('concrete');
    if (!K) return;
    _n.set(nx, ny, nz);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();
    _q.setFromUnitVectors(PLANE_NORMAL, _n);
    _roll.setFromAxisAngle(_n, roll);
    _q.premultiply(_roll);
    // Lift off the surface as well as offsetting in depth: polygon offset alone
    // still shimmers on a shallow-angle wall at 40 m.
    _p.set(x + _n.x * 0.012, y + _n.y * 0.012, z + _n.z * 0.012);
    _s.set(scale, scale, scale);
    _m.compose(_p, _q, _s);

    const i = K.head;
    K.head = (K.head + 1) % K.perKind;
    if (K.n < K.perKind) K.n++;
    K.mesh.setMatrixAt(i, _m);
    K.mesh.instanceMatrix.needsUpdate = true;
    K.mesh.count = K.n;
    K.age[i] = 0;
    K.life[i] = life;
    K.fade.array[i] = 0;
    K.fade.needsUpdate = true;
  }

  function step(dt) {
    for (const K of kinds.values()) {
      if (K.n === 0) continue;
      let dirty = false;
      for (let i = 0; i < K.n; i++) {
        if (K.age[i] >= K.life[i]) continue;
        K.age[i] += dt;
        const t = K.age[i] / K.life[i];
        // 40 ms pop-in, then hold, then a 25 % tail fade-out.
        const f = t < 0.03 ? t / 0.03 : t > 0.75 ? Math.max(0, (1 - t) / 0.25) : 1;
        K.fade.array[i] = f;
        dirty = true;
      }
      if (dirty) K.fade.needsUpdate = true;
    }
  }

  return {
    group, place, step,
    get counts() { let t = 0; for (const K of kinds.values()) t += K.n; return t; },
    sizeFor(kind) { return (SURF[kind] ?? SURF.concrete).size; },
    dispose() {
      for (const K of kinds.values()) K.mesh.dispose();
      for (const o of owned) o.dispose();
      kinds.clear();
      group.parent?.remove(group);
    },
  };
}
