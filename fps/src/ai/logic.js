// Pure AI decision logic — zero THREE, zero DOM, node-testable. index.js supplies
// world queries (LOS, distance, cover arrival) as a plain `input` object each tick;
// everything here is arithmetic on that object + the injected seeded rng.
//
// Capsule dims MUST match nav.js's AGENT_R/AGENT_H (that file was authored against
// these exact numbers) and the visible body built in body.js.
export const AGENT_R = 0.36;
export const AGENT_H = 1.78;

const DEG = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
const jit = (rng, c, frac) => c * (1 + (rng() * 2 - 1) * frac);

// ---------------------------------------------------------------------------
// Tuning — reasoning inline. Kept in one object so behaviour is auditable/testable.
// ---------------------------------------------------------------------------
export const CFG = {
  engageRange: 40,      // m — will not open fire beyond this even with LOS
  loseRange: 46,         // hysteresis: stays engaged until LOS/range fails past this
  reactionMin: 0.22, reactionMax: 0.55,   // s — "sees you" -> "acts on it"
  peekMin: 0.55, peekMax: 1.05,           // s exposed before ducking regardless of outcome
  shootMin: 0.7, shootMax: 1.5,           // s spent actively firing once LOS is confirmed
  duckMin: 0.4, duckMax: 0.85,            // s hidden between exposures
  fireIntervalBase: 0.17, fireIntervalJitter: 0.4,   // s between shots while in 'shoot'
  suppressT: 1.05,        // s forced to cover after taking a hit or a near-miss
  suppressTMiss: 0.55,    // near-miss (weapon:impact nearby) — shorter than an actual hit
  losCheckInterval: 0.08, // s between LOS raycasts per agent (throttled, not per-tick)
  coverSearchR: 16,       // m radius to search for a cover node
  moveSpeed: 3.3,         // m/s, deliberately under the player's 4.4 walk
  turnRate: 6.0,          // rad/s facing turn
  peekLean: 0.85,         // spring omega for the lean-out-from-cover offset
};

// Zone thresholds are fractions of AGENT_H measured from the feet (t=0) to the
// crown (t=1). Matches the capsule used for both rendering and hit-testing.
export function zoneForT(t) {
  if (t > 0.83) return 'head';
  if (t > 0.40) return 'torso';
  return 'limb';
}
export const ZONE_MULT = { head: 2.6, torso: 1.0, limb: 0.55 };

// Damage the PLAYER's weapon does per hit. weapon:fire carries no damage figure
// (only pos/dir/weapon/ammo) and weapons/tuning.js is out of bounds across the
// subsystem boundary, so this is AI's own best-effort table keyed off the
// `weapon` name string, applied on top of the zone multiplier above. If exact
// parity with the player's real damage numbers ever matters, the fix belongs on
// the weapons side: add a `dmg` field to the weapon:fire (or a dedicated
// weapon:hit) payload.
export const INCOMING_DMG = { rifle: 30, smg: 22, pistol: 18, default: 26 };

// Damage AI deals to the player per shot (own table for the same reason, applied
// symmetrically via player.damage()).
export const OUTGOING_DMG = { base: 9, jitter: 4 };

// Aim cone half-angle: tighter close, looser far — this alone is most of what
// keeps AI from reading as an instant-hitscan aimbot, since it can geometrically
// miss a human-width target at range.
export function aimSpreadRad(rng, dist, engageRange) {
  const f = clamp01(dist / engageRange);
  const base = (1.0 + 2.2 * f) * DEG;
  return base * (0.55 + rng() * 0.9);
}

// ---------------------------------------------------------------------------
// Ray vs. vertical capsule (infinite-cylinder body + small cap allowance).
// Pure arithmetic so both "player shoots AI" and "AI shoots player" hit-tests
// (and their unit tests) share one implementation. Returns {dist, y} of the
// nearest surface point along the ray, or null.
// ---------------------------------------------------------------------------
export function rayVsVerticalCapsule(ox, oy, oz, dx, dy, dz, cx, cy0, cz, h, r, maxDist) {
  const ex = ox - cx, ez = oz - cz;
  const a = dx * dx + dz * dz;
  const capLo = cy0 - r * 0.3, capHi = cy0 + h + r * 0.3;
  if (a < 1e-9) {
    // Ray is (near-)vertical: only the horizontal offset matters.
    if (ex * ex + ez * ez > r * r) return null;
    if (Math.abs(dy) < 1e-9) return null;
    const t0 = (capLo - oy) / dy, t1 = (capHi - oy) / dy;
    const tMin = Math.min(t0, t1), tMax = Math.max(t0, t1);
    const t = tMin >= 0 ? tMin : tMax;
    if (t < 0 || t > maxDist) return null;
    return { dist: t, y: clamp(oy + dy * t, cy0, cy0 + h) };
  }
  const b = 2 * (ex * dx + ez * dz);
  const c = ex * ex + ez * ez - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxDist) return null;
  const y = oy + dy * t;
  if (y < capLo || y > capHi) return null;
  return { dist: t, y: clamp(y, cy0, cy0 + h) };
}

