// Procedural CQB yard. Every solid helper emits visible geometry and collision
// from the same arguments; decorative-only calls must opt out explicitly.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCollider } from './collision.js';

const FACE_DIMS = (w, h, d) => [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];

function scaleBoxUVs(g, w, h, d, tile) {
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const [su, sv] = FACE_DIMS(w, h, d)[f];
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, uv.getX(i) * su / tile, uv.getY(i) * sv / tile);
  }
  uv.needsUpdate = true;
}

export function createLevel({ scene, rng, mats }) {
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);
  const brushes = [];
  const batches = new Map();
  const owned = [];
  const batch = (mat, g) => {
    let a = batches.get(mat);
    if (!a) batches.set(mat, (a = []));
    a.push(g);
  };

  function box(mat, x, y, z, w, h, d, opt = {}) {
    const { collide = true, ry = 0 } = opt;
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(g, w, h, d, mats.tileOf?.(mat) ?? 2);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    g.translate(x, y + h * 0.5, z);
    batch(mat, g);
    if (collide) {
      const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
      const aw = w * c + d * s, ad = w * s + d * c;
      brushes.push({
        min: new THREE.Vector3(x - aw * 0.5, y, z - ad * 0.5),
        max: new THREE.Vector3(x + aw * 0.5, y + h, z + ad * 0.5), mat,
      });
    }
  }

  function cyl(mat, x, y, z, r, h, opt = {}) {
    const { collide = true, sides = 12, rx = 0, rz = 0 } = opt;
    const g = new THREE.CylinderGeometry(r, r, h, sides, 1, false);
    const uv = g.attributes.uv, tile = mats.tileOf?.(mat) ?? 2;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r / tile, uv.getY(i) * h / tile);
    g.applyMatrix4(new THREE.Matrix4().makeRotationX(rx));
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(rz));
    g.translate(x, y + h * 0.5, z);
    batch(mat, g);
    if (collide) brushes.push({
      min: new THREE.Vector3(x - r, y, z - r), max: new THREE.Vector3(x + r, y + h, z + r), mat,
    });
  }

  function beam(mat, a, b, r, opt = {}) {
    const { collide = true, sides = 8 } = opt;
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av);
    const g = new THREE.CylinderGeometry(r, r, v.length(), sides, 1, false);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize()));
    const c = av.clone().add(bv).multiplyScalar(0.5); g.translate(c.x, c.y, c.z); batch(mat, g);
    if (collide) brushes.push({
      min: new THREE.Vector3(Math.min(av.x, bv.x) - r, Math.min(av.y, bv.y) - r, Math.min(av.z, bv.z) - r),
      max: new THREE.Vector3(Math.max(av.x, bv.x) + r, Math.max(av.y, bv.y) + r, Math.max(av.z, bv.z) + r), mat,
    });
  }

  const rail = (x, y, z, len, alongX = true) => {
    box('rustedSteel', x, y + 0.92, z, alongX ? len : 0.08, 0.08, alongX ? 0.08 : len, { collide: false });
    for (let q = -len * 0.5; q <= len * 0.5 + 0.01; q += 1.7) {
      box('rustedSteel', x + (alongX ? q : 0), y, z + (alongX ? 0 : q), 0.07, 1, 0.07, { collide: false });
    }
  };
  const stairs = (x, z, n, dx, dz, w, rise = 0.24, run = 0.34) => {
    for (let i = 0; i < n; i++) box('paintedMetal', x + dx * run * i, 0, z + dz * run * i, dx ? run : w, rise * (i + 1), dz ? run : w);
  };
  const pallet = (x, y, z, ry = 0) => {
    for (let i = -2; i <= 2; i++) box('wood', x + Math.cos(ry) * i * 0.23, y + 0.08, z - Math.sin(ry) * i * 0.23, 0.18, 0.08, 1.05, { ry, collide: false });
    for (const q of [-0.42, 0, 0.42]) box('wood', x - Math.sin(ry) * q, y, z - Math.cos(ry) * q, 1.2, 0.09, 0.12, { ry, collide: false });
  };
  const crate = (x, y, z, s = 1) => {
    box('wood', x, y, z, s, s, s);
    for (const yy of [0.05, s - 0.11]) {
      box('rustedSteel', x, y + yy, z - s * 0.505, s + 0.04, 0.07, 0.04, { collide: false });
      box('rustedSteel', x, y + yy, z + s * 0.505, s + 0.04, 0.07, 0.04, { collide: false });
    }
  };
  const drum = (x, y, z, mat = 'paintedMetal') => {
    cyl(mat, x, y, z, 0.29, 0.86, { sides: 18 });
    for (const yy of [0.08, 0.39, 0.73]) cyl('rustedSteel', x, y + yy, z, 0.302, 0.045, { sides: 18, collide: false });
  };
  const equipmentCase = (x, y, z, ry = 0, s = 1) => {
    box('paintedMetal', x, y, z, 1.15 * s, 0.48 * s, 0.72 * s, { ry });
    for (const q of [-0.47, 0.47]) box('rustedSteel', x + Math.cos(ry) * q * s, y + 0.05, z - Math.sin(ry) * q * s, 0.07 * s, 0.42 * s, 0.75 * s, { ry, collide: false });
    box('rustedSteel', x, y + 0.45 * s, z, 1.05 * s, 0.045 * s, 0.66 * s, { ry, collide: false });
  };
  const container = (x, y, z, ry = 0) => {
    box('corrugated', x, y, z, 6.05, 2.55, 2.44, { ry });
    for (const q of [-2.95, 2.95]) for (const zz of [-1.16, 1.16]) {
      const lx = Math.cos(ry) * q + Math.sin(ry) * zz, lz = -Math.sin(ry) * q + Math.cos(ry) * zz;
      box('rustedSteel', x + lx, y, z + lz, 0.12, 2.62, 0.12, { collide: false });
    }
    for (let q = -2.4; q <= 2.4; q += 0.8) box('paintedMetal', x + Math.cos(ry) * q, y + 2.54, z - Math.sin(ry) * q, 0.05, 0.09, 2.5, { ry, collide: false });
  };

  // Ground, perimeter shell, capstones, pilasters, and a broken north gateway.
  box('asphalt', 0, -1.6, 0, 72, 1.6, 62);
  box('concreteWall', -31, 0, 0, 1.2, 8, 54);
  box('concreteWall', 31, 0, 0, 1.2, 8, 54);
  box('concreteWall', 0, 0, 27, 63, 8, 1.2);
  box('concreteWall', -18, 0, -27, 27, 8, 1.2);
  box('concreteWall', 18, 0, -27, 27, 8, 1.2);
  box('paintedMetal', 0, 5.8, -27, 9, 2.2, 1.3);
  for (const x of [-31, 31]) box('concreteFloor', x, 7.85, 0, 1.55, 0.22, 55);
  box('concreteFloor', 0, 7.85, 27, 63, 0.22, 1.55);
  box('concreteFloor', -18, 7.85, -27, 27, 0.22, 1.55);
  box('concreteFloor', 18, 7.85, -27, 27, 0.22, 1.55);
  for (const z of [-22, -11, 0, 11, 22]) for (const x of [-30.35, 30.35]) box('concreteFloor', x, 0, z, 0.45, 8.25, 1.65, { collide: false });

  // Central operations building: a true 2.5 m-deep entry recess, not a door
  // painted onto a solid brush. Wings, lintel and rear block author their own
  // matching collision while the opening itself remains traversable.
  box('brick', -4.8, 0, -9.25, 10.6, 4.4, 5.3);
  box('brick', -8.08, 0, -5.35, 4.05, 4.4, 2.5);
  box('brick', -1.52, 0, -5.35, 4.05, 4.4, 2.5);
  box('brick', -4.8, 3.0, -5.35, 2.5, 1.4, 2.5);
  // Broken plaster skin stops around the void; the brick returns stay visible.
  box('plaster', -8.08, 0, -3.98, 4.12, 4.55, 0.24, { collide: false });
  box('plaster', -1.52, 0, -3.98, 4.12, 4.55, 0.24, { collide: false });
  box('plaster', -4.8, 3.0, -3.98, 2.5, 1.55, 0.24, { collide: false });
  box('paintedMetal', -4.8, 0, -6.48, 2.05, 2.82, 0.12);
  box('concreteFloor', -4.8, 0.005, -5.28, 2.38, 0.075, 2.42, { collide: false });
  box('paintedMetal', -6.01, 0, -5.26, 0.10, 3.02, 2.5, { collide: false });
  box('paintedMetal', -3.59, 0, -5.26, 0.10, 3.02, 2.5, { collide: false });
  box('paintedMetal', -4.8, 2.90, -5.26, 2.52, 0.11, 2.5, { collide: false });
  // Deep jamb shadows, threshold wear and a projecting rain hood frame the focal point.
  box('rustedSteel', -6.08, 0, -3.83, 0.16, 3.12, 0.36, { collide: false });
  box('rustedSteel', -3.52, 0, -3.83, 0.16, 3.12, 0.36, { collide: false });
  box('rustedSteel', -4.8, 2.96, -3.76, 2.72, 0.17, 0.52, { collide: false });
  box('paintedMetal', -4.8, 3.18, -3.55, 3.65, 0.16, 1.05, { collide: false });
  beam('rustedSteel', [-6.45, 2.95, -3.2], [-6.0, 3.2, -3.75], 0.045, { collide: false });
  beam('rustedSteel', [-3.15, 2.95, -3.2], [-3.6, 3.2, -3.75], 0.045, { collide: false });
  box('concreteFloor', -4.8, 4.4, -8, 11.2, 0.35, 8.4);
  for (const x of [-9.8, 0.2]) box('concreteFloor', x, 0, -3.7, 0.28, 4.7, 0.5, { collide: false });
  box('tile', -4.8, 0.02, -3.48, 2.15, 0.08, 0.7, { collide: false });

  // Localized OPS-01 sign, assembled from emissive-looking tile strokes.
  box('paintedMetal', -4.8, 3.48, -3.69, 3.05, 0.62, 0.10, { collide: false });
  for (const x of [-5.78, -5.52, -5.26]) box('tile', x, 3.68, -3.61, 0.17, 0.08, 0.035, { collide: false });
  box('tile', -5.78, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const x of [-4.65, -4.31]) box('tile', x, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const y of [3.42, 3.84]) box('tile', -4.48, y, -3.61, 0.42, 0.07, 0.035, { collide: false });
  for (const x of [-3.72, -3.38]) box('tile', x, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const y of [3.42, 3.84]) box('tile', -3.55, y, -3.61, 0.42, 0.07, 0.035, { collide: false });
  // Conduit and a sagging temporary power lead break the clean facade silhouette.
  beam('rustedSteel', [-9.65, 3.65, -3.72], [-7.5, 3.65, -3.72], 0.035, { collide: false });
  beam('rubber', [-7.5, 3.65, -3.70], [-6.2, 2.65, -3.55], 0.025, { collide: false });
  beam('rubber', [-6.2, 2.65, -3.55], [-4.9, 2.45, -3.45], 0.025, { collide: false });

  // West catwalk and playable stairs.
  box('paintedMetal', -24.4, 3.05, -4, 10.8, 0.32, 3.0);
  for (const x of [-29.2, -24.4, -19.6]) for (const z of [-5.1, -2.9]) box('rustedSteel', x, 0, z, 0.16, 3.1, 0.16);
  rail(-24.4, 3.35, -5.38, 10.4, true); rail(-24.4, 3.35, -2.62, 10.4, true);
  stairs(-18.95, -3.95, 13, 1, 0, 2.6, 0.235, 0.34);
  rail(-16.9, 0.25, -5.42, 4.2, true);

  // East loading lane: stacked containers create strong diagonals and depth.
  container(20.4, 0, -16.6, 0.12);
  container(20.0, 2.58, -16.8, 0.12);
  container(22.5, 0, -8.7, Math.PI * 0.5);
  container(22.2, 0, 8.2, -0.08);
  box('concrete', 13.6, 0, -15.0, 3.2, 1.05, 1.0);
  box('concrete', 11.8, 0, -13.0, 3.2, 1.05, 1.0, { ry: 0.18 });
  for (const x of [9.8, 15.5, 27]) for (const z of [-20, 13]) cyl('rustedSteel', x, 0, z, 0.34, 0.9, { sides: 16 });

  // Pipes and HVAC make the long west wall read as authored architecture.
  for (const z of [-19, -13, 4, 10, 16]) {
    cyl('rustedSteel', -29.95, 1.0, z, 0.13, 4.2, { sides: 10, collide: false });
    box('paintedMetal', -29.82, 1.2, z, 0.25, 0.12, 0.75, { collide: false });
  }
  for (const x of [-15, -11.6]) {
    box('paintedMetal', x, 0, 18.7, 2.7, 1.5, 2.1);
    for (let q = -1; q <= 1; q += 0.33) box('rustedSteel', x + q, 1.48, 18.7, 0.05, 0.18, 1.9, { collide: false });
    cyl('rustedSteel', x, 1.55, 18.7, 0.48, 0.18, { sides: 14, collide: false });
  }

  // Foreground storytelling clutter, cover, and silhouette breakup.
  pallet(7.2, 0, 14.5, 0.18); pallet(8.0, 0.18, 14.4, 0.18);
  crate(5.9, 0.2, 14.5, 1.15); crate(7.4, 0.2, 13.5, 0.9); crate(-15.5, 0, 9.0, 1.3);
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2, rr = 0.4 + rng() * 2.4, s = 0.10 + rng() * 0.22;
    box(i % 3 ? 'concrete' : 'rustedSteel', -12 + Math.cos(a) * rr, 0.02, -18 + Math.sin(a) * rr, s, s * (0.5 + rng()), s * 1.4, { ry: a, collide: false });
  }
  // Cluster one: powered breach-staging station beside OPS-01. The generator,
  // cases and cable route tell one compact story while leaving the portal clear.
  box('paintedMetal', -7.55, 0, -2.35, 1.45, 0.86, 0.82, { ry: 0.08 });
  box('rustedSteel', -7.55, 0.82, -2.35, 1.50, 0.07, 0.86, { ry: 0.08, collide: false });
  for (let i = -3; i <= 3; i++) box('rustedSteel', -7.18, 0.18 + (i + 3) * 0.075, -1.94, 0.56, 0.025, 0.035, { ry: 0.08, collide: false });
  for (const x of [-8.05, -7.06]) for (const z of [-2.70, -2.00]) cyl('rubber', x, 0.04, z, 0.19, 0.14, { sides: 14, rx: Math.PI * 0.5, collide: false });
  equipmentCase(-2.72, 0, -2.62, -0.12, 0.86);
  equipmentCase(-2.48, 0.42, -2.72, 0.05, 0.67);
  drum(-8.72, 0, -2.65, 'rustedSteel');
  // Tripod work lamp and power cable, all decorative and batched.
  beam('rustedSteel', [-3.15, 0.05, -2.0], [-3.15, 1.75, -2.0], 0.035, { collide: false });
  beam('rustedSteel', [-3.15, 0.72, -2.0], [-3.62, 0.02, -2.35], 0.025, { collide: false });
  beam('rustedSteel', [-3.15, 0.72, -2.0], [-2.68, 0.02, -2.35], 0.025, { collide: false });
  box('paintedMetal', -3.15, 1.74, -2.02, 0.58, 0.34, 0.18, { collide: false });
  box('tile', -3.15, 1.79, -1.91, 0.42, 0.20, 0.035, { collide: false });
  beam('rubber', [-7.42, 0.05, -1.92], [-6.2, 0.025, -2.25], 0.032, { collide: false });
  beam('rubber', [-6.2, 0.025, -2.25], [-4.8, 0.025, -3.25], 0.032, { collide: false });

  // Cluster two: wrecked utility vehicle and improvised recovery station.
  box('paintedMetal', 9.8, 0.55, 4.8, 4.2, 1.0, 1.85, { ry: -0.22 });
  box('paintedMetal', 9.2, 1.52, 4.95, 2.1, 0.85, 1.72, { ry: -0.22, collide: false });
  for (const q of [-1.45, 1.25]) for (const zz of [-0.88, 0.88]) cyl('rubber', 9.8 + q * 0.976 + zz * -0.218, 0.18, 4.8 + q * 0.218 + zz * 0.976, 0.42, 0.22, { sides: 16, rx: Math.PI * 0.5, collide: false });
  box('glass', 9.22, 1.70, 4.08, 1.45, 0.43, 0.035, { ry: -0.22, collide: false });
  box('glass', 9.22, 1.70, 5.82, 1.45, 0.43, 0.035, { ry: -0.22, collide: false });
  box('rustedSteel', 11.93, 0.63, 4.31, 0.22, 0.28, 2.05, { ry: -0.22, collide: false });
  box('rustedSteel', 7.70, 0.63, 5.28, 0.22, 0.28, 2.05, { ry: -0.22, collide: false });
  // A-frame hoist, hanging cable, detached wheel and service supplies.
  beam('rustedSteel', [13.0, 0, 6.25], [13.0, 2.85, 6.25], 0.095);
  beam('rustedSteel', [15.25, 0, 6.25], [15.25, 2.85, 6.25], 0.095);
  beam('rustedSteel', [13.0, 2.85, 6.25], [15.25, 2.85, 6.25], 0.11);
  beam('rustedSteel', [14.13, 2.82, 6.25], [12.0, 1.70, 5.30], 0.055, { collide: false });
  beam('rubber', [12.0, 1.70, 5.30], [10.75, 1.35, 5.05], 0.025, { collide: false });
  equipmentCase(14.15, 0, 7.10, 0.04, 0.9);
  drum(15.55, 0, 7.20, 'paintedMetal');
  drum(16.18, 0, 7.32, 'rustedSteel');
  cyl('rubber', 12.55, 0.08, 7.32, 0.44, 0.24, { sides: 18, rx: Math.PI * 0.5, collide: false });
  for (const [x, z] of [[11.9, 6.4], [12.4, 6.9], [16.7, 6.7]]) {
    const g = new THREE.ConeGeometry(0.19, 0.55, 10); g.translate(x, 0.275, z); batch('asphaltLane', g);
  }
  // Utility pole and deliberately sagged service run connect both work zones
  // and put a thin silhouette break across the otherwise empty courtyard air.
  beam('rustedSteel', [3.2, 0, 0.8], [3.2, 4.65, 0.8], 0.085);
  beam('rustedSteel', [2.55, 4.48, 0.8], [3.85, 4.48, 0.8], 0.055, { collide: false });
  beam('rubber', [-0.25, 4.18, -3.85], [1.45, 3.72, -1.45], 0.026, { collide: false });
  beam('rubber', [1.45, 3.72, -1.45], [3.2, 4.38, 0.8], 0.026, { collide: false });
  beam('rubber', [3.2, 4.38, 0.8], [7.2, 3.72, 2.9], 0.026, { collide: false });
  beam('rubber', [7.2, 3.72, 2.9], [10.4, 3.05, 4.75], 0.026, { collide: false });

  // Wordless wayfinding panels and hazard chevrons as thin geometry.
  box('paintedMetal', 13.0, 2.0, 26.35, 6.8, 2.1, 0.08, { collide: false });
  for (let i = -4; i <= 4; i++) box(i % 2 ? 'asphaltLane' : 'rustedSteel', 13 + i * 0.72, 2.15, 26.27, 0.42, 1.55, 0.05, { ry: -0.43, collide: false });
  for (const x of [-8.5, -6.9, -5.3, -3.7, -2.1]) box('tile', x, 5.0, -3.54, 0.75, 0.5, 0.06, { collide: false });

  // Merge each material batch: hundreds of authored pieces, one draw per material.
  for (const [mat, geos] of batches) {
    const g = mergeGeometries(geos, false);
    for (const q of geos) q.dispose();
    if (!g) continue;
    const m = new THREE.Mesh(g, mats.get(mat));
    m.name = `level.${mat}`; m.castShadow = m.receiveShadow = true;
    root.add(m); owned.push(g);
  }

  const collider = createCollider(brushes, { floor: 0 });
  scene.fog = new THREE.FogExp2(0x8fa2b8, 0.0085);
  const portalLight = new THREE.PointLight(0xffa65c, 24, 9, 1.8);
  portalLight.position.set(-4.8, 2.0, -5.35); portalLight.castShadow = false; scene.add(portalLight);
  const workLight = new THREE.PointLight(0xffcf8d, 8, 7, 2);
  workLight.position.set(-3.15, 1.9, -1.75); workLight.castShadow = false; scene.add(workLight);
  const catLight = new THREE.PointLight(0x78aee8, 6, 8, 2);
  catLight.position.set(-24, 2.45, -4); catLight.castShadow = false; scene.add(catLight);

  return {
    root, brushes,
    collide: collider.collide,
    raycast: collider.raycast,
    collisionStats: collider.stats,
    spawns: [new THREE.Vector3(2, 0, 21)],
    aiSpawns: [
      new THREE.Vector3(-17, 0, -16), new THREE.Vector3(17, 0, -20),
      new THREE.Vector3(23, 0, 15), new THREE.Vector3(-20, 3.38, -4),
    ],
    poses: {
      hero: { pos: new THREE.Vector3(-14, 0, 6.5), yaw: -0.683, pitch: -0.045, ads: false },
      corridor: { pos: new THREE.Vector3(-26, 0, 16), yaw: -0.08, pitch: -0.02, ads: false },
      ads: { pos: new THREE.Vector3(-14, 0, 6.5), yaw: -0.683, pitch: -0.045, ads: true },
      overlook: { pos: new THREE.Vector3(-24, 3.38, -3.7), yaw: -1.82, pitch: -0.14, ads: false },
      enemy: { pos: new THREE.Vector3(-14, 0, -10), yaw: 0.464, pitch: -0.02, ads: false },
      // 3.2 m off the catwalk hostile, framed left of the viewmodel — the only
      // framing that resolves anatomy.
      enemyClose: { pos: new THREE.Vector3(-23.2, 3.38, -4.0), yaw: -1.87, pitch: -0.06, ads: false },
      diagLeft: { pos: new THREE.Vector3(-24, 3.38, -3.7), yaw: -0.25, pitch: -0.02, ads: false },
    },
    step() {},
    dispose() {
      for (const g of owned) g.dispose();
      scene.remove(root, portalLight, workLight, catLight);
    },
  };
}
