import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCollider } from '../src/world/collision.js';
import { rayVsVerticalCapsule, zoneForT, stepFSM, createAgentState } from '../src/ai/logic.js';
import { createAgentBody, disposeSharedBodyAssets, AGENT_R, AGENT_H } from '../src/ai/body.js';
import { PATTERN, W } from '../src/weapons/tuning.js';
import { createLevel } from '../src/world/level.js';
import { mulberry32 } from '../src/core/rng.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

test('collider preserves exact grounded contact', () => {
  const c = createCollider([{ min: V(-20, -2, -20), max: V(20, 0, 20), mat: 'asphalt' }], { floor: 0 });
  const r = c.collide(V(2, 0, 3), 0.34, 1.8);
  assert.equal(r.grounded, true);
  assert.deepEqual(r.pos.toArray(), [2, 0, 3]);
});

test('raycast returns the authored ballistic surface and normal', () => {
  const c = createCollider([{ min: V(-1, 0, -5), max: V(1, 3, -4), mat: 'paintedMetal' }]);
  const h = c.raycast(V(0, 1, 0), V(0, 0, -1), 20);
  assert.ok(h); assert.equal(h.mat, 'paintedMetal'); assert.equal(h.dist, 4);
  assert.deepEqual(h.normal.toArray(), [0, 0, 1]);
});

test('enemy hit zones match the visible vertical capsule', () => {
  const h = rayVsVerticalCapsule(0, 1.65, 4, 0, 0, -1, 0, 0, 0, 1.78, 0.36, 20);
  assert.ok(h); assert.equal(zoneForT(h.y / 1.78), 'head');
  assert.equal(zoneForT(0.55), 'torso'); assert.equal(zoneForT(0.2), 'limb');
});

test('AI reaction is deterministic for a fixed random stream', () => {
  const rng = () => 0.5, a = createAgentState(1, rng);
  stepFSM(a, { hasLOS: true, dist: 12 }, 1 / 128, rng);
  assert.equal(a.state, 'alert'); assert.ok(a.timer > 0.2 && a.timer < 0.6);
});

// Guards the boot path: mergeGeometries returns null on a mixed indexed/non-indexed
// bin, and a null-geometry Mesh only explodes at render time, not at build time.
test('agent body merges every material family into real geometry', () => {
  const b = createAgentBody(new THREE.Group());
  const seen = new Set();
  b.root.traverse((o) => {
    if (!o.isMesh) return;
    seen.add(o.name);
    const pos = o.geometry?.attributes?.position;
    assert.ok(pos && pos.count > 0, `"${o.name}" has no position attribute`);
    for (let i = 0; i < pos.array.length; i++) assert.ok(Number.isFinite(pos.array[i]));
  });
  assert.deepEqual([...seen].sort(), ['armor', 'glove', 'gun', 'skin', 'uniform', 'webbing']);
  b.dispose(); disposeSharedBodyAssets();
});

// Honest hitboxes: anything visible that the vertical capsule cannot be hit on is a lie.
// Measured per-vertex on the true radial axis — a bounding box under-reports the corners.
test('living agent anatomy stays inside the tested hit capsule', () => {
  const b = createAgentBody(new THREE.Group());
  let r2 = 0, lo = Infinity, hi = -Infinity;
  b.root.traverse((o) => {
    if (!o.isMesh || o.name === 'gun') return;
    const a = o.geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const d = a[i] * a[i] + a[i + 2] * a[i + 2];
      if (d > r2) r2 = d;
      if (a[i + 1] < lo) lo = a[i + 1];
      if (a[i + 1] > hi) hi = a[i + 1];
    }
  });
  const r = Math.sqrt(r2);
  assert.ok(lo >= -0.02 && hi <= AGENT_H, `body spans y ${lo.toFixed(3)}..${hi.toFixed(3)} vs ${AGENT_H}`);
  assert.ok(r <= AGENT_R, `body radius ${r.toFixed(4)} exceeds ${AGENT_R}`);
  b.dispose(); disposeSharedBodyAssets();
});

