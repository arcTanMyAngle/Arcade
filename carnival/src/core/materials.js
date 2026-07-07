// materials.js — weaponized uncanny valley: hyper-real procedural PBR on slightly-wrong
// geometry, under stark clinical + off-color neon light.
import * as THREE from 'three';

// Procedural canvas texture: fine value-noise + optional streaks. Cached by key.
const _cache = new Map();
function noiseTex(key, base, streak, scale = 3) {
  if (_cache.has(key)) return _cache.get(key);
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  const [br, bg, bb] = base;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // layered pseudo-noise (deterministic hash) -> grain
    let n = 0, a = 0.5, f = scale;
    for (let o = 0; o < 4; o++) { n += a * hash2(x * f / S, y * f / S); a *= 0.5; f *= 2; }
    const wood = streak ? 0.5 + 0.5 * Math.sin((x * 0.09) + n * 6) : 1;
    const s = (0.6 + 0.4 * n) * wood, i = (y * S + x) * 4;
    d[i] = br * s; d[i + 1] = bg * s; d[i + 2] = bb * s; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  _cache.set(key, t); return t;
}
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }

// Tangent-space normal map from the same layered noise (finite-difference of the height field)
// -> real surface relief under the sharp clinical key. Cached by key.
function normalTex(key, scale = 5, strength = 2.4) {
  if (_cache.has(key)) return _cache.get(key);
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  const H = (x, y) => { let n = 0, a = 0.5, f = scale; for (let o = 0; o < 4; o++) { n += a * hash2((x & (S - 1)) * f / S, (y & (S - 1)) * f / S); a *= 0.5; f *= 2; } return n; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * strength, ny = -(H(x, y + 1) - H(x, y - 1)) * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz), i = (y * S + x) * 4;
    d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  _cache.set(key, t); return t;
}

export const mat = {
  wood(color = [120, 82, 46]) {
    const m = new THREE.MeshStandardMaterial({ map: noiseTex('wood' + color, color, true), normalMap: normalTex('nwood', 3, 1.6), roughness: 0.82, metalness: 0.04 });
    m.normalScale.set(0.5, 0.5); return m;
  },
  metal(color = [150, 156, 164]) {
    const t = noiseTex('metal' + color, color, false, 5);
    const m = new THREE.MeshStandardMaterial({ map: t, roughnessMap: t, normalMap: normalTex('nmetal', 5, 2.6), roughness: 0.38, metalness: 0.9 });
    m.normalScale.set(0.75, 0.75); return m;
  },
  paint(rgb) {
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255), roughness: 0.5, metalness: 0.1 });
  },
  emissive(hex, i = 2) {
    return new THREE.MeshStandardMaterial({ color: 0x050505, emissive: hex, emissiveIntensity: i, roughness: 0.6 });
  }
};

// Slight non-uniform scale skew (3–8%) -> "something is off". Deterministic via idx.
export function uncannySkew(mesh, idx = 0, amt = 0.06) {
  const s = (k) => 1 + ((hash2(idx * 1.7 + k, idx * 0.3 + k * 2) - 0.5) * 2 * amt);
  mesh.scale.set(mesh.scale.x * s(1), mesh.scale.y * s(2), mesh.scale.z * s(3));
}

// Flickering-fluorescent registry, driven each render by updateAtmosphere().
const _flick = [];
const fhash = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };
export function updateAtmosphere() {
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
  for (const f of _flick) {
    let k = 0.92 + 0.08 * Math.sin(t * 11 + f.seed);          // steady shimmer
    if (f.drop) { const n = fhash((t * 24 | 0) + f.seed); if (n < 0.05) k *= 0.3; else if (n < 0.11) k *= 0.66; } // dead-tube stutter
    f.light.intensity = f.base * k;
  }
}

// Clinical fluorescent key + off-color neon rims + near-zero ambient + hard shadow + dread fog.
export function clinicalLights(scene, THREEref = THREE) {
  scene.fog = new THREEref.FogExp2(0x04060a, 0.028);          // drowned, distant, wrong
  scene.background = new THREEref.Color(0x05070b);
  scene.add(new THREEref.AmbientLight(0x0a0f0d, 0.28));
  const key = new THREEref.DirectionalLight(0xfaffff, 2.2); // stark fluorescent white
  key.position.set(4, 12, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = -20; key.shadow.camera.right = 20; key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
  key.shadow.bias = -0.0004; scene.add(key);
  const neonG = new THREEref.PointLight(0x39ff88, 6, 40, 2); neonG.position.set(-8, 4, -6); scene.add(neonG); // sickly green
  const neonM = new THREEref.PointLight(0xff2fb0, 5, 40, 2); neonM.position.set(9, 3, -8); scene.add(neonM);  // wrong magenta
  _flick.length = 0;
  _flick.push({ light: key, base: 2.2, seed: 2, drop: true }, { light: neonG, base: 6, seed: 7, drop: false });
  return { key, neonG, neonM };
}
