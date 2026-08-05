// Pooled CPU-simulated, GPU-instanced particle system. ONE draw call per system.
//
// Design notes worth the bytes:
//
// * Structure-of-arrays over a Float32Array pool. No per-particle objects means
//   no allocation on spawn and no GC pressure on death — invariant #5.
// * Dense storage with swap-remove. Live particles always occupy [0, n), so the
//   instance buffers upload contiguously and `instanceCount = n` is exact; there
//   is no "dead slot" fragmentation and no compaction pass.
// * Sim in step(dt) at 128 Hz, display interpolation in render(alpha). Each
//   particle keeps its previous-tick position and age so render() can lerp; a
//   particle written straight from the 128 Hz value visibly stutters on a 144 Hz
//   display exactly like the camera does.
// * Two billboard modes in one shader:
//     stretch = 0  -> screen-aligned rotating quad (smoke, dust, flash, blood)
//     stretch > 0  -> view-space ribbon from p to p + v*stretch (sparks, tracers)
//   The ribbon length is therefore the distance the particle covers in `stretch`
//   seconds: real motion blur, not a cosmetic guess. A particle moving straight
//   away from the camera correctly foreshortens to a dot.

import * as THREE from 'three';

const QUAD_POS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iCol;
attribute vec4 iPar;              // x=size  y=alpha  z=roll  w=stretch(seconds)
varying vec2 vUv;
varying vec3 vCol;
varying float vA;

