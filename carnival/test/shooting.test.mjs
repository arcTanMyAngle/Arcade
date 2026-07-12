// Level 1 TARGET PLINKER — hinged knock-down plate torque: kick math, break-over bistability,
// mass-honest survival, and full seeded-pipeline determinism. Drives the pure physics.js solvers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  v3, add, integrate, windDrag, segCrossPlaneZ, lerpSeg, clamp, len, mulberry32, G,
  hingeKick, hingeStep, HINGE_TIP
} from '../src/core/physics.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('hingeKick: ω = J·h / (m·H²/3), rising with arm, falling with mass/height', () => {
  near(hingeKick(0.4, 0.2, 0.4, 0.30), 0.4 * 0.2 / (0.4 * 0.09 / 3));   // 0.08/0.012 = 6.667
  assert.ok(hingeKick(0.4, 0.30, 0.4, 0.30) > hingeKick(0.4, 0.10, 0.4, 0.30)); // higher hit = more spin
  assert.ok(hingeKick(0.4, 0.2, 5.0, 0.40) < hingeKick(0.4, 0.2, 0.4, 0.30));   // heavy/tall = less spin
});

test('hingeStep: super-threshold impulse reaches π/2; sub-threshold wobbles back', () => {
  const m = 0.4, H = 0.30, damp = 1.2, dt = 1 / 60;
  const sup = { th: 0, om: hingeKick(1.0, 0.25, m, H) }; let fell = false;   // hard, high hit
  for (let i = 0; i < 240 && !fell; i++) fell = hingeStep(sup, m, H, damp, dt);
  assert.ok(fell, 'a hard hit should topple the plate'); near(sup.th, Math.PI / 2, 1e-9);

  const sub = { th: 0, om: hingeKick(0.05, 0.1, m, H) }; let subFell = false, maxTh = 0; // soft graze
  for (let i = 0; i < 240; i++) { subFell = hingeStep(sub, m, H, damp, dt) || subFell; maxTh = Math.max(maxTh, sub.th); }
  assert.equal(subFell, false, 'a soft graze must not knock it down');
  assert.ok(maxTh < HINGE_TIP, 'never crossed break-over'); assert.ok(Math.abs(sub.th) < 0.05, 'settled upright');
});

test('same impulse: tin falls, iron survives (mass-honest)', () => {
  const dt = 1 / 60, damp = 1.2, J = 0.4, h = 0.2;
  const tin = { th: 0, om: hingeKick(J, h, 0.4, 0.30) };
  const iron = { th: 0, om: hingeKick(J, h, 2.2, 0.34) };
  let tinFell = false, ironFell = false;
  for (let i = 0; i < 300; i++) {
    tinFell = hingeStep(tin, 0.4, 0.30, damp, dt) || tinFell;
    ironFell = hingeStep(iron, 2.2, 0.34, damp, dt) || ironFell;
  }
  assert.ok(tinFell, 'tin should knock down');
  assert.equal(ironFell, false, 'iron should survive the identical hit');
});

test('determinism: seeded gusts + fixed fire log → identical knockdown outcome', () => {
  const sim = (seed) => {
    const rng = mulberry32(seed), wind = 3.0, TARGET_Z = -16, m = 2.2, H = 0.34, y0 = 1.35, damp = 1.2;
    const knots = Array.from({ length: 96 }, () => (rng() * 2 - 1) * wind);
    const windX = (t) => { const s = t / 2.2, i = Math.floor(s) % (knots.length - 1), f = s - Math.floor(s); return knots[i] * (1 - f) + knots[i + 1] * f; };
    const pl = { th: 0, om: 0, fallen: false }, bullets = []; let falls = 0;
    const fireAt = new Set([0, 30, 60]);
    for (let n = 0; n < 300; n++) {
      const tSim = n / 60, w = v3(windX(tSim), 0, 0);
      if (fireAt.has(n)) bullets.push({ p: v3(0, 1.7, 2), v: v3(0, -0.1, -100), done: false });
      for (const b of bullets) {
        if (b.done) continue;
        const prev = { ...b.p };
        integrate(b.p, b.v, add(G, windDrag(b.v, w, 0.008)), 1 / 60);
        if (prev.z > TARGET_Z && b.p.z <= TARGET_Z) {
          const t = segCrossPlaneZ(prev, b.p, TARGET_Z), h = lerpSeg(prev, b.p, t);
          if (!pl.fallen && Math.abs(h.x) < 0.28 && h.y >= y0 && h.y <= y0 + H) pl.om += hingeKick(0.008 * len(b.v), clamp(h.y - y0, 0.02, H), m, H);
          b.done = true;
        }
      }
      if (!pl.fallen && hingeStep(pl, m, H, damp, 1 / 60)) { pl.fallen = true; falls++; }
    }
    return falls + '|' + pl.th.toFixed(6);
  };
  assert.equal(sim(0x5EED), sim(0x5EED));
});
