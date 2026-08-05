// Weapon tuning tables. OWNED BY: weapons agent.
//
// Everything a designer would touch lives here so the sim code stays readable.
// Units: metres, seconds, radians — EXCEPT names ending in `Deg`, and `VM_FOV`
// which is degrees because that is what THREE.PerspectiveCamera.fov wants.
//
// Nothing here is stochastic. The recoil pattern is a fixed authored sequence;
// the only random terms are a tiny per-shot jitter and the spread cone sample,
// both drawn from a seeded stream owned by index.js.
//
// Reference frame for poses: camera-local, -Z forward, +X right, +Y up, and
// authored at VM_FOV so the framing is independent of the world FOV.

import { DEG } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// BP-15 — 5.56 AR-pattern carbine. The one weapon, tuned hard.
// ---------------------------------------------------------------------------
export const W = {
  name: 'BP-15',
  capacity: 30,
  reserveMax: 210,
  auto: true,

  // 750 rpm -> 0.08 s between shots. The cooldown carries its remainder across
  // ticks (see index.js) so the rate is exact, not quantised to the 7.8 ms tick.
  rpm: 750,
  get shotDt() { return 60 / this.rpm; },

  // ---- ballistics ----
  damage: 33,            // at/below falloffStart. 3 hits + a 4th under falloff.
  damageMin: 21,         // at/beyond falloffEnd — 5 hits at range, never 6.
  falloffStart: 24,      // m. Longer than any sightline in the courtyard blockout.
  falloffEnd: 52,        // m
  headMult: 1.5,
  limbMult: 0.9,
  maxDist: 260,          // m — trace length. Beyond this the round is "gone".

  // Penetration budget in CONCRETE-EQUIVALENT metres (see PEN for the per-material
  // exchange rate). 0.16 punches a 12 cm concrete slab with ~25% budget left and
  // dies on anything thicker — the level's 1.2 m walls are hard cover, by design.
  penPower: 0.16,
  penSurfaces: 2,        // max surfaces traversed before the round is spent
  penDamageMul: 0.62,    // multiplicative per surface, ON TOP of the budget ratio
  penProbe: 0.55,        // m — how far ahead we look for the exit face. Anything
                         // thicker than this is unpenetrable regardless of material.

  drawT: 0.55,
  holsterT: 0.40,
  inspectT: 2.40,        // V key. Pure flavour; cancelled by anything.
};

// Cost per metre of travel, in concrete-equivalents. Keyed by the material-name
// string `level.raycast` returns in `hit.mat`. Unknown surfaces fall back to
// 'concrete' (1.0), i.e. the conservative "you probably can't shoot through it".
export const PEN = {
  concrete: 1.0, concreteWall: 1.0, concreteFloor: 1.0, asphalt: 1.2,
  brick: 0.85, plaster: 0.18, drywall: 0.18, wood: 0.35, plywood: 0.30,
  metal: 2.6, paintedMetal: 2.6, steel: 3.4, rust: 2.2,
  glass: 0.08, sandbag: 0.9, dirt: 0.7, foliage: 0.05,
  _default: 1.0,
};

// ---------------------------------------------------------------------------
// Reload state machine. Each entry is [time, stageName]; `credit` is the stage
// at which ammo actually moves from reserve into the mag, `done` ends it.
//
// Tactical keeps the chambered round, so the mag ends on capacity+1 and the bolt
// never has to be cycled — it is 0.6 s faster and that is the whole reason to
// reload early. Empty must run the bolt, which is the extra 'charge' stage.
// ---------------------------------------------------------------------------
export const RELOAD = {
  tac: {
    stages: [[0.00, 'magout'], [0.34, 'magdrop'], [0.86, 'magin'], [1.12, 'slap']],
    credit: 0.86,
    done: 1.95,
  },
  empty: {
    stages: [[0.00, 'magout'], [0.36, 'magdrop'], [0.92, 'magin'], [1.20, 'slap'], [1.62, 'charge']],
    credit: 0.92,        // mag seated; the +1 chambered round lands at 'charge'
    chamber: 1.62,
    done: 2.55,
  },
};