test('rifle cadence and recoil pattern remain finite and authored', () => {
  assert.equal(W.shotDt, 0.08); assert.equal(PATTERN.length, W.capacity);
  for (const p of PATTERN) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0);
});

// ---- world sealing -------------------------------------------------------
// The north gateway used to open onto 4 m of asphalt and then nothing, so a
// player looking through it saw the sky dome below the horizon: measured
// min-luma 0, the only crushed region in any frame. The general invariant that
// prevents any recurrence of that class of bug is that the play space is a
// closed box from every standing eye: no ray with a non-positive vertical
// component may leave the level. Rays that rise are fine — sky above the
// horizon is sky, and that is what it should look like.
//
// The real level is built here, not a stand-in, because the bug was in the real
// level's authored brushes. Only `mats` is stubbed; it is pure lookup.
const stubMats = {
  get: () => new THREE.MeshStandardMaterial(),
  tileOf: () => 2,
  env: null,
  sunDir: new THREE.Vector3(0.34, 0.62, 0.41).normalize(),
};

function buildLevel() {
  return createLevel({ scene: new THREE.Scene(), rng: mulberry32(0xB12ACE), mats: stubMats });
}

test('no standing sightline escapes the level below the horizon', () => {
  const level = buildLevel();
  const EYE = 1.58, R = 0.34, HH = 1.72;

  // Feet positions, deliberately off round coordinates so no ray grazes a brush
  // face at exactly 0 penetration — grazing hits are a numerical coin flip and
  // would make this test flaky rather than strict.
  const feet = [];
  for (let x = -28.3; x <= 28.4; x += 4.1) for (let z = -24.3; z <= 24.4; z += 4.1) feet.push(V(x, 0, z));
  for (let z = -25.4; z >= -34.2; z -= 1.6) for (const x of [-3.7, -0.3, 3.4]) feet.push(V(x, 0, z));
  for (let x = -29.1; x <= -19.6; x += 1.9) feet.push(V(x, 3.37, -4.03));   // west catwalk

  const AZ = 64, PITCH = [0, -0.03, -0.09, -0.2, -0.45];
  const escapes = [];
  let cast = 0;

  for (const f of feet) {
    // Skip positions the collider would push out of — those are inside geometry
    // and no player can stand there.
    const c = level.collide(f.clone(), R, HH);
    if (Math.hypot(c.pos.x - f.x, c.pos.z - f.z) > 1e-3) continue;
    const e = V(f.x, f.y + EYE, f.z);
    for (let a = 0; a < AZ; a++) {
      const th = (a / AZ) * Math.PI * 2;
      for (const p of PITCH) {
        const d = V(Math.cos(p) * Math.sin(th), Math.sin(p), Math.cos(p) * Math.cos(th));
        cast++;
        if (!level.raycast(e, d, 260) && escapes.length < 8) {
          escapes.push(`eye(${e.x.toFixed(1)},${e.y.toFixed(2)},${e.z.toFixed(1)}) az=${th.toFixed(2)} pitch=${p}`);
        }
      }
    }
  }

  assert.ok(cast > 40000, `sweep too sparse to mean anything: ${cast} rays`);
  assert.deepEqual(escapes, [], `${escapes.length} sightline(s) left the world`);
  level.dispose();
});

// The cheap way to "seal" the world is to brick up the gateway. That would pass
// the sweep above and delete a traversable 9 m portal, so pin the portal open:
// the axial sightline must still reach the sally port's far bulkhead.
test('the north gateway stays open onto the sally port', () => {
  const level = buildLevel();
  const h = level.raycast(V(0, 1.58, -10), V(0, 0, -1), 260);
  assert.ok(h, 'axial gate ray hit nothing');
  assert.ok(h.dist > 20, `gateway is blocked at ${h.dist.toFixed(2)} m — expected the bulkhead at ~24.8 m`);
  assert.equal(h.mat, 'concreteWall');
  level.dispose();
});
