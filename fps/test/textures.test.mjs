// Guards against silently-degenerate procedural textures.
//
// Motivating bug: `octave()` indexes its lattice as g[j*px + i]. A fractional
// `px` (grime/streaks passed 2.5 and 1.5) produced non-integer indices, which a
// typed array silently ignores on write and returns `undefined` for on read.
// That NaN flowed into albedoRGBA and every byte coerced to 0 — concreteFloor
// and paintedMetal rendered pure black, with a clean build and no console error.
// Nothing but a pixel-level assertion catches that class of failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/render/textures.js';

// 256 not 64: several generators author lattices for 512/1024, and below ~128
// every octave falls past the Nyquist guard. That degeneracy is now handled
// (see `stack`), but testing at a realistic size exercises the real code path.
const SIZE = 256;

const GENERATORS = {
  concreteFloor: (s) => T.concreteFloor(7, s),
  concreteWall: (s) => T.concreteWall(7, s),
  asphalt: (s) => T.asphalt(7, s, 0),
  asphaltLane: (s) => T.asphalt(7, s, 1),
  paintedMetal: (s) => T.paintedMetal(7, s),
  corrugated: (s) => T.corrugated(7, s),
  rustedSteel: (s) => T.rustedSteel(7, s),
  brick: (s) => T.brick(7, s),
  plaster: (s) => T.plaster(7, s),
  canvas: (s) => T.canvas(7, s),
  wood: (s) => T.wood(7, s),
  chainlink: (s) => T.chainlink(7, s),
  glass: (s) => T.glass(7, s),
  rubber: (s) => T.rubber(7, s),
  gravel: (s) => T.gravel(7, s),
  tile: (s) => T.tile(7, s),
};

const meanOf = (a, off, stride = 4) => {
  let s = 0, n = 0;
  for (let i = off; i < a.length; i += stride) { s += a[i]; n++; }
  return s / n;
};

for (const [name, gen] of Object.entries(GENERATORS)) {
  test(`${name}: albedo is non-degenerate`, () => {
    const g = gen(SIZE);
    assert.equal(g.albedo.length, SIZE * SIZE * 4, 'albedo buffer size');

    // The exact failure mode: all-zero RGB with valid alpha.
    let nonZeroRGB = 0, min = 255, max = 0;
    for (let i = 0; i < g.albedo.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const v = g.albedo[i + k];
        if (v !== 0) nonZeroRGB++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    assert.ok(nonZeroRGB > 0, `${name} albedo RGB is entirely zero (NaN coercion?)`);
    // A real material has tonal range; a flat fill means the noise collapsed.
    assert.ok(max - min > 4, `${name} albedo has no tonal range (min=${min} max=${max})`);
    // Guard against an implausibly black surface sneaking back in.
    assert.ok(meanOf(g.albedo, 0) > 8, `${name} albedo mean too dark (${meanOf(g.albedo, 0).toFixed(1)})`);
  });

  test(`${name}: normal + ORM are well-formed`, () => {
    const g = gen(SIZE);
    assert.equal(g.normal.length, SIZE * SIZE * 4);
    assert.equal(g.orm.length, SIZE * SIZE * 4);

    // Tangent-space normals must point outward: B (z) is encoded 0.5..1 -> >=128.
    let badZ = 0;
    for (let i = 2; i < g.normal.length; i += 4) if (g.normal[i] < 120) badZ++;
    assert.equal(badZ, 0, `${name} has inward-facing normal texels`);

    // Occlusion must not be crushed to black, and roughness must vary.
    assert.ok(meanOf(g.orm, 0) > 60, `${name} AO implausibly dark`);
    let rMin = 255, rMax = 0;
    for (let i = 1; i < g.orm.length; i += 4) {
      if (g.orm[i] < rMin) rMin = g.orm[i];
      if (g.orm[i] > rMax) rMax = g.orm[i];
    }
    assert.ok(rMax - rMin > 2, `${name} roughness is uniform — the "CG plastic" tell`);
  });
}

// Direct regression on the root cause, independent of any material.
test('noise fields tolerate fractional lattice periods', () => {
  for (const p of [1, 1.5, 2, 2.5, 3, 4.7, 6]) {
    for (const f of [T.fbm, T.ridge]) {
      const a = f(32, p, p, 7, 4, 0.55);
      let nan = 0;
      for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) nan++;
      assert.equal(nan, 0, `${f.name} produced NaN at period ${p}`);
    }
  }
});

test('worley tolerates fractional cell counts', () => {
  for (const p of [2.5, 4, 7.3]) {
    const a = T.worley(32, p, p, 7);
    let nan = 0;
    for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) nan++;
    assert.equal(nan, 0, `worley produced NaN at ${p}`);
  }
});

test('encodeSRGB matches the standard curve at known points', () => {
  assert.ok(Math.abs(T.encodeSRGB(0) - 0) < 1e-6);
  assert.ok(Math.abs(T.encodeSRGB(1) - 1) < 1e-6);
  // 0.18 mid-grey encodes to ~0.4613
  assert.ok(Math.abs(T.encodeSRGB(0.18) - 0.4613) < 0.002, 'mid-grey encode');
});
