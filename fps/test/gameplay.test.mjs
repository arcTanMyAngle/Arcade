import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCollider } from '../src/world/collision.js';
import { rayVsVerticalCapsule, zoneForT, stepFSM, createAgentState } from '../src/ai/logic.js';
import { createAgentBody, disposeSharedBodyAssets, AGENT_R, AGENT_H } from '../src/ai/body.js';
import { PATTERN, W } from '../src/weapons/tuning.js';

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
