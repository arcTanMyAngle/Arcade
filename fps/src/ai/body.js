// Procedural hostile silhouette. Each material family is baked into one shared
// geometry, so richer anatomy/equipment costs six draws per agent rather than a
// draw for every pouch and limb. The living body stays inside AGENT_R/AGENT_H.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AGENT_R, AGENT_H } from './logic.js';
import { clamp01, springDamp } from '../core/mathx.js';

let shared = null;

function buildShared() {
  const bins = { uniform: [], armor: [], webbing: [], skin: [], glove: [], gun: [] };
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), m = new THREE.Matrix4();
  // RoundedBoxGeometry is non-indexed while the primitives are indexed; mergeGeometries
  // rejects a mixed bin, so everything is flattened to non-indexed on the way in.
  const push = (bin, g) => {
    if (!g.index) return bins[bin].push(g);
    const f = g.toNonIndexed(); g.dispose(); bins[bin].push(f);
  };
  const add = (bin, g, pos, rot = [0, 0, 0], scale = [1, 1, 1]) => {
    p.set(...pos); q.setFromEuler(new THREE.Euler(...rot)); s.set(...scale); m.compose(p, q, s);
    g.applyMatrix4(m); push(bin, g);
  };
  const rb = (bin, w, h, d, r, pos, rot) => add(bin, new RoundedBoxGeometry(w, h, d, 2, r), pos, rot);
  // Tapered limb segment: same +Y-to-(b-a) orientation the old capsule bone used, but
  // the two ends carry independent radii so thighs/calves/arms narrow toward the joints.
  const taper = (bin, a, b, ra, rb2, sides = 8) => {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av), len = Math.max(0.001, v.length());
    const g = new THREE.CylinderGeometry(rb2, ra, len, sides, 1);
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()); p.copy(av).add(bv).multiplyScalar(0.5); s.set(1, 1, 1); m.compose(p, q, s);
    g.applyMatrix4(m); push(bin, g);
  };
  // Joint mass. Knees/elbows live in the armor bin so the pad reads as a dark break.
  const ball = (bin, pos, r, seg = 8, scale = [1, 1, 1]) => add(bin, new THREE.SphereGeometry(r, seg, seg >> 1), pos, [0, 0, 0], scale);
  const cyl = (bin, r, h, pos, rot = [0, 0, 0], sides = 10) => add(bin, new THREE.CylinderGeometry(r, r, h, sides), pos, rot);

  // Legs. Ankle 0.042 -> calf belly 0.072 -> knee 0.052 -> hip 0.086: real taper, so the
  // stance reads narrow at the boot and wide at the hip instead of as two even sausages.
  // Left foot leads; boots are 0.135 wide rather than the old 0.19 clown last.
  const leg = (sx, ank, calf, knee, mid, hip) => {
    rb('armor', 0.135, 0.13, 0.285, 0.035, [ank[0], 0.065, ank[2] - 0.03], [0, sx * 0.07, 0]);
    rb('armor', 0.112, 0.095, 0.145, 0.032, [ank[0], 0.155, ank[2] + 0.01], [0.05, sx * 0.07, 0]);
    taper('uniform', ank, calf, 0.042, 0.072);
    taper('uniform', calf, knee, 0.072, 0.052);
    ball('armor', knee, 0.062, 8, [1, 0.92, 1.05]);
    taper('uniform', knee, mid, 0.058, 0.075);
    taper('uniform', mid, hip, 0.075, 0.086);
  };
  leg(-1, [-0.118, 0.195, -0.055], [-0.128, 0.335, -0.005], [-0.133, 0.495, 0.040], [-0.128, 0.665, 0.028], [-0.121, 0.845, 0.010]);
  leg(1, [0.124, 0.195, 0.005], [0.136, 0.335, -0.005], [0.143, 0.495, -0.028], [0.134, 0.665, -0.010], [0.121, 0.845, 0.008]);
  rb('webbing', 0.072, 0.135, 0.10, 0.025, [0.196, 0.645, -0.020]);
  rb('uniform', 0.285, 0.19, 0.215, 0.065, [0, 0.880, 0]);
  rb('webbing', 0.315, 0.055, 0.230, 0.018, [0, 0.958, 0]);

  // Torso is two stacked masses (waist 0.32 wide, chest 0.415) so it V-tapers, then the
  // carrier is given real profile depth and wraps the sides to break value against the uniform.
  rb('uniform', 0.32, 0.26, 0.215, 0.070, [0, 1.06, 0.005]);
  rb('uniform', 0.415, 0.30, 0.245, 0.085, [0, 1.30, 0.005], [-0.03, 0, 0]);
  rb('armor', 0.315, 0.42, 0.135, 0.055, [0, 1.225, -0.135], [-0.03, 0, 0]);
  rb('armor', 0.315, 0.40, 0.120, 0.050, [0, 1.235, 0.145], [-0.03, 0, 0]);
  rb('armor', 0.345, 0.155, 0.285, 0.030, [0, 1.075, 0]);
  rb('armor', 0.085, 0.055, 0.34, 0.020, [-0.125, 1.425, -0.005], [0.06, 0, 0]);
  rb('armor', 0.085, 0.055, 0.34, 0.020, [0.125, 1.425, -0.005], [0.06, 0, 0]);
  // Thin PALS ladders instead of a full-width yoke: kit texture without a bright collar bar.
  for (const y of [1.185, 1.275]) rb('webbing', 0.30, 0.026, 0.03, 0.008, [0, y, -0.207], [-0.03, 0, 0]);
  for (const x of [-0.115, 0, 0.115]) rb('webbing', 0.088, 0.14, 0.07, 0.018, [x, 1.015, -0.215], [-0.04, 0, 0]);
  rb('webbing', 0.09, 0.115, 0.055, 0.018, [-0.135, 1.300, -0.200], [-0.03, 0, 0]);
  // Shallower pack (0.09 deep) keeps total torso depth ~0.47 m so the 3/4 read is not barrel-shaped.
  rb('webbing', 0.245, 0.245, 0.09, 0.035, [0, 1.245, 0.228]);
  rb('armor', 0.215, 0.055, 0.075, 0.022, [0, 1.352, 0.225]);
  taper('armor', [0.128, 1.415, 0.185], [0.158, 1.700, 0.215], 0.011, 0.006, 6);
  rb('armor', 0.105, 0.115, 0.185, 0.048, [-0.244, 1.398, -0.005], [0, 0, -0.16]);
  rb('armor', 0.105, 0.115, 0.185, 0.048, [0.244, 1.398, -0.005], [0, 0, 0.16]);

  // Arms: deltoid ball, 0.066 -> 0.046 upper, armor elbow pad, 0.054 -> 0.037 forearm.
  const arm = (sh, el, wr, hd) => {
    ball('uniform', sh, 0.070, 8, [1, 1.05, 1]);
    taper('uniform', sh, el, 0.066, 0.046);
    ball('armor', el, 0.050);
    taper('uniform', el, wr, 0.054, 0.037);
    taper('glove', wr, hd, 0.046, 0.040);
    ball('glove', hd, 0.042);
  };
  arm([-0.182, 1.405, -0.005], [-0.252, 1.185, -0.062], [-0.118, 1.138, -0.242], [-0.068, 1.132, -0.296]);
  arm([0.182, 1.405, -0.005], [0.252, 1.178, -0.062], [0.112, 1.128, -0.248], [0.066, 1.122, -0.292]);

  // Head: 0.24 m helmet (was 0.32), lifted onto a real neck with an armor collar under it
  // so the skull reads as a separate mass. Helmet crown tops out at 1.763 m.
  taper('skin', [0, 1.378, 0.012], [0, 1.535, -0.002], 0.062, 0.054, 10);
  rb('armor', 0.185, 0.085, 0.175, 0.045, [0, 1.442, 0.005]);
  ball('skin', [0, 1.633, -0.006], 0.098, 12, [1, 1.14, 1.14]);
  rb('skin', 0.115, 0.075, 0.115, 0.030, [0, 1.558, -0.045]);
  add('armor', new THREE.SphereGeometry(0.116, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.72), [0, 1.647, -0.004], [0, 0, 0], [1.03, 1, 1.10]);
  rb('armor', 0.19, 0.10, 0.09, 0.035, [0, 1.580, 0.075]);
  rb('armor', 0.070, 0.050, 0.075, 0.020, [0, 1.706, -0.098]);
  rb('armor', 0.212, 0.062, 0.085, 0.022, [0, 1.660, -0.090], [-0.06, 0, 0]);
  rb('webbing', 0.232, 0.038, 0.232, 0.014, [0, 1.646, -0.005]);
  rb('webbing', 0.145, 0.085, 0.09, 0.028, [0, 1.560, -0.072], [0.05, 0, 0]);

  // Compact carbine: stock, receiver, handguard, curved mag, optic and barrel.
  rb('gun', 0.10, 0.105, 0.23, 0.018, [0.015, 1.18, -0.34]);
  rb('gun', 0.075, 0.082, 0.31, 0.015, [0.015, 1.19, -0.60]);
  rb('gun', 0.13, 0.12, 0.16, 0.025, [0.015, 1.18, -0.145], [0.05, 0, 0]);
  rb('gun', 0.085, 0.23, 0.11, 0.018, [0.015, 1.03, -0.35], [-0.20, 0, 0]);
  rb('gun', 0.075, 0.075, 0.075, 0.012, [0.015, 1.30, -0.42]);
  cyl('gun', 0.019, 0.32, [0.015, 1.19, -0.91], [Math.PI * 0.5, 0, 0], 10);
  cyl('gun', 0.032, 0.095, [0.015, 1.19, -1.095], [Math.PI * 0.5, 0, 0], 10);

  const geos = {}, mats = {
    uniform: new THREE.MeshStandardMaterial({ color: 0x4b5145, roughness: 0.92, metalness: 0.02 }),
    // Carrier/helmet are pushed well below the uniform in value and given a nylon sheen so
    // the torso separates from the olive limbs at 4-10 m; webbing goes coyote to read as kit.
    armor: new THREE.MeshStandardMaterial({ color: 0x1b201f, roughness: 0.52, metalness: 0.18 }),
    webbing: new THREE.MeshStandardMaterial({ color: 0x6d6248, roughness: 0.88, metalness: 0.02 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x8e6349, roughness: 0.86, metalness: 0 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.92, metalness: 0 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x171b1c, roughness: 0.38, metalness: 0.68 }),
  };
  for (const [k, a] of Object.entries(bins)) {
    const g = mergeGeometries(a, false);
    if (!g) throw new Error(`agent body: "${k}" bin failed to merge`);
    g.computeBoundingSphere(); geos[k] = g;
    for (const x of a) x.dispose();
  }
  shared = { geos, mats };
  return shared;
}