// ---------------------------------------------------------------------------
// Spread — cone HALF-angle, radians. `state.spreadDeg` exposes the live value in
// degrees so the HUD can size a dynamic crosshair off the truth, not a guess.
//
// Terms compose as:  (base + move + air) * crouchMul  + bloom
// ---------------------------------------------------------------------------
export const SPREAD = {
  hipBase: 1.90 * DEG,   // ~1 m group at 30 m standing still. Hipfire is a panic option.
  adsBase: 0.15 * DEG,   // 8 cm at 30 m — tight enough that ADS misses are the player's fault.
  moveMax: 1.70 * DEG,   // additive, at full tac-sprint speed
  moveRef: 8.1,          // m/s that saturates moveMax. Matches SPEED.tacSprint.
  moveAdsMul: 0.35,      // shouldered weapon tracks much better while walking
  air: 3.10 * DEG,       // jump-shooting is punished hard, as it should be
  airAdsMul: 0.60,
  crouchMul: 0.72,       // multiplicative — crouch helps hip and ADS alike

  // Bloom: per-shot growth, held, then recovered. Classic CoD/CS curve — it is
  // what makes tapping strictly better than spraying at range.
  bloomHip: 0.42 * DEG,
  bloomAds: 0.11 * DEG,
  bloomCapHip: 2.90 * DEG,
  bloomCapAds: 0.80 * DEG,
  bloomHold: 0.10,       // s of no-fire before recovery starts
  bloomRecover: 5.5,     // exponential rate, 1/s -> ~0.55 s back to baseline from cap
};

// ---------------------------------------------------------------------------
// Aim recoil — the authored spray pattern, [yawDeg, pitchDeg] PER SHOT, indexed
// by shots fired since the magazine started (not since the trigger was pulled,
// so the pattern is learnable across a whole mag, CoD-style). Held at the last
// entry if a tactical reload leaves you past index 29.
//
// Shape: 8 shots nearly vertical, hard drift LEFT through shot 13, sweep RIGHT
// to shot 20, then a shallower left-right zigzag as the climb decays.
//
// GAIN: the authored table was drawn at a readable-on-paper scale; PGAIN/YGAIN
// scale it to the values that actually matter in-game — ~15 deg of total climb
// over 30 rounds (a full mag walks off a chest at 30 m) and a +-3.5 deg
// horizontal walk (wide enough to have to counter, narrow enough to memorise).
// ---------------------------------------------------------------------------
const PGAIN = 1.75, YGAIN = 1.60;
export const PATTERN = [
  [ 0.00, 0.62], [ 0.10, 0.58], [-0.08, 0.55], [ 0.14, 0.52], [-0.16, 0.50],
  [ 0.22, 0.47], [-0.27, 0.45], [-0.34, 0.42], [-0.43, 0.39], [-0.49, 0.36],
  [-0.45, 0.33], [-0.31, 0.30], [-0.11, 0.28], [ 0.17, 0.26], [ 0.40, 0.24],
  [ 0.56, 0.22], [ 0.63, 0.21], [ 0.58, 0.20], [ 0.46, 0.19], [ 0.28, 0.18],
  [ 0.06, 0.17], [-0.19, 0.16], [-0.38, 0.16], [-0.50, 0.15], [-0.54, 0.15],
  [-0.46, 0.14], [-0.28, 0.14], [-0.06, 0.13], [ 0.16, 0.13], [ 0.34, 0.12],
].map(([y, p]) => [y * YGAIN * DEG, p * PGAIN * DEG]);

export const RECOIL = {
  adsMul: 0.72,          // aiming tames the pattern, it does not remove it
  crouchMul: 0.88,
  jitterYaw: 0.06 * DEG, // deterministic, from the seeded stream. Just enough that
  jitterPitch: 0.04 * DEG, // two identical sprays aren't pixel-identical.

  // AIM recoil: the part that actually moves the bore. After `recoverHold` s
  // without firing it walks back, but only `recoverFrac` of the way — the rest
  // is permanent displacement you have to pull down yourself. That residual is
  // the difference between a weapon with a pattern and one with a spring.
  recoverFrac: 0.62,
  recoverRate: 9.0,      // 1/s
  recoverHold: 0.09,

  // PUNCH: pure view snap, fully recovers. Applied to the camera AND to the bore
  // (the crosshair must never lie), springs back to exactly zero.
  punchPitch: 0.42 * DEG,
  punchYaw: 0.16 * DEG,
  punchOmega: 26,        // critically damped -> settles in ~0.15 s, no bounce
  punchAdsMul: 0.55,

  // ---- visual (viewmodel) kick — cosmetic, does not touch the bore ----
  kickBack: 0.026,       // m along +Z (toward the shooter)
  kickUp: 0.0085,        // m
  kickPitch: 3.6 * DEG,  // muzzle climb of the MODEL, not the aim
  kickYaw: 1.05 * DEG,
  kickRoll: 1.8 * DEG,
  kickAdsMul: 0.46,      // ADS is braced — much less viewmodel throw
  omega: 24,             // springback stiffness
  boltBack: 0.030,       // m of bolt-carrier travel, springs back at 2x omega
};

