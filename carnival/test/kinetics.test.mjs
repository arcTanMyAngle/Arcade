// kinetics.test.mjs — pure input math: flick estimator, drag FSM, snapshot fold, pack/hash determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K, DPHASE, makeKin, makeFrame, kinPointer, kinButton, kinKey, kinReset, kinSnap,
  flickFromSamples, dragToShot, flickToLaunch, packFrame, unpackFrame, hashFrames
} from '../src/core/kinetics.js';

const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('flick estimator: windowed mean over trailing samples', () => {
  const buf = new Float64Array(32 * 3);
  // three +x moves of 0.1 at t=0,10,20; head=2
  buf[0] = 0.1; buf[2] = 0; buf[3] = 0.1; buf[5] = 10; buf[6] = 0.1; buf[8] = 20;
  const o = flickFromSamples(buf, 2, 3, 20, 100, { vx: 0, vy: 0 });
  close(o.vx, 0.3 / 20 * 1000); // span=20ms → 15 units/s
  close(o.vy, 0);
});

test('flick estimator: excludes samples older than the window', () => {
  const buf = new Float64Array(32 * 3);
  buf[0] = 1.0; buf[2] = 0;    // old, big — must be dropped (t=0, >100ms before tRel)
  buf[3] = 0.1; buf[5] = 100;
  buf[6] = 0.1; buf[8] = 190;
  const o = flickFromSamples(buf, 2, 3, 190, 100, { vx: 0, vy: 0 });
  close(o.vx, 0.2 / 90 * 1000);     // only the two recent samples, span=90ms
});

test('flick estimator: span clamp prevents 1-sample blow-up', () => {
  const buf = new Float64Array(32 * 3);
  buf[0] = 0.5; buf[2] = 20;
  const o = flickFromSamples(buf, 0, 1, 20, 100, { vx: 0, vy: 0 });
  close(o.vx, 0.5 / 8 * 1000);      // span clamped to 8ms
});

test('drag FSM: press→drag past dead-zone; sub-dead is a click (edges, no RELEASE)', () => {
  const k = makeKin();
  kinButton(k, 0, true, 0, 0, 0);
  assert.equal(k.dphase, DPHASE.PRESS);
  kinPointer(k, 0.005, 0, 0.005, 0, 1);
  assert.equal(k.dphase, DPHASE.PRESS);          // under dead=0.012
  kinPointer(k, 0.02, 0, 0.015, 0, 2);
  assert.equal(k.dphase, DPHASE.DRAG);

  const c = makeKin();                            // pure click
  kinButton(c, 0, true, 0, 0, 0);
  kinButton(c, 0, false, 0, 0, 5);
  assert.equal(c.press, 1); assert.equal(c.release, 1); assert.equal(c.dphase, DPHASE.IDLE);
});

test('drag FSM: release computes flick; RELEASE valid exactly one snap', () => {
  const k = makeKin(); const f = makeFrame();
  kinButton(k, 0, true, 0, 0, 0);
  kinPointer(k, 0, 0.1, 0, 0.1, 10);
  kinPointer(k, 0, 0.2, 0, 0.1, 20);
  kinButton(k, 0, false, 0, 0.2, 30);
  kinSnap(k, f);
  assert.equal(f.dphase, DPHASE.RELEASE); assert.ok(f.flickVY > 0);
  const g = makeFrame(); kinSnap(k, g);
  assert.equal(g.dphase, DPHASE.IDLE); assert.equal(g.flickVY, 0);
});

test('drag FSM: RMB cancels a drag (no RELEASE frame)', () => {
  const k = makeKin(); const f = makeFrame();
  kinButton(k, 0, true, 0, 0, 0);
  kinPointer(k, 0, 0.2, 0, 0.2, 10);
  assert.equal(k.dphase, DPHASE.DRAG);
  kinButton(k, 2, true, 0, 0.2, 15);             // cancel
  assert.equal(k.dphase, DPHASE.IDLE);
  kinButton(k, 0, false, 0, 0.2, 20);
  kinSnap(k, f);
  assert.notEqual(f.dphase, DPHASE.RELEASE); assert.equal(f.flickVY, 0);
});

