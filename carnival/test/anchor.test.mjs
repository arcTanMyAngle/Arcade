// Level 2 ANCHOR SMASH — hammer-track impact solver + the pure rhythm-energy / flick-alignment
// scoring pipeline. Mirrors games/anchor.js on the shared pure solvers (physics.trackImpact,
// kinetics.beatAcc): zero RNG in outcome, so a fixed beat-frame log + flick numbers score identically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackImpact, H_TRACK } from '../src/core/physics.js';
import { beatAcc } from '../src/core/kinetics.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const g = 9.81;

// --- pure scoring pipeline, verbatim from anchor.js ---
const FLICK_TO_V = 1.8, VCAP = 3.5;
const alignFrom = (vx, vy) => 1 - clamp(Math.abs(vx) / Math.abs(vy), 0, 1);
const multFrom = (align) => 1 + 2 * align * align;
const vfFrom = (flickVY) => FLICK_TO_V * Math.min(-flickVY, VCAP);
// accumulate flywheel energy from a beat log: {hit:bool, err} — hit pumps, else 0.85× decay
function energy(log, E_HIT, win) {
  let E = 0;
  for (const b of log) E = b.hit ? E + E_HIT * beatAcc(b.err, win) : E * 0.85;
  return E;
}
function score(E, flickVX, flickVY, T) {
  const E_MAX = T.L * T.E_HIT;
  const VIMP_REF = trackImpact(FLICK_TO_V * VCAP, E_MAX, T.mH, H_TRACK, T.mu);
  const vf = vfFrom(flickVY), align = alignFrom(flickVX, flickVY);
  const power = Math.min(trackImpact(vf, E, T.mH, H_TRACK, T.mu) / VIMP_REF, 1);
  return Math.round(400 * power * power * multFrom(align));
}
const T1 = { bpm: 92, L: 6, win: 6, mu: 0.02, mH: 10, E_HIT: 120 };

test('trackImpact: E=0 reduces to the driven-drop closed form √(vf² + 2g(1−μ)H)', () => {
  const vf = 2.5, mu = 0.04, H = H_TRACK;
  near(trackImpact(vf, 0, 12, H, mu), Math.sqrt(vf * vf + 2 * g * (1 - mu) * H));
  near(trackImpact(0, 0, 12, H, 0), Math.sqrt(2 * g * H));   // pure free drop
});

test('trackImpact strictly increases with stored energy E and entry speed vf', () => {
  const a = trackImpact(2, 100, 12, H_TRACK, 0.04);
  const bE = trackImpact(2, 400, 12, H_TRACK, 0.04);
  const bV = trackImpact(4, 100, 12, H_TRACK, 0.04);
  assert.ok(bE > a, 'more flywheel energy → harder impact');
  assert.ok(bV > a, 'faster flick entry → harder impact');
});

test('alignment mult: a pure-vertical flick is 3×, a 45° flick is 1×', () => {
  near(multFrom(alignFrom(0, -2)), 3);       // no horizontal component → align 1 → 3×
  near(multFrom(alignFrom(2, -2)), 1);       // 45°: |vx|=|vy| → align 0 → 1×
  const diag = multFrom(alignFrom(1, -2));   // shallow-ish diagonal sits between
  assert.ok(diag > 1 && diag < 3);
});

test('rhythm energy: a perfect chain reaches E_MAX exactly; a single miss decays 0.85×', () => {
  const perfect = Array.from({ length: T1.L }, () => ({ hit: true, err: 0 }));
  near(energy(perfect, T1.E_HIT, T1.win), T1.L * T1.E_HIT);            // every beat perfect → E_MAX
  const oneThenMiss = [{ hit: true, err: 0 }, { hit: false, err: 0 }];
  near(energy(oneThenMiss, T1.E_HIT, T1.win), T1.E_HIT * 0.85);        // pump then bleed
  // a mistimed hit banks strictly less than a perfect one
  assert.ok(energy([{ hit: true, err: 4 }], T1.E_HIT, T1.win) < T1.E_HIT);
});

test('determinism: a fixed beat-frame log + flick numbers score identically twice', () => {
  const log = [                                                         // hits, a wrong key, a missed beat
    { hit: true, err: 0 }, { hit: true, err: 2 }, { hit: false, err: 0 },
    { hit: true, err: 1 }, { hit: true, err: 0 }, { hit: false, err: 0 }
  ];
  const run = () => score(energy(log, T1.E_HIT, T1.win), -0.3, -2.4, T1);
  assert.equal(run(), run());
  assert.ok(run() > 0, 'a played round scores something');
  // perfect play maxes power → 400·1·3 = 1200
  const perfectE = T1.L * T1.E_HIT;
  assert.equal(score(perfectE, 0, -VCAP, T1), 1200);
});
