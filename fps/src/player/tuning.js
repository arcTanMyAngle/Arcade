// Player feel constants. OWNED BY: movement/feel agent.
//
// Every number here is a deliberate choice with a stated reason. Units are SI:
// metres, seconds, m/s, m/s^2, radians (unless suffixed DEG). Nothing in this
// file may be read from the DOM, wall-clock, or Math.random — it is pure data
// consumed by the fixed 128 Hz sim.
//
// Reference frame: Modern-Warfare-family shooters. Their published/derived
// values are inches-per-second at 100 ups walk; converted and rounded to the
// metric values below, then hand-tuned against this level's 1.15 m cover boxes
// and 3.2 m walkway so the geometry reads at the right scale.

import { DEG } from '../core/mathx.js';

// ---- locomotion --------------------------------------------------------
export const SPEED = {
  walk: 4.4,        // baseline. 1.15 m cover box passes the eye in ~0.5 s — reads "brisk", not floaty.
  sprint: 6.6,      // 1.50x walk. Enough delta to feel like a gear change without FOV nausea.
  tacSprint: 8.1,   // 1.84x walk. Only after a commitment window (SPRINT.tacDelay); weapon is lowered.
  crouch: 2.3,      // 0.52x walk. Slow enough that crouch-walking is a real trade, not a free stealth mode.
  ads: 2.9,         // 0.66x walk. CoD's ADS tax; keeps peekers from strafing at full speed.
  air: 4.6,         // air accel target cap. Slightly above walk so a running jump isn't clipped,
                    // far below sprint so you cannot air-accelerate your way to Quake speeds.
};

// Ground accel is intentionally enormous (62 * maxSpeed => ~272 m/s^2 at walk):
// combined with high friction this yields sub-2-tick starts and ~0.1 s stops,
// i.e. "no ice". Air accel is ~1/6 of that: enough to adjust a jump, not to strafe-jump.
export const ACCEL = { ground: 62, air: 11 };

// Friction is applied BEFORE acceleration (Quake/Source order). This matters:
// accel-then-friction leaves terminal speed ~10% under the intended value
// (4.4 -> 3.97), friction-then-accel lands exactly on SPEED.walk.
export const FRICTION = {
  ground: 12.5,     // e-fold in 80 ms
  air: 0.35,        // near-zero: momentum is preserved through a jump on purpose
  stopSpeed: 3.2,   // constant-decel floor. Pure exponential decay asymptotes forever;
                    // this makes the last 3.2 m/s bleed off linearly at 40 m/s^2 => full stop in ~0.105 s.
};

export const GRAVITY = 18.6;   // ~1.9 g. Shorter, snappier arcs than real gravity; the shooter standard.

export const JUMP = {
  v: 5.05,          // apex = v^2/2g = 0.686 m — clears the 0.6 m crate lip, not the 1.15 m cover.
  buffer: 0.12,     // press up to 120 ms before landing still jumps on touchdown (input forgiveness).
  coyote: 0.09,     // 90 ms of jump grace after walking off a ledge. Below perceptual threshold, above tick noise.
};

// ---- capsule -----------------------------------------------------------
export const H = { stand: 1.72, crouch: 1.06 };
export const EYE = { stand: 1.58, crouch: 0.94 };   // eye sits 0.14 m below the head cap
export const RADIUS = 0.34;                          // 0.68 m shoulder width — fits 1.2 m doorways with clearance
export const PITCH_LIMIT = 89 * DEG;

// Max obstacle height walked over without a jump. 0.35 m ~= a kerb + pallet.
// Deliberately below the 0.6 m crate so crates still need a jump or a vault.
export const STEP = { max: 0.35, probeAhead: 0.7 };  // probeAhead in units of RADIUS

// ---- sprint ------------------------------------------------------------
export const SPRINT = {
  tacDelay: 0.55,   // held-sprint time before tac-sprint engages. Long enough that
                    // a corner-to-corner reposition doesn't accidentally lower your weapon.
  fwdIntent: 0.35,  // required forward stick/key component — no sideways sprinting
};

// ---- slide -------------------------------------------------------------
// Signature move. Entry is gated so it cannot be spammed for free distance:
// must be grounded, sprinting, above minSpeed, and off cooldown.
export const SLIDE = {
  minSpeed: 5.0,    // ~0.76 sprint. You must have actually built speed.
  boost: 9.2,       // entry impulse, 1.39x sprint / 1.14x tac-sprint. The "pop" that sells it.
  dur: 0.9,         // hard cap. Matches the friction curve's natural bleed-out.
  fricA: 0.85,      // friction at t=0 — almost frictionless, so the boost is felt
  fricB: 9.0,       // friction at t=dur, ramped as (t/dur)^2 => 9.2 -> ~3.0 m/s over 0.9 s
  exitSpeed: 2.9,   // drop below this and the slide ends early into a crouch-walk
  cooldown: 0.45,   // post-slide lockout. Without it, slide-jump-slide chains gain speed forever.
  steer: 1.9,       // rad/s of velocity-direction steering. Redirects, never adds speed (honest physics).
  airGrace: 0.15,   // slide survives this long off a lip (curb-hop) before cancelling
  dip: 0.20,        // extra camera drop below crouch eye, metres
  roll: 5.5 * DEG,  // camera roll amplitude while sliding
};