// ---------------------------------------------------------------------------
// Viewmodel projection. The viewmodel renders in its OWN pass (render agent) so
// the weapon keeps a constant apparent size while the world FOV swings from 80
// to 58, and can never clip into level geometry.
//
// PINNED CROSS-AGENT CONTRACT — these four values are the pass's configuration.
// VM_FOV is in DEGREES (THREE.PerspectiveCamera.fov convention).
// ---------------------------------------------------------------------------
export const VM_FOV = 66;
export const VM_NEAR = 0.01;
export const VM_FAR = 12;
export const VM_LAYER = 2;
export const VM_HALF_TAN = Math.tan(VM_FOV * 0.5 * DEG);   // 0.6494

// ---------------------------------------------------------------------------
// Poses, camera-local. `ads` has NO position: it is SOLVED at build time from
// the optic's measured local position so the reticle lands exactly on screen
// centre. Authoring an ADS offset by hand is how you get a sight that sits two
// pixels off the crosshair and feels subtly wrong forever.
// ---------------------------------------------------------------------------
export const POSE = {
  hip:      { p: [ 0.098, -0.092, -0.150], r: [-0.012, -0.055,  0.034] },
  adsRot:   [0, 0, 0],            // perfectly square to the screen; p is solved
  adsDist:  0.205,                // eye -> optic rear lens; keeps housing out of target picture.
  sprint:   { p: [ 0.094, -0.138, -0.030], r: [-0.430, -0.520,  0.470] },
  draw:     { p: [ 0.165, -0.330,  0.020], r: [-0.980,  0.470,  0.740] },
  lowReady: { p: [ 0.100, -0.152, -0.070], r: [-0.300, -0.100,  0.120] },
  reload:   { p: [ 0.086, -0.126, -0.104], r: [-0.150, -0.300,  0.140] },
  inspect:  { p: [ 0.052, -0.112, -0.126], r: [ 0.080, -0.900,  0.260] },
};

export const ANIM = {
  // ADS is a fixed-duration eased blend, not an exponential damp: an exponential
  // never actually reaches 1, and "the sight nearly centres" is worse than useless.
  adsInT: 0.205,         // s. Inside the 180-250 ms band an AR should live in.
  adsOutT: 0.165,        // coming down is always faster than going up

  swayGain: 0.0105,      // metres of positional lag per rad/s of look velocity
  swayMax: 0.052,        // clamp, m — beyond this the gun leaves the screen
  swayOmega: 13,         // spring rate of the catch-up. Lower = floatier.
  swayRotGain: 0.052,    // radians of counter-rotation per rad/s
  swayAdsMul: 0.28,      // shouldered: the gun barely lags the view

  bobPos: 0.020,         // m at bob amplitude 1
  bobRot: 0.030,         // rad at bob amplitude 1
  bobAdsMul: 0.22,
  bobLag: 0.62,          // viewmodel bob phase lag, radians. The gun trails the
                         // head instead of being welded to it — this is most of
                         // what makes a viewmodel read as a held object.
  breathMul: 2.4,        // viewmodel breathing sway relative to the view's
  landGain: 0.055,       // m of viewmodel dip per unit of the player's landDip
  sprintOmega: 11,       // blend rate into/out of the sprint pose
  poseOmega: 13,         // blend rate for reload/inspect poses
};

// Breathing frequencies. These MUST match BREATH.freqA/freqB in
// player/tuning.js: the bore axis rides the same sway the camera does, which is
// the entire reason hold-breath is worth pressing. Duplicated rather than
// imported because subsystems do not import each other (see CLAUDE.md).
export const BREATH_F = { a: 0.55, b: 0.37 };
