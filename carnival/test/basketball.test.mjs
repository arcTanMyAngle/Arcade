// Level 5 Basketball — arc closed form, sphere↔torus rim, spin friction ("shooter's roll"),
// restitution energy, determinism. Drives the pure solvers from physics.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, integrate, sphereTorus, resolveBallContact, G } from '../src/core/physics.js';

const near = (a, b, eps = 1e-2) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);
const ball = (p, v, w) => ({ p: { ...p }, v: { ...v }, w: { ...w }, r: 0.12, m: 0.62 });

test('shot apex/range match closed-form ballistics (drag off)', () => {
  const g = -G.y, v0 = 9, ang = 0.9;                       // steep free-throw arc
  const vx = v0 * Math.cos(ang), vy = v0 * Math.sin(ang);
  const p = v3(0, 2, 0), v = v3(0, vy, -vx), dt = 1 / 60;
  let apex = 0;
  for (let i = 0; i < 400; i++) { integrate(p, v, G, dt); apex = Math.max(apex, p.y); if (v.y < 0 && p.y < 2) break; }
  near(apex, 2 + (vy * vy) / (2 * g), 0.12); // semi-implicit Euler within ~half a step
});

test('sphereTorus: contacts the tube, clears when far, null through the hole', () => {
  const T = { cx: 0, cy: 3.05, cz: -5, Rr: 0.23, Tr: 0.02 };
  assert.ok(sphereTorus({ x: 0.34, y: 3.05, z: -5 }, 0.12, T));      // just outside the ring -> tube contact
  assert.equal(sphereTorus({ x: 0, y: 3.6, z: -5 }, 0.12, T), null); // well above -> clear
  assert.equal(sphereTorus({ x: 0, y: 3.05, z: -5 }, 0.12, T), null);// dead-center over hole -> clear
});

test('shooter\'s roll: backspin converts to tangential velocity on contact', () => {
  // ball dropping onto the floor with backspin (ω about -z): the contact surface moves -x, so
  // Coulomb friction kicks the ball +x — the same mechanism that walks a rim clip toward center.
  const b = ball({ x: 0, y: 0.12, z: 0 }, { x: 0, y: -3, z: 0 }, { x: 0, y: 0, z: -40 });
  resolveBallContact(b, { x: 0, y: 1, z: 0 }, 0.001, 0.7, 0.5);
  assert.ok(b.v.x > 0.05, `spin did not impart tangential velocity (v.x ${b.v.x})`);
  assert.ok(b.v.y > 0, 'ball did not bounce');
});

test('restitution: bounce off the floor never gains normal speed', () => {
  const b = ball({ x: 0, y: 0.12, z: 0 }, { x: 1, y: -4, z: 0 }, { x: 0, y: 0, z: 20 });
  const down = -b.v.y;
  resolveBallContact(b, { x: 0, y: 1, z: 0 }, 0.001, 0.6, 0.5);
  assert.ok(b.v.y <= down + 1e-6, `gained energy: up ${b.v.y} vs down ${down}`);
});

test('deterministic: identical shot -> identical rim-clip path', () => {
  const T = { cx: 0, cy: 3.05, cz: -5, Rr: 0.23, Tr: 0.02 };
  const run = () => {
    const b = ball({ x: 0, y: 2, z: 0 }, { x: 0, y: 6.4, z: -8 }, { x: 40, y: 0, z: 0 });
    for (let i = 0; i < 220; i++) {
      integrate(b.p, b.v, G, 1 / 60);
      const h = sphereTorus(b.p, b.r, T); if (h) resolveBallContact(b, h.n, h.pen, 0.7, 0.5);
      if (b.p.y < b.r) resolveBallContact(b, { x: 0, y: 1, z: 0 }, b.r - b.p.y, 0.6, 0.5);
    }
    return [b.p.x, b.p.y, b.p.z, b.v.x, b.v.y, b.v.z].map((n) => n.toFixed(6)).join(',');
  };
  assert.equal(run(), run());
});