function getShared() { return shared || buildShared(); }

export function disposeSharedBodyAssets() {
  if (!shared) return;
  for (const g of Object.values(shared.geos)) g.dispose();
  for (const m of Object.values(shared.mats)) m.dispose();
  shared = null;
}

export function createAgentBody(parent) {
  const S = getShared(), root = new THREE.Group(), rig = new THREE.Group(); root.add(rig);
  for (const k of Object.keys(S.geos)) {
    const m = new THREE.Mesh(S.geos[k], S.mats[k]);
    m.name = k; m.castShadow = true; m.receiveShadow = false; rig.add(m);
  }
  parent.add(root);
  let kick = 0, kickV = 0, lean = 0, leanV = 0;

  return {
    root,
    update(dt, pos, yaw, exposed, leanSign, dead, deathT, fallSeed) {
      if (!dead) {
        root.position.copy(pos); root.rotation.y = yaw;
        // Maximum offset plus the outer arm radius remains inside AGENT_R.
        [lean, leanV] = springDamp(lean, leanV, exposed ? leanSign * 0.014 : 0, 9, dt);
        [kick, kickV] = springDamp(kick, kickV, 0, 20, dt);
        rig.position.set(lean, 0, 0); rig.rotation.set(kick, 0, 0);
      } else {
        const t = clamp01(deathT / 0.6), e = 1 - (1 - t) ** 3, ang = fallSeed * Math.PI * 2;
        rig.position.x = 0;
        rig.rotation.x = -Math.cos(ang) * e * (Math.PI / 2);
        rig.rotation.z = Math.sin(ang) * e * (Math.PI / 2);
      }
    },
    flinch() { kickV -= 3.0; },
    setVisible(v) { root.visible = v; },
    dispose() { parent.remove(root); },
  };
}

export { AGENT_R, AGENT_H };