// ---- mantle / vault ----------------------------------------------------
// Two-raycast contract: (1) forward ray finds a near-vertical face,
// (2) downward ray behind that face finds the ledge top. A third upward ray
// plus a standing-capsule collide test guarantees we never climb into geometry.
export const MANTLE = {
  minRise: 0.42,    // below this the step-up sweep handles it — no animation needed
  maxRise: 1.85,    // just above the 1.72 m stand height: chest-high pull-up is the ceiling
  reach: 0.62,      // forward probe distance beyond the capsule surface
  landAhead: 0.46,  // how far past the wall face we plant, in metres (> RADIUS so the capsule clears the lip)
  durMin: 0.34,     // low vault (0.42 m) duration
  durMax: 0.62,     // full 1.85 m pull-up duration — slow enough to feel like effort, fast enough to survive a firefight
  riseFrac: 0.62,   // fraction of the animation spent going up before the forward push dominates.
                    // Up-then-over (L path) is what keeps the capsule outside the wall.
  tilt: 7.0 * DEG,  // peak pitch tilt (down) at mid-animation — you look at your hands, then up
  roll: 2.4 * DEG,  // slight roll so it isn't a rigid elevator ride
  exitSpeed: 1.6,   // forward carry on completion so you don't stall on top of the ledge
};

// ---- damage ------------------------------------------------------------
// Thresholds expressed as impact speed; the equivalent fall height is
// h = v^2 / (2 * GRAVITY), i.e. v^2 / 37.2.
export const FALL = {
  safe: 11.5,       // 3.56 m — the walkway (3.2 m) is a free drop by design
  lethal: 25.0,     // 16.8 m — nothing in this level is that high; it exists for the curve's shape
  curve: 1.5,       // >1 keeps low falls cheap and punishes the tail
  max: 100,
};

// ---- camera ------------------------------------------------------------
export const CAM = {
  fov: 80,          // hip FOV
  adsFov: 58,       // ADS FOV
  sprintFov: 3,     // additive on sprint
  tacFov: 6,        // additive on tac-sprint. FOV widening IS the sensation of acceleration.
  fovRate: 9,       // damp rate, s^-1. Runs in sim so it is frame-rate independent.
  adsRate: 16,      // ADS blend rate — ~0.19 s to 95%, matches a light SMG
  stanceRate: 14,   // crouch/stand height blend
  slideStanceRate: 20, // slide drops you faster than a normal crouch

  strafeRoll: 2.3 * DEG,  // camera roll while strafing at full walk speed. Any more reads as drunk.
  strafeRollW: 11,        // spring omega — snappy return so it never lags the input
  leanRoll: 0.55,         // roll per unit lean (lean input is +-0.42 rad => ~13 deg)
  leanOffset: 0.5,        // lateral camera translation per unit lean, metres

  landDipW: 13,     // landing dip spring (critically damped: no bounce)
  landDipK: 4.4,    // dip velocity impulse per unit impact
  landDipScale: 0.16,   // metres of camera drop per unit dip
  landKickK: 0.055, // pitch kick (radians) per unit impact — weapon-independent view kick
  landKickW: 15,
  landMinV: 2.5,    // downward speed below which landing produces no kick at all
  landRefV: 16.0,   // downward speed that produces a full-strength (1.0) kick
};

// Head bob is a 1:2 Lissajous — a true figure-8. The horizontal term completes
// one cycle per STRIDE PAIR, the vertical two (one dip per footfall). Using
// abs(sin) for the vertical instead, as naive implementations do, puts a C1
// corner at every footfall which reads as a visible snap.
export const BOB = {
  x: 0.034,         // metres lateral at amp 1
  y: 0.030,         // metres vertical at amp 1
  roll: 0.9 * DEG,  // roll coupled to the horizontal phase
  ampMax: 1.45,     // speed/walk is allowed past 1 so sprint bobs harder
  crouchScale: 0.55,
  adsScale: 0.35,   // bob is cut to 35% at full ADS — sight picture must stay usable
  rate: 9,          // amplitude damp rate
  stride: { crouch: 1.05, walk: 1.55, sprint: 1.95 },  // metres per footfall; also drives footstep cadence
};

// Idle breathing. Two incommensurate frequencies so the pattern never visibly
// loops. Amplitude is tiny at hip (you should barely notice) and 2.6x at ADS
// where a scope magnifies it — that is what makes hold-breath worth pressing.
export const BREATH = {
  freqA: 0.55,      // Hz, primary (chest)
  freqB: 0.37,      // Hz, secondary (shoulder drift)
  ampHip: 0.0016,   // radians of view sway at hip, stationary
  ampAds: 0.0042,   // radians at full ADS
  moveCut: 1.2,     // m/s above which breathing sway is fully suppressed (bob takes over)
  hold: 5.0,        // seconds of hold-breath available (Sprint key while ADS)
  recover: 4.0,     // seconds to refill from empty
  exhaustAmp: 2.4,  // sway multiplier when the breath meter hits zero
  rate: 7,          // amplitude damp rate
};
