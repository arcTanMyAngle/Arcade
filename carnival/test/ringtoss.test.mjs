// Level 4 Ring Toss — rigid-torus solver: quaternion sanity, no-tunnel, restitution, capture,
// determinism. Drives the pure stepRing() from physics.js (no three).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, len, qapply, qIntegrate, stepRing, ringSettle } from '../src/core/physics.js';
import { flickToLaunch } from '../src/core/kinetics.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);
const PEG = { bx: 0, by: 0, bz: 0, pR: 0.017, pH: 0.5 };
const BOARD = { nx: 0, ny: 1, nz: 0, ox: 0, oy: 0, oz: 0 };
const P = { g: -9.81, nodes: 12, pegE: 0.5, pegMuk: 0.35, boardE: 0.35, boardMuk: 0.6, sleepLin: 0.06, sleepAng: 0.3, sleepN: 15 };
const ring = (p, v, w) => ({ p: { ...p }, v: { ...v }, q: { x: 0, y: 0, z: 0, w: 1 }, w: { ...w }, R: 0.055, r: 0.008, m: 0.05, rest: false, slp: 0 });
const run = (rg, n) => { let cl = 0; for (let i = 0; i < n; i++) cl += stepRing(rg, PEG, BOARD, P, 1 / 60).clack; return cl; };

test('qapply rotates and qIntegrate stays unit-norm', () => {
  const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; // 90° about +y
  const r = qapply(q, v3(1, 0, 0));
  near(r.x, 0, 1e-9); near(r.y, 0, 1e-9); near(r.z, -1, 1e-9);   // +x -> -z
  const qq = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < 100; i++) qIntegrate(qq, v3(3, -2, 1), 1 / 60);
  near(Math.hypot(qq.x, qq.y, qq.z, qq.w), 1, 1e-9);
});

test('no tunneling: a fast ring driven at the shaft registers contact', () => {
  // center path grazes the peg at the ring centerline radius -> the wire must hit the shaft
  const rg = ring({ x: -0.7, y: 0.3, z: 0.055 }, { x: 14, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const clack = run(rg, 40);
  assert.ok(clack > 0, 'ring passed the peg with no contact (tunneled)');
});

test('restitution: a flat drop on the board never gains energy', () => {
  const rg = ring({ x: 3, y: 0.4, z: 3 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }); // far from peg
  let vDown = 0, vUp = 0;
  for (let i = 0; i < 120; i++) { stepRing(rg, PEG, BOARD, P, 1 / 60); vDown = Math.min(vDown, rg.v.y); if (rg.v.y > 0) vUp = Math.max(vUp, rg.v.y); }
  assert.ok(vUp <= -vDown + 1e-6, `bounce gained energy: up ${vUp} vs down ${-vDown}`);
});

test('capture: a centered drop settles encircling the peg (ringer)', () => {
  const rg = ring({ x: 0, y: 0.7, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 });
  for (let i = 0; i < 400 && !rg.rest; i++) stepRing(rg, PEG, BOARD, P, 1 / 60);
  assert.ok(rg.rest, 'ring never settled');
  const dAxis = Math.hypot(rg.p.x - PEG.bx, rg.p.z - PEG.bz);
  assert.ok(dAxis < rg.R - rg.r, `not encircling: center-to-axis ${dAxis} >= Ri ${rg.R - rg.r}`);
});

test('deterministic: identical launch -> identical final pose', () => {
  const hash = () => {
    const rg = ring({ x: -0.4, y: 0.6, z: 0.02 }, { x: 3.2, y: 1.5, z: 0.4 }, { x: 6, y: 0, z: 2 });
    for (let i = 0; i < 300 && !rg.rest; i++) stepRing(rg, PEG, BOARD, P, 1 / 60);
    return [rg.p.x, rg.p.y, rg.p.z, rg.q.x, rg.q.y, rg.q.z, rg.q.w].map((n) => n.toFixed(6)).join(',');
  };
  assert.equal(hash(), hash());
});

test('flickToLaunch (ring cfg): clamps + monotone, azimuth bounded', () => {
  const cfg = { k: 2.2, vMin: 2.0, vMax: 4.6, azK: 0.6, azMax: 0.35 };
  near(flickToLaunch(0, 0, cfg, {}).v0, 2.0);            // tiny flick → vMin
  near(flickToLaunch(9, 9, cfg, {}).v0, 4.6);            // huge flick → clamps at vMax
  const a = flickToLaunch(0, 0.5, cfg, {}), b = flickToLaunch(0, 1.2, cfg, {});
  assert.ok(b.v0 >= a.v0);                               // monotone in flick magnitude
  const az = flickToLaunch(3, 0, cfg, {}).az;            // azimuth clamped to ±azMax
  assert.ok(az <= 0.35 + 1e-9 && az >= -0.35);
});

test('ringSettle: encircling + low + stopped ⇒ ringer immediately; else keep simulating', () => {
  const peg = { bx: 0, by: 0.9, bz: -0.9, pR: 0.03 }, Ri = 0.075, pegH = 0.22;
  const at = (p, v) => ({ p, v });
  assert.equal(ringSettle(at({ x: 0, y: 0.95, z: -0.9 }, { x: 0, y: 0, z: 0 }), peg, Ri, pegH), 'ringer'); // captured
  assert.equal(ringSettle(at({ x: 0, y: 0.95, z: -0.9 }, { x: 0, y: -2, z: 0 }), peg, Ri, pegH), '');       // still dropping
  assert.equal(ringSettle(at({ x: 0.4, y: 0.95, z: -0.9 }, { x: 0, y: 0, z: 0 }), peg, Ri, pegH), '');      // off to the side
  assert.equal(ringSettle(at({ x: 0, y: 1.5, z: -0.9 }, { x: 0, y: 0, z: 0 }), peg, Ri, pegH), '');         // hovering above the top
});