test('snapshot fold: sums deltas + counts edges, then clears', () => {
  const k = makeKin();
  kinPointer(k, 0.05, 0, 0.05, 0, 1);
  kinPointer(k, 0.10, 0, 0.05, 0, 2);
  kinButton(k, 0, true, 0.1, 0, 3);
  kinButton(k, 0, false, 0.1, 0, 4);
  const f = makeFrame(); kinSnap(k, f);
  close(f.dx, 0.1); assert.equal(f.press, 1); assert.equal(f.release, 1);
  const g = makeFrame(); kinSnap(k, g);
  assert.equal(g.dx, 0); assert.equal(g.press, 0); assert.equal(g.release, 0);
});

test('key bitmask: edge fires once, held persists, release clears', () => {
  const k = makeKin();
  kinKey(k, K.A, true);
  let f = makeFrame(); kinSnap(k, f);
  assert.ok(f.keys & K.A); assert.ok(f.keyPress & K.A);
  kinKey(k, K.A, true);                           // still held, no new edge
  f = makeFrame(); kinSnap(k, f);
  assert.ok(f.keys & K.A); assert.equal(f.keyPress & K.A, 0);
  kinKey(k, K.A, false);
  f = makeFrame(); kinSnap(k, f);
  assert.equal(f.keys & K.A, 0);
});

test('SWALLOW suppresses edges after a reset', () => {
  const k = makeKin(); kinReset(k);
  kinButton(k, 0, true, 0, 0, 0);
  const f = makeFrame(); kinSnap(k, f);
  assert.equal(f.press, 0); assert.equal(f.lmb, 1);  // held tracked, edge suppressed
});

test('pack/unpack round-trips every field', () => {
  const f = makeFrame(), g = makeFrame();
  Object.keys(f).forEach((key, i) => { f[key] = i + 0.5; });
  const f64 = new Float64Array(24);
  packFrame(f, f64, 0); unpackFrame(f64, 0, g);
  assert.deepEqual(g, f);
});

test('hashFrames: deterministic + sensitive', () => {
  const a = makeFrame(), b = makeFrame();
  a.yaw = 0.3; a.press = 1; b.yaw = 0.3; b.press = 1;
  const f64 = new Float64Array(48);
  packFrame(a, f64, 0); packFrame(b, f64, 24);
  const h1 = hashFrames(f64, 2);
  const g64 = f64.slice();
  assert.equal(hashFrames(g64, 2), h1);          // identical bytes → identical hash
  g64[2] += 1e-9;                                 // perturb one float
  assert.notEqual(hashFrames(g64, 2), h1);
});

test('dragToShot: v0 monotone in pull; θ/az clamped', () => {
  const cfg = { pullMax: 0.5, vMin: 5.5, vMax: 10.5, thMin: 0.61, thMax: 1.22, azK: 0.35, azMax: 0.15 };
  const a = dragToShot(0, -0.1, cfg, {}), b = dragToShot(0, -0.4, cfg, {});
  assert.ok(b.v0 > a.v0);
  const hard = dragToShot(-1, -1, cfg, {});       // way past pullMax + steep
  assert.ok(hard.th <= cfg.thMax + 1e-9 && hard.th >= cfg.thMin);
  assert.ok(hard.az <= cfg.azMax + 1e-9 && hard.az >= -cfg.azMax);
});

test('flickToLaunch: v0 monotone then clamps', () => {
  const cfg = { k: 2.2, vMin: 2.0, vMax: 4.6, azK: 0.6, azMax: 0.35 };
  close(flickToLaunch(0, 0, cfg, {}).v0, cfg.vMin);            // tiny → vMin
  close(flickToLaunch(10, 10, cfg, {}).v0, cfg.vMax);          // huge → vMax
  const m = flickToLaunch(0, 1.2, cfg, {});
  assert.ok(m.v0 > cfg.vMin && m.v0 < cfg.vMax);              // mid range monotone
});
