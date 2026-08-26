// Scalar/curve helpers shared by sim + procedural asset gen. Zero imports.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => { const t = clamp01(invLerp(e0, e1, x)); return t * t * (3 - 2 * t); };
export const smootherstep = (e0, e1, x) => { const t = clamp01(invLerp(e0, e1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// Frame-rate-independent exponential approach. `rate` = fraction closed per second.
// Standard damp: naive lerp(a,b,rate*dt) changes behaviour with dt; this doesn't.
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

// Critically-damped spring toward target. Returns [pos, vel]. Used by weapon sway,
// camera recoil recovery, ADS transitions — anything that must settle without overshoot.
export function springDamp(pos, vel, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega, dtoo = dt * oo;
  const det = 1 / (f + dt * dtoo);
  const nv = (vel + dtoo * (target - pos)) * det;
  return [(f * pos + dt * vel + dtoo * dt * target) * det, nv];
}

// Shortest signed angular difference, radians, wrapped to [-PI, PI].
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Move `cur` toward `tgt` by at most `maxDelta` — for hard-capped turn rates.
export const moveToward = (cur, tgt, maxDelta) => {
  const d = tgt - cur;
  return Math.abs(d) <= maxDelta ? tgt : cur + Math.sign(d) * maxDelta;
};
