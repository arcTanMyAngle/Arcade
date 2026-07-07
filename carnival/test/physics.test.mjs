// Headless determinism + solver asserts. Run: npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  v3, integrate, windDrag, sweptPointSphere, segCrossPlaneZ, lerpSeg,
  mulberry32, G, add
} from '../src/core/physics.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('projectile drop matches closed form y=y0+v0t-1/2 g t^2', () => {
  // integrate 1s of free fall from rest, compare to analytic (semi-implicit Euler)
  const p = v3(0, 100, 0), v = v3(0, 0, 0), dt = 1 / 60;
  let t = 0;
  for (let i = 0; i < 60; i++) { integrate(p, v, G, dt); t += dt; }
  const analytic = 100 + 0 - 0.5 * 9.81 * t * t;
  // semi-implicit Euler drifts by ~half a step of g*dt*t; allow small tolerance
  near(p.y, analytic, 0.1);
  near(v.y, -9.81 * t, 1e-6);
});

test('windDrag opposes relative velocity', () => {
  const v = v3(10, 0, 0), w = v3(0, 0, 0);
  const a = windDrag(v, w, 0.01);
  assert.ok(a.x < 0 && a.y === 0 && a.z === 0);
  // symmetric: reversing rel vel reverses drag
  const a2 = windDrag(v3(-10, 0, 0), w, 0.01);
  near(a.x, -a2.x, 1e-9);
});

test('sweptPointSphere detects and misses correctly (no tunneling)', () => {
  const c = v3(0, 0, -10), r = 0.2;
  // straight shot through center -> hit near t where z reaches -10 (segment -0..-20)
  const t = sweptPointSphere(v3(0, 0, 0), v3(0, 0, -20), c, r);
  assert.ok(t > 0 && t < 1);
  near(0 + (-20) * t, -10 + r, 0.05); // enters front face of sphere ~ -9.8
  // fast pass but off to the side -> miss
  assert.equal(sweptPointSphere(v3(1, 0, 0), v3(1, 0, -20), c, r), -1);
  // starting inside -> t=0
  assert.equal(sweptPointSphere(v3(0, 0, -10), v3(0, 1, -10), c, r), 0);
});

test('segCrossPlaneZ + lerpSeg give plane hit point', () => {
  const p0 = v3(0, 5, 0), p1 = v3(3, 2, -12);
  const t = segCrossPlaneZ(p0, p1, -6); // halfway in z
  near(t, 0.5, 1e-9);
  const h = lerpSeg(p0, p1, t);
  near(h.x, 1.5); near(h.y, 3.5); near(h.z, -6);
});

test('mulberry32 is deterministic and stable per seed', () => {
  const a = mulberry32(12345), b = mulberry32(12345);
  const sa = [a(), a(), a()], sb = [b(), b(), b()];
  assert.deepEqual(sa, sb);
  const c = mulberry32(99);
  assert.notDeepEqual(sa, [c(), c(), c()]);
  for (const x of sa) assert.ok(x >= 0 && x < 1);
});

test('full-shot determinism: identical inputs -> identical hit fraction', () => {
  // simulate a bullet with gravity+wind twice; hashes must match
  const run = () => {
    const p = v3(0, 1.6, 0), v = v3(0, 0, -90), w = v3(2, 0, 0), k = 0.02;
    const hits = [];
    for (let i = 0; i < 120; i++) {
      const prev = { ...p };
      const a = add(G, windDrag(v, w, k));
      integrate(p, v, a, 1 / 60);
      const t = segCrossPlaneZ(prev, p, -30);
      if (t >= 0) { hits.push(lerpSeg(prev, p, t).x.toFixed(6)); break; }
    }
    return hits.join(',');
  };
  assert.equal(run(), run());
});
