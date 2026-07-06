// Level 2 High Striker — rail-impulse math + determinism. Run: npm test (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, integrate, railImpulse, railApex } from '../src/core/physics.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('railImpulse: heavier puck / lower e transfer less speed; matches formula', () => {
  const light = railImpulse(10, 12, 4, 0.95); // light puck, high restitution
  const heavy = railImpulse(10, 12, 8, 0.85); // heavy puck, low restitution
  assert.ok(light > heavy);
  near(light, (1 + 0.95) * (12 / (12 + 4)) * 10);
  near(railImpulse(0, 12, 6, 0.9), 0); // no swing -> no launch
});

test('railApex closed form = v0^2 / (2(g+µg))', () => {
  const v0 = 15.8, g = 9.81, mu = 0.03;
  near(railApex(v0, g, mu), (v0 * v0) / (2 * (g + mu * g)));
  assert.ok(railApex(v0, g, 0.06) < railApex(v0, g, 0.02)); // more friction -> lower apex
});

test('simulated rail rise apex matches railApex within a step', () => {
  const g = 9.81, mu = 0.03, v0 = 12, dt = 1 / 60;
  const p = v3(0, 0, 0), v = v3(0, v0, 0), a = v3(0, -(g + mu * g), 0);
  let apex = 0;
  for (let i = 0; i < 600; i++) { integrate(p, v, a, dt); if (p.y > apex) apex = p.y; if (v.y <= 0) break; }
  near(apex, railApex(v0, g, mu), 0.12); // semi-implicit Euler is within ~half a step of g
});

test('deterministic swing: identical release frame -> identical apex; peak beats off-peak', () => {
  // mirrors highstriker.js: triangle meter -> (charge, acc) -> v0 -> apex, pure fn of frame
  const SWING = 8, mH = 12, mP = 6, e = 0.90, gain = 1.15, mu = 0.04, g = 9.81;
  const RISE = 42, ACC_MIN = 0.5, win = 5;
  const apexAt = (cyc) => {
    const ph = cyc % (2 * RISE), charge = ph <= RISE ? ph / RISE : (2 * RISE - ph) / RISE;
    const d = Math.abs(ph - RISE), acc = ACC_MIN + (1 - ACC_MIN) * Math.max(0, 1 - d / win);
    return railApex(railImpulse(SWING * gain * charge * acc, mH, mP, e), g, mu);
  };
  assert.equal(apexAt(42), apexAt(42));      // same frame -> identical result
  assert.ok(apexAt(42) > apexAt(30));        // peak (frame 42) beats an early release
  assert.ok(apexAt(42) > apexAt(46));        // ... and a late release
});
