// Level 3 Balloon Dart — ballistic closed form, swept thin-hitbox boundary, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, copy, integrate, sweptPointSphere, lerpSeg, G } from '../src/core/physics.js';

const near = (a, b, eps = 1e-2) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('dart apex/range match closed-form ballistics (kD=0)', () => {
  const g = -G.y, v0 = 24, ang = 0.35;           // launch angle (rad) above horizontal
  const vx = v0 * Math.cos(ang), vy = v0 * Math.sin(ang);
  const p = v3(0, 0, 0), v = v3(vx, vy, 0), dt = 1 / 60;
  let apex = 0, range = 0;
  for (let i = 0; i < 2000; i++) {
    const py = p.y; integrate(p, v, G, dt);
    if (p.y > apex) apex = p.y;
    if (py >= 0 && p.y < 0) { range = p.x; break; }   // crossed back to launch height
  }
  near(apex, (vy * vy) / (2 * g), 0.12);          // H = vy²/2g (semi-implicit within ~half a step)
  near(range, vx * (2 * vy / g), 0.5);            // R = vx·2vy/g
});

test('swept tip pops only when it truly enters the balloon sphere (thin hitbox)', () => {
  const c = v3(0, 2, -12.8), rB = 0.05;            // T5 5cm balloon
  // dead-on throw crosses the sphere -> hit
  assert.ok(sweptPointSphere(v3(0, 2, 0), v3(0, 2, -20), c, rB) >= 0);
  // 6cm high -> just outside a 5cm balloon -> miss (no fudge)
  assert.equal(sweptPointSphere(v3(0, 2.06, 0), v3(0, 2.06, -20), c, rB), -1);
});

test('exposure cap: a hit on the covered side is rejected, exposed side accepted', () => {
  const bx = 0, by = 2, rB = 0.11, expo = 0.35;
  const popThresh = rB * (1 - 2 * expo);           // as in dart.js
  const check = (offX) => {                          // dart flies straight -z at local x=offX
    const c = v3(bx, by, -12.8);
    const t = sweptPointSphere(v3(bx + offX, by, 0), v3(bx + offX, by, -20), c, rB);
    if (t < 0) return false;
    const h = lerpSeg(v3(bx + offX, by, 0), v3(bx + offX, by, -20), t);
    return h.x - bx >= popThresh;
  };
  assert.equal(check(-rB * 0.8), false);           // left (covered) side -> blocked
  assert.equal(check(rB * 0.8), true);             // right (exposed) side -> pops
});

test('deterministic flight: identical throw -> identical impact', () => {
  const run = () => {
    const p = v3(0, 1.7, 0), v = v3(2, 4, -22);
    for (let i = 0; i < 400; i++) { const prev = { ...p }; integrate(p, v, G, 1 / 60); if (p.z <= -13) return lerpSeg(prev, p, 0.5).x.toFixed(6) + ',' + p.y.toFixed(6); }
    return 'none';
  };
  assert.equal(run(), run());
});