// ---------------------------------------------------------------------------
// Agent FSM. `a` is a plain mutable record; `input` is world facts gathered by
// index.js this tick. Fully deterministic given (a, input, dt, rng) — no
// wall-clock, no Math.random. States: idle -> alert -> seek -> peek <-> shoot
// -> duck -> peek ... , with suppressed interrupting from anywhere alive, and
// dead terminal.
// ---------------------------------------------------------------------------
export function createAgentState(id, rng) {
  return {
    id, alive: true, health: 100, maxHealth: 100,
    state: 'idle', timer: 0, fireCd: 0,
    coverIdx: -1, wantRepick: true,
    wantFire: false, deathT: 0,
    leanSign: rng() < 0.5 ? -1 : 1,     // which side this agent peeks from, fixed at spawn
    fallSeed: rng(),                     // deterministic death-collapse direction
  };
}

export function stepFSM(a, input, dt, rng) {
  a.wantFire = false;
  if (!a.alive) { a.deathT += dt; return a; }
  if (input.justDied) { a.alive = false; a.state = 'dead'; a.deathT = 0; return a; }

  a.fireCd = Math.max(0, a.fireCd - dt);

  if ((input.justHit || input.justSuppressed) && a.state !== 'suppressed') {
    a.state = 'suppressed';
    a.timer = jit(rng, input.justHit ? CFG.suppressT : CFG.suppressTMiss, 0.3);
    a.wantRepick = true;
    return a;
  }

  switch (a.state) {
    case 'idle':
      if (input.hasLOS && input.dist <= CFG.engageRange) {
        a.state = 'alert'; a.timer = lerp(CFG.reactionMin, CFG.reactionMax, rng());
      }
      break;
    case 'alert':
      if (!input.hasLOS) { a.state = 'idle'; break; }
      a.timer -= dt;
      if (a.timer <= 0) { a.state = 'seek'; a.wantRepick = true; }
      break;
    case 'seek':
      if (input.atCover) { a.state = 'peek'; a.timer = lerp(CFG.peekMin, CFG.peekMax, rng()); }
      break;
    case 'peek':
      a.timer -= dt;
      if (input.hasLOS && input.dist <= CFG.engageRange) {
        a.state = 'shoot'; a.timer = lerp(CFG.shootMin, CFG.shootMax, rng()); a.fireCd = 0;
      } else if (a.timer <= 0) {
        a.state = input.dist <= CFG.loseRange ? 'duck' : 'idle';
        a.timer = lerp(CFG.duckMin, CFG.duckMax, rng());
      }
      break;
    case 'shoot':
      a.timer -= dt;
      if (!input.hasLOS || input.dist > CFG.loseRange) {
        a.state = 'duck'; a.timer = lerp(CFG.duckMin, CFG.duckMax, rng()); break;
      }
      if (a.fireCd <= 0) { a.wantFire = true; a.fireCd = jit(rng, CFG.fireIntervalBase, CFG.fireIntervalJitter); }
      if (a.timer <= 0) { a.state = 'duck'; a.timer = lerp(CFG.duckMin, CFG.duckMax, rng()); }
      break;
    case 'duck':
      a.timer -= dt;
      if (a.timer <= 0) { a.state = 'peek'; a.timer = lerp(CFG.peekMin, CFG.peekMax, rng()); }
      break;
    case 'suppressed':
      a.timer -= dt;
      if (a.timer <= 0) {
        a.state = 'duck'; a.timer = lerp(CFG.duckMin * 0.6, CFG.duckMax * 0.6, rng()); a.wantRepick = true;
      }
      break;
    default:
      a.state = 'idle';
  }
  return a;
}

// Exposed = true while the agent should be leaned out and eligible to be shot
// "in the open" for camera/FX purposes; suppression, ducking and seeking all hide it.
export const EXPOSED_STATES = new Set(['peek', 'shoot']);
export const isExposed = (a) => EXPOSED_STATES.has(a.state);