void main() {
  vUv = uv; vCol = iCol; vA = iPar.y;
  float sz = iPar.x;
  vec3 a = (modelViewMatrix * vec4(iPos, 1.0)).xyz;
  vec3 p;
  if (iPar.w > 0.0) {
    vec3 b = (modelViewMatrix * vec4(iPos + iVel * iPar.w, 1.0)).xyz;
    vec3 dv = b - a;
    float dl = length(dv);
    // Never let the ribbon collapse below the particle's own width.
    dv = dl > 1e-5 ? dv * (max(dl, sz) / dl) : vec3(0.0, sz, 0.0);
    b = a + dv;
    vec2 pd = vec2(-dv.y, dv.x);
    float pl = length(pd);
    vec2 perp = pl > 1e-6 ? pd / pl : vec2(1.0, 0.0);
    p = mix(a, b, position.y + 0.5);
    p.xy += perp * (position.x * sz);
  } else {
    float c = cos(iPar.z), s = sin(iPar.z);
    p = a;
    p.xy += (position.x * vec2(c, s) + position.y * vec2(-s, c)) * sz;
  }
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

// Unlit and deliberately un-tonemapped: we render into the composer's HDR target,
// so values > 1 survive to the bloom pass. That is what makes sparks glow.
const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vA;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vCol * t.rgb, a);
}`;

/**
 * @param {object} o
 * @param {number} o.capacity      hard pool cap; spawns past it recycle the oldest slot
 * @param {THREE.Texture} o.map    sprite (LINEAR-tagged mask)
 * @param {number} o.blending      THREE.AdditiveBlending | THREE.NormalBlending
 * @param {number} [o.gravity]     m/s^2 on y (negative falls, positive is buoyant)
 * @param {number} [o.drag]        exponential velocity damping, s^-1
 * @param {number} [o.stretch]     seconds of velocity to smear along; 0 = round billboard
 * @param {number} [o.fadeIn]      fraction of life spent fading in
 * @param {number} [o.renderOrder]
 */
export function createParticles(o) {
  const cap = Math.max(1, o.capacity | 0);
  const grav = o.gravity ?? 0, drag = o.drag ?? 0, stretch = o.stretch ?? 0;
  const fadeIn = o.fadeIn ?? 0.06, fadePow = o.fadePow ?? 1.4;

  // ---- pool (SoA) --------------------------------------------------------
  const px = new Float32Array(cap), py = new Float32Array(cap), pz = new Float32Array(cap);
  const ox = new Float32Array(cap), oy = new Float32Array(cap), oz = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap), vz = new Float32Array(cap);
  const age = new Float32Array(cap), oag = new Float32Array(cap), life = new Float32Array(cap);
  const s0 = new Float32Array(cap), s1 = new Float32Array(cap);
  const cr = new Float32Array(cap), cg = new Float32Array(cap), cb = new Float32Array(cap);
  const i0 = new Float32Array(cap), i1 = new Float32Array(cap);
  const rot = new Float32Array(cap), rov = new Float32Array(cap);
  let n = 0, recycle = 0;

  const A = [px, py, pz, ox, oy, oz, vx, vy, vz, age, oag, life, s0, s1, cr, cg, cb, i0, i1, rot, rov];
  const copy = (dst, src) => { for (let k = 0; k < A.length; k++) A[k][dst] = A[k][src]; };

  // ---- GPU ---------------------------------------------------------------
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(QUAD_UV, 2));
  geo.setIndex(new THREE.BufferAttribute(QUAD_IDX, 1));

  const bPos = new Float32Array(cap * 3), bVel = new Float32Array(cap * 3);
  const bCol = new Float32Array(cap * 3), bPar = new Float32Array(cap * 4);
  const aPos = new THREE.InstancedBufferAttribute(bPos, 3);
  const aVel = new THREE.InstancedBufferAttribute(bVel, 3);
  const aCol = new THREE.InstancedBufferAttribute(bCol, 3);
  const aPar = new THREE.InstancedBufferAttribute(bPar, 4);
  for (const a of [aPos, aVel, aCol, aPar]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', aPos);
  geo.setAttribute('iVel', aVel);
  geo.setAttribute('iCol', aCol);
  geo.setAttribute('iPar', aPar);
  geo.instanceCount = 0;
  // Positions live in attributes, so three cannot cull us correctly. FX is a
  // handful of quads; skipping the cull is cheaper than maintaining bounds.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: o.map } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: o.blending ?? THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = o.renderOrder ?? 10;
  mesh.visible = false;
  mesh.name = o.name ?? 'fx.particles';

  // ---- api ---------------------------------------------------------------

  /** All-scalar spawn: allocates nothing, ever. */
  function spawn(x, y, z, ux, uy, uz, lf, a0, a1, r, g, b, e0, e1, rr, rv) {
    let i;
    if (n < cap) i = n++;
    else { i = recycle; recycle = (recycle + 1) % cap; }   // pool full: evict round-robin
    px[i] = ox[i] = x; py[i] = oy[i] = y; pz[i] = oz[i] = z;
    vx[i] = ux; vy[i] = uy; vz[i] = uz;
    age[i] = oag[i] = 0; life[i] = lf > 1e-4 ? lf : 1e-4;
    s0[i] = a0; s1[i] = a1;
    cr[i] = r; cg[i] = g; cb[i] = b;
    i0[i] = e0; i1[i] = e1;
    rot[i] = rr || 0; rov[i] = rv || 0;
    return i;
  }

  function step(dt) {
    if (n === 0) return;
    const damp = drag > 0 ? Math.exp(-drag * dt) : 1;
    const gdt = grav * dt;
    for (let i = 0; i < n; i++) {
      ox[i] = px[i]; oy[i] = py[i]; oz[i] = pz[i]; oag[i] = age[i];
      const t = age[i] + dt;
      if (t >= life[i]) {                     // swap-remove keeps [0,n) dense
        n--;
        if (i !== n) copy(i, n);
        i--;
        continue;
      }
      age[i] = t;
      vx[i] *= damp; vy[i] *= damp; vz[i] *= damp;
      vy[i] += gdt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      rot[i] += rov[i] * dt;
    }
  }

  function render(alpha) {
    if (n === 0) { if (mesh.visible) { mesh.visible = false; geo.instanceCount = 0; } return; }
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (let i = 0; i < n; i++) {
      const p3 = i * 3, p4 = i * 4;
      bPos[p3] = ox[i] + (px[i] - ox[i]) * a;
      bPos[p3 + 1] = oy[i] + (py[i] - oy[i]) * a;
      bPos[p3 + 2] = oz[i] + (pz[i] - oz[i]) * a;
      bVel[p3] = vx[i]; bVel[p3 + 1] = vy[i]; bVel[p3 + 2] = vz[i];

      const t = (oag[i] + (age[i] - oag[i]) * a) / life[i];
      const e = i0[i] + (i1[i] - i0[i]) * t;
      bCol[p3] = cr[i] * e; bCol[p3 + 1] = cg[i] * e; bCol[p3 + 2] = cb[i] * e;

      // fade in over the first `fadeIn` of life, then a soft power ramp out
      const fi = t < fadeIn ? t / fadeIn : 1;
      const fo = Math.pow(1 - t, fadePow);
      bPar[p4] = s0[i] + (s1[i] - s0[i]) * t;
      bPar[p4 + 1] = fi * fo;
      bPar[p4 + 2] = rot[i];
      bPar[p4 + 3] = stretch;
    }
    // Full-buffer upload on purpose: three's partial updateRanges push onto a
    // per-attribute array every frame, which is exactly the per-frame heap growth
    // we are forbidden. Pools are small; the extra bandwidth is free.
    aPos.needsUpdate = aVel.needsUpdate = aCol.needsUpdate = aPar.needsUpdate = true;
    geo.instanceCount = n;
    mesh.visible = true;
  }

  return {
    mesh, spawn, step, render,
    get count() { return n; },
    get capacity() { return cap; },
    clear() { n = 0; geo.instanceCount = 0; mesh.visible = false; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
