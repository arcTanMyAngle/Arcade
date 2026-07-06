// Level 6 Skee-Ball — ramp roll energy, lip-launch parabola, determinism, monotonic reach.
// Replicates the game's roll formula (no physics.js roll fn) + uses integrate for the flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, integrate, G } from '../src/core/physics.js';

const near = (a, b, eps = 1e-2) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);
const g = -G.y, Z_FLAT_END = -2.0, Z_LIP = -2.6, bR = 0.05, dt = 1 / 60;

// ramp-only roll from Z_FLAT_END at along-lane speed u0 -> horizontal speed at the lip
function rampRoll(u0, thDeg, muR) {
  const th = thDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const aF = (g * sn + muR * g * cs) * cs;                 // horizontal decel on the ramp
  let z = Z_FLAT_END, f = u0;
  for (let i = 0; i < 4000 && z > Z_LIP && f > 0; i++) { f = Math.max(0, f - aF * dt); z -= f * dt; }
  return { f, aF };
}

test('ramp roll decel matches closed form f² = u0² − 2·a·Δx', () => {
  const u0 = 6, { f, aF } = rampRoll(u0, 32, 0.028);
  const dx = Z_FLAT_END - Z_LIP;                            // 0.6 m of ramp run
  near(f, Math.sqrt(u0 * u0 - 2 * aF * dx), 0.12); // discrete step overshoots the lip by ≤ f·dt
});

test('steeper / higher-friction ramp bleeds more speed at the lip', () => {
  assert.ok(rampRoll(6, 26, 0.020).f > rampRoll(6, 38, 0.040).f);
});

test('lip-launch parabola range matches closed form 2·f²·tanθ/g', () => {
  const th = 30 * Math.PI / 180, f = 4.5, y0 = 0.3;
  const p = v3(0, y0, Z_LIP), v = v3(0, f * Math.tan(th), -f);
  let dz = 0;
  for (let i = 0; i < 600; i++) { const py = p.y; integrate(p, v, G, dt); if (py >= y0 && p.y < y0 && v.y < 0) { dz = Z_LIP - p.z; break; } }
  near(dz, 2 * f * f * Math.tan(th) / g, 0.12); // semi-implicit range within ~f·dt
});

// full launch: roll flat+ramp, launch off lip, fly to the floor -> landing z (deeper = more reach)
function landingZ(v0, thDeg = 30, muR = 0.028, muF = 0.02) {
  const th = thDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), tanT = Math.tan(th);
  let z = -0.1, f = v0;
  for (let i = 0; i < 4000 && z > Z_LIP && f > 0.05; i++) {
    const onRamp = z <= Z_FLAT_END, aF = onRamp ? (g * sn + muR * g * cs) * cs : muF * g;
    f = Math.max(0, f - aF * dt); z -= f * dt;
  }
  if (f <= 0.05) return z;                                  // stalled short
  const p = v3(0, bR + (Z_FLAT_END - Z_LIP) * tanT, z), vv = v3(0, f * tanT, -f);
  for (let i = 0; i < 800; i++) { integrate(p, vv, G, dt); if (p.y < bR) break; }
  return p.z;
}

test('deterministic + monotonic: harder roll lands deeper, identical across runs', () => {
  assert.equal(landingZ(6.5).toFixed(6), landingZ(6.5).toFixed(6));
  assert.ok(landingZ(7.5) < landingZ(5.5), 'more launch speed did not reach a deeper ring');
});
