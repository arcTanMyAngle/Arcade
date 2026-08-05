// dsp.js — PURE parameter math for BREACHPOINT audio. Zero imports, zero Web Audio.
//
// Everything that decides *what* to schedule lives here so it is node-testable;
// voices.js / index.js only translate these recipes into an AudioNode graph.
// House rule: all variation comes from a passed `rng` (mulberry32), never Math.random.

export const SPEED_OF_SOUND = 343;        // m/s, dry air ~20 C
export const MAX_VOICES = 24;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

// ---- seeded variation helpers -------------------------------------------
export const jit = (rng, c, frac) => c * (1 + (rng() * 2 - 1) * frac);   // multiplicative ±frac
export const jitA = (rng, c, amt) => c + (rng() * 2 - 1) * amt;          // additive ±amt
export const pick = (rng, arr) => arr[Math.min(arr.length - 1, (rng() * arr.length) | 0)];
export const chance = (rng, p) => rng() < p;

// =========================================================================
// Envelopes
// =========================================================================
// An envelope is {peak, attack, hold, decay}. Wiring uses a LINEAR attack ramp
// (exponential ramps cannot start from 0, and a 0.4 ms attack must be exact —
// that near-instant edge is what makes a gunshot read as a gunshot) then an
// EXPONENTIAL decay, which is how real acoustic energy dissipates.
export const envDuration = (e) => e.attack + (e.hold || 0) + e.decay;

// Mirror of what the AudioParam schedule produces. Tested against the wiring's intent.
export function envValueAt(e, t) {
  const { peak, attack, decay } = e, hold = e.hold || 0;
  if (t <= 0) return 0;
  if (t < attack) return peak * (t / attack);
  if (t < attack + hold) return peak;
  const d = t - attack - hold;
  if (d >= decay) return 0;
  const floor = Math.max(peak * 1e-4, 1e-5);
  return peak * Math.pow(floor / peak, d / decay);   // exponentialRampToValueAtTime
}

// =========================================================================
// Distance & environment
// =========================================================================
export const propagationDelay = (d, c = SPEED_OF_SOUND) => Math.max(0, d) / c;

// Air absorption + geometry HF loss. 20 kHz at the muzzle, ~7.4 kHz @ 50 m,
// ~2.7 kHz @ 100 m, ~1 kHz @ 150 m. This single curve is what makes distant
// gunfire read as "far away" rather than "quiet".
export const airLowpassHz = (d, k = 0.02) => clamp(20000 * Math.exp(-k * Math.max(0, d)), 260, 20000);

// Inverse distance law matching PannerNode's 'inverse' model, so the pure math
// used for scheduling agrees with what the panner does to the gain.
export function distanceGain(d, ref = 4, rolloff = 0.9, max = 400) {
  const dd = clamp(d, 0, max);
  return ref / (ref + rolloff * Math.max(0, dd - ref));
}

export const ZONES = {
  // sendBase/sendFar: wet mix at 0 m and at sendRange m. Indoor is wet immediately.
  outdoor: {
    ir: 'outdoor', sendBase: 0.05, sendFar: 0.62, sendRange: 120,
    tailMul: 1.0, tailGain: 0.30, damp: 1.0, ambGain: 1.0,
  },
  indoor: {
    ir: 'indoor', sendBase: 0.26, sendFar: 0.85, sendRange: 42,
    tailMul: 1.9, tailGain: 0.62, damp: 0.72, ambGain: 0.45,
  },
  tunnel: {
    ir: 'indoor', sendBase: 0.40, sendFar: 0.95, sendRange: 34,
    tailMul: 2.6, tailGain: 0.78, damp: 0.5, ambGain: 0.25,
  },
};
export const zoneOf = (n) => ZONES[n] || ZONES.outdoor;

export function reverbSend(d, zone = 'outdoor') {
  const z = zoneOf(zone);
  return clamp01(z.sendBase + (z.sendFar - z.sendBase) * smoothstep(1, z.sendRange, Math.max(0, d)));
}

// Full propagation packet for one emitter -> listener path.
export function propagation(d, zone = 'outdoor') {
  return {
    dist: Math.max(0, d),
    delay: propagationDelay(d),
    airHz: airLowpassHz(d),
    send: reverbSend(d, zone),
    near: 1 - smoothstep(6, 90, Math.max(0, d)),   // 1 = point blank, 0 = far field
  };
}

// =========================================================================
// Weapon profiles — the four-layer gunshot recipe
// =========================================================================
export const WEAPONS = {
  rifle: {
    crackHz: 1900, crackTilt: 3600, crackDecay: 0.030, crackGain: 1.00,
    bodyF0: 210, bodyF1: 46, bodySweep: 0.055, bodyDecay: 0.135, bodyGain: 0.92,
    subF0: 95, subF1: 33, subDecay: 0.20, subGain: 0.46,
    tailF0: 2600, tailF1: 360, tailQ: 1.4, tailDecay: 0.34, tailGain: 0.34,
    mechT: 0.007, mechT2: 0.046, mechHz: 4200, mechGain: 0.17, ringHz: 1750,
    shellDelay: 0.34,
  },
  ai_rifle: {
    crackHz: 1700, crackTilt: 3100, crackDecay: 0.032, crackGain: 0.86,
    bodyF0: 188, bodyF1: 42, bodySweep: 0.062, bodyDecay: 0.150, bodyGain: 0.84,
    subF0: 88, subF1: 30, subDecay: 0.22, subGain: 0.40,
    tailF0: 2300, tailF1: 330, tailQ: 1.3, tailDecay: 0.40, tailGain: 0.40,
    mechT: 0.008, mechT2: 0.050, mechHz: 3900, mechGain: 0.13, ringHz: 1620,
    shellDelay: 0.36,
  },
  distant: {   // scripted ambient firefight, always far — mostly boom + tail
    crackHz: 1200, crackTilt: 2200, crackDecay: 0.045, crackGain: 0.55,
    bodyF0: 150, bodyF1: 38, bodySweep: 0.08, bodyDecay: 0.20, bodyGain: 0.80,
    subF0: 74, subF1: 28, subDecay: 0.30, subGain: 0.55,
    tailF0: 1400, tailF1: 220, tailQ: 1.1, tailDecay: 0.70, tailGain: 0.62,
    mechT: 0, mechT2: 0, mechHz: 3000, mechGain: 0, ringHz: 1400,
    shellDelay: 0,
  },
};

// The gunshot. Four layers, correct relative timing — a single noise burst is a toy:
//   t+0.0ms   CRACK  shaped noise, 0.4 ms attack, heavily high-passed  (the "snap")
//   t+0.3ms   BODY   pitch-swept sine 210 -> 46 Hz                     (the chest punch)
//   t+0.3ms   SUB    slower, deeper sweep                             (weight)
//   t+3.0ms   TAIL   resonant, downward-sweeping noise                (room response)
//   t+7/46ms  MECH   two metallic bolt clicks + short inharmonic ring (the action)
// Distance rebalances them: the crack dies fastest, the tail grows and lengthens.
export function gunshotParams(rng, opts = {}) {
  const { dist = 0, zone = 'outdoor', profile = 'rifle', gain = 1 } = opts;
  const P = WEAPONS[profile] || WEAPONS.rifle;
  const Z = zoneOf(zone);
  const pr = propagation(dist, zone);
  const near = pr.near, far = 1 - near;

  // Crack loses far more than the body: HF cannot survive 100 m of air.
  const crackG = P.crackGain * (0.10 + 0.90 * near) * gain;
  const bodyG = P.bodyGain * (0.45 + 0.55 * near) * gain;
  const subG = P.subGain * (0.55 + 0.65 * far) * gain;            // sub actually gains with distance
  const tailG = P.tailGain * Z.tailGain / 0.30 * (0.5 + 1.1 * far) * gain;
  const tailDecay = jit(rng, P.tailDecay * Z.tailMul * (1 + 1.7 * far), 0.16);

  return {
    dist: pr.dist, delay: pr.delay, airHz: pr.airHz, send: pr.send, zone,
    crack: {
      hp: clamp(jit(rng, P.crackHz, 0.12) * (0.35 + 0.65 * near), 200, 6000),
      tilt: jit(rng, P.crackTilt, 0.10),
      env: { peak: crackG, attack: 0.0004, hold: 0.0006, decay: jit(rng, P.crackDecay, 0.22) },
    },
    body: {
      f0: jit(rng, P.bodyF0, 0.05), f1: jit(rng, P.bodyF1, 0.07), sweep: jit(rng, P.bodySweep, 0.18),
      env: { peak: bodyG, attack: 0.0015, hold: 0, decay: jit(rng, P.bodyDecay, 0.14) },
    },
    sub: {
      f0: jit(rng, P.subF0, 0.05), f1: jit(rng, P.subF1, 0.06), sweep: 0.09,
      env: { peak: subG, attack: 0.004, hold: 0, decay: jit(rng, P.subDecay, 0.18) },
    },
    tail: {
      t: 0.003, f0: jit(rng, P.tailF0, 0.12) * (0.3 + 0.7 * near), f1: jit(rng, P.tailF1, 0.12),
      q: jit(rng, P.tailQ, 0.2),
      env: { peak: tailG, attack: 0.006, hold: 0, decay: tailDecay },
    },
    // Mechanical layer is inaudible at range — the action noise never carries.
    mech: P.mechGain <= 0 || near < 0.25 ? null : {
      hz: jit(rng, P.mechHz, 0.10), ringHz: jit(rng, P.ringHz, 0.08),
      g: P.mechGain * near * gain,
      t1: jit(rng, P.mechT, 0.25), t2: jit(rng, P.mechT2, 0.14),
    },
    shellDelay: P.shellDelay ? jit(rng, P.shellDelay, 0.22) : 0,
    dur: pr.delay + 0.05 + Math.max(tailDecay, envDuration({ attack: 0.004, decay: P.subDecay * 1.4 })),
  };
}

// =========================================================================
// Surfaces — impacts and footsteps
// =========================================================================
export const SURFACES = {
  concrete: { imp: { lp: 900, thumpHz: 200, thumpDec: 0.10, crackHz: 2800, crackDec: 0.035, g: 0.85 }, debris: 4,
    step: { hz: 1500, q: 0.9, dec: 0.055, body: 130, g: 0.52, scuff: 0.55 } },
  metal:    { imp: { lp: 5200, thumpHz: 330, thumpDec: 0.05, crackHz: 5200, crackDec: 0.028, g: 0.9 }, debris: 2,
    step: { hz: 2600, q: 2.2, dec: 0.070, body: 190, g: 0.60, scuff: 0.35 } },
  glass:    { imp: { lp: 8000, thumpHz: 520, thumpDec: 0.03, crackHz: 6200, crackDec: 0.05, g: 0.8 }, debris: 9,
    step: { hz: 3200, q: 2.6, dec: 0.05, body: 210, g: 0.5, scuff: 0.5 } },
  flesh:    { imp: { lp: 520, thumpHz: 118, thumpDec: 0.085, crackHz: 700, crackDec: 0.045, g: 0.75 }, debris: 0,
    step: { hz: 700, q: 0.8, dec: 0.06, body: 100, g: 0.4, scuff: 0.6 } },
  wood:     { imp: { lp: 1800, thumpHz: 250, thumpDec: 0.075, crackHz: 2200, crackDec: 0.030, g: 0.78 }, debris: 3,
    step: { hz: 1150, q: 1.2, dec: 0.065, body: 155, g: 0.5, scuff: 0.5 } },
  dirt:     { imp: { lp: 620, thumpHz: 150, thumpDec: 0.07, crackHz: 1100, crackDec: 0.04, g: 0.6 }, debris: 5,
    step: { hz: 900, q: 0.7, dec: 0.08, body: 110, g: 0.42, scuff: 0.85 } },
  gravel:   { imp: { lp: 1100, thumpHz: 170, thumpDec: 0.06, crackHz: 3000, crackDec: 0.05, g: 0.65 }, debris: 8,
    step: { hz: 2100, q: 0.6, dec: 0.10, body: 120, g: 0.46, scuff: 1.0 } },
};
export const surfaceOf = (n) => SURFACES[n] || SURFACES.concrete;

// Bullet impact. Surface picks the recipe; metal can throw a pitch-swept ricochet whine.
export function impactParams(rng, opts = {}) {
  const { surface = 'concrete', dist = 0, zone = 'outdoor', gain = 1 } = opts;
  const S = surfaceOf(surface), I = S.imp;
  const pr = propagation(dist, zone);
  const g = I.g * gain * (0.35 + 0.65 * pr.near);

  const p = {
    surface, dist: pr.dist, delay: pr.delay, airHz: pr.airHz, send: pr.send,
    thump: {
      f0: jit(rng, I.thumpHz, 0.14), f1: jit(rng, I.thumpHz * 0.42, 0.14),
      env: { peak: g, attack: 0.0012, hold: 0, decay: jit(rng, I.thumpDec, 0.25) },
    },
    crack: {
      hp: jit(rng, I.crackHz, 0.18), lp: jit(rng, I.lp, 0.15),
      env: { peak: g * 0.8, attack: 0.0005, hold: 0, decay: jit(rng, I.crackDec, 0.3) },
    },
    debris: [], ric: null, shards: null,
  };

  // Loose fragments skittering away — count driven by surface friability.
  const n = Math.min(6, (S.debris * (0.4 + 0.6 * rng())) | 0);
  for (let i = 0; i < n; i++) {
    p.debris.push({
      t: 0.03 + rng() * 0.34, hz: jit(rng, 2600, 0.5),
      env: { peak: g * 0.10 * (1 - i / (n + 1)), attack: 0.0006, hold: 0, decay: 0.012 + rng() * 0.02 },
    });
  }
  // Ricochet: the classic descending whine. Only off hard/oblique surfaces.
  if ((surface === 'metal' || surface === 'concrete') && chance(rng, surface === 'metal' ? 0.55 : 0.22)) {
    p.ric = {
      t: 0.006, f0: jit(rng, 3400, 0.35), f1: jit(rng, 780, 0.3),
      q: jit(rng, 7, 0.35), vib: jit(rng, 32, 0.4),
      env: { peak: g * 0.38, attack: 0.004, hold: 0, decay: jit(rng, 0.42, 0.35) },
    };
  }
  if (surface === 'glass') {
    p.shards = [];
    const m = 5 + ((rng() * 6) | 0);
    for (let i = 0; i < m; i++) {
      p.shards.push({
        t: 0.004 + rng() * 0.16, hz: 2400 + rng() * 4600,
        env: { peak: g * (0.08 + 0.16 * rng()), attack: 0.001, hold: 0, decay: 0.05 + rng() * 0.18 },
      });
    }
  }
  const tailDec = Math.max(
    envDuration(p.thump.env), p.ric ? p.ric.t + envDuration(p.ric.env) : 0,
    p.debris.length ? 0.4 : 0, p.shards ? 0.32 : 0
  );
  p.dur = pr.delay + tailDec + 0.05;
  return p;
}

// Footstep. Heel strike + toe scuff, so it has a shape instead of being a click.
// `index` alternates the foot (tiny pan + pitch offset) — with the rng jitter this
// is what stops a walk cycle sounding like a metronome.
export function footstepParams(rng, opts = {}) {
  const { surface = 'concrete', speed = 4.4, crouched = false, index = 0, dist = 0, zone = 'outdoor', gain = 1 } = opts;
  const S = surfaceOf(surface).step;
  const pr = propagation(dist, zone);
  const eff = clamp01(speed / 6.6);                       // walk..sprint
  const q = crouched ? 0.34 : 0.55 + 0.75 * eff;          // crouch is ~ -9 dB
  const left = (index & 1) === 0;
  const g = S.g * q * gain * (0.3 + 0.7 * pr.near);

  return {
    surface, dist: pr.dist, delay: pr.delay, airHz: pr.airHz, send: pr.send,
    pan: left ? -0.22 : 0.22,
    heel: {
      hz: jit(rng, S.hz * (crouched ? 0.72 : 1) * (left ? 0.97 : 1.03), 0.16), q: jit(rng, S.q, 0.25),
      env: { peak: g, attack: 0.0018, hold: 0, decay: jit(rng, S.dec * (crouched ? 1.25 : 1), 0.28) },
    },
    body: {
      f0: jit(rng, S.body, 0.12), f1: jit(rng, S.body * 0.55, 0.12),
      env: { peak: g * (crouched ? 0.5 : 0.75), attack: 0.003, hold: 0, decay: jit(rng, 0.07, 0.3) },
    },
    // Scuff trails the heel; its level is the main per-step variation the ear notices.
    scuff: S.scuff > 0.2 && chance(rng, 0.75) ? {
      t: jit(rng, 0.032, 0.4), hz: jit(rng, S.hz * 1.7, 0.25),
      env: { peak: g * 0.34 * S.scuff * (0.4 + 0.8 * rng()), attack: 0.008, hold: 0, decay: jit(rng, 0.055, 0.4) },
    } : null,
    // Gear rattle — sling/pouches. Sprinting rattles more.
    gear: !crouched && chance(rng, 0.25 + 0.5 * eff) ? {
      t: jit(rng, 0.02, 0.5), hz: jit(rng, 5200, 0.2),
      env: { peak: g * 0.16, attack: 0.001, hold: 0, decay: 0.03 + rng() * 0.04 },
    } : null,
    dur: pr.delay + 0.28,
  };
}

// Land / jump — a footstep's heavier cousin, scaled by impact severity.
export function landParams(rng, opts = {}) {
  const { impact = 0.5, surface = 'concrete', dist = 0, zone = 'outdoor' } = opts;
  const f = footstepParams(rng, { surface, speed: 6.6, dist, zone, gain: 1.25 + 1.5 * impact });
  f.body.f0 *= 0.72; f.body.f1 *= 0.68;
  f.body.env.decay *= 1.9 + impact;
  f.heel.env.decay *= 1.4;
  f.gear = { t: jit(rng, 0.028, 0.4), hz: jit(rng, 4600, 0.2),
    env: { peak: f.heel.env.peak * 0.3, attack: 0.001, hold: 0, decay: 0.05 + 0.1 * impact } };
  f.grunt = impact > 0.6 ? { hz: jit(rng, 260, 0.15), env: { peak: 0.16 * impact, attack: 0.02, hold: 0.02, decay: 0.2 } } : null;
  f.dur = 0.6;
  return f;
}

export function jumpParams(rng) {
  return {
    cloth: { hz: jit(rng, 2600, 0.2), env: { peak: 0.13, attack: 0.012, hold: 0, decay: jit(rng, 0.1, 0.3) } },
    gear: { t: jit(rng, 0.03, 0.5), hz: jit(rng, 5000, 0.2), env: { peak: 0.10, attack: 0.001, hold: 0, decay: 0.05 } },
    dur: 0.3,
  };
}

// Shell casing: metallic bounces with shortening intervals and decaying energy,
// exactly like a real casing settling. Every bounce is pitch-varied.
export function shellParams(rng, opts = {}) {
  const { dist = 0, zone = 'outdoor', surface = 'concrete' } = opts;
  const pr = propagation(dist, zone);
  const hard = surface === 'metal' || surface === 'concrete';
  const n = 2 + ((rng() * 3) | 0);
  const base = jit(rng, 3100, 0.22);
  const bounces = [];
  let t = 0, g = 0.20 * (hard ? 1 : 0.55) * (0.4 + 0.6 * pr.near), gapMul = 1;
  for (let i = 0; i < n; i++) {
    bounces.push({
      t, g, hz: base * jit(rng, 1 + i * 0.06, 0.10), ringHz: base * jit(rng, 1.63, 0.12),
      env: { peak: g, attack: 0.0005, hold: 0, decay: jit(rng, 0.055 - i * 0.008, 0.3) },
    });
    t += jit(rng, 0.115 * gapMul, 0.3); gapMul *= 0.72; g *= 0.55;
  }
  return { delay: pr.delay + 0.0, bounces, send: pr.send, airHz: pr.airHz, dur: pr.delay + t + 0.2 };
}

// Reload foley. Distinct stages so a reload reads as a sequence of real objects.
export const RELOAD_STAGES = ['magout', 'magdrop', 'magin', 'charge', 'slap', 'inspect'];

export function reloadParams(rng, stage = 'magout') {
  const s = String(stage).toLowerCase();
  const clk = (t, hz, peak, dec, q = 6) => ({ t, hz, q, env: { peak, attack: 0.0006, hold: 0, decay: dec } });
  const ring = (t, hz, peak, dec) => ({ t, hz, env: { peak, attack: 0.001, hold: 0, decay: dec } });

  if (s === 'magout' || s === 'release') return {
    stage: s, dur: 0.35,
    clicks: [clk(0, jit(rng, 4200, 0.12), 0.30, 0.010), clk(jit(rng, 0.055, 0.2), jit(rng, 2400, 0.15), 0.22, 0.02, 3)],
    rings: [ring(jit(rng, 0.06, 0.2), jit(rng, 900, 0.1), 0.09, 0.09)],
    scrape: { t: 0.06, f0: jit(rng, 1800, 0.15), f1: jit(rng, 900, 0.15), q: 2.2,
      env: { peak: 0.13, attack: 0.006, hold: 0, decay: jit(rng, 0.11, 0.25) } },
  };
  if (s === 'magdrop' || s === 'drop') return {
    stage: s, dur: 0.5,
    clicks: [clk(0, jit(rng, 2100, 0.2), 0.18, 0.03, 2), clk(jit(rng, 0.09, 0.3), jit(rng, 1700, 0.2), 0.08, 0.02, 2)],
    rings: [ring(0, jit(rng, 520, 0.15), 0.07, 0.16)], scrape: null,
  };
  if (s === 'magin' || s === 'insert') return {
    stage: s, dur: 0.4,
    clicks: [clk(0, jit(rng, 1500, 0.15), 0.34, 0.022, 2.4), clk(jit(rng, 0.028, 0.25), jit(rng, 3600, 0.12), 0.26, 0.012)],
    rings: [ring(jit(rng, 0.03, 0.2), jit(rng, 680, 0.1), 0.14, 0.13)],
    scrape: { t: 0, f0: jit(rng, 700, 0.2), f1: jit(rng, 1600, 0.2), q: 1.6,
      env: { peak: 0.16, attack: 0.004, hold: 0, decay: jit(rng, 0.05, 0.3) } },
    thump: { f0: jit(rng, 150, 0.15), f1: jit(rng, 70, 0.15), env: { peak: 0.30, attack: 0.002, hold: 0, decay: 0.07 } },
  };
  if (s === 'charge' || s === 'bolt' || s === 'chamber') return {
    stage: s, dur: 0.45,
    // charging handle: metal-on-metal draw (rising scrape) then the spring-fed slam
    clicks: [clk(jit(rng, 0.115, 0.12), jit(rng, 5200, 0.1), 0.42, 0.014),
             clk(jit(rng, 0.128, 0.12), jit(rng, 2600, 0.12), 0.28, 0.026, 3)],
    rings: [ring(jit(rng, 0.118, 0.1), jit(rng, 1900, 0.08), 0.20, 0.14),
            ring(jit(rng, 0.12, 0.1), jit(rng, 3100, 0.08), 0.11, 0.09)],
    scrape: { t: 0, f0: jit(rng, 1200, 0.15), f1: jit(rng, 3400, 0.15), q: 3.4,
      env: { peak: 0.20, attack: 0.02, hold: 0.02, decay: jit(rng, 0.085, 0.2) } },
    thump: { f0: jit(rng, 190, 0.12), f1: jit(rng, 84, 0.12), env: { peak: 0.24, attack: 0.002, hold: 0, decay: 0.06 } },
  };
  if (s === 'slap' || s === 'tap') return {
    stage: s, dur: 0.25,
    clicks: [clk(0, jit(rng, 1200, 0.2), 0.24, 0.03, 1.8)], rings: [], scrape: null,
    thump: { f0: jit(rng, 170, 0.15), f1: 80, env: { peak: 0.22, attack: 0.002, hold: 0, decay: 0.05 } },
  };
  return { stage: s, dur: 0.2, clicks: [clk(0, jit(rng, 3000, 0.2), 0.18, 0.012)], rings: [], scrape: null };
}

// AI vocal cues — formant-ish filtered noise + tonal core. No samples, no words.
export function vocalParams(rng, kind = 'hit', opts = {}) {
  const { dist = 0, zone = 'outdoor' } = opts;
  const pr = propagation(dist, zone);
  const g = 0.42 * (0.3 + 0.7 * pr.near);
  if (kind === 'death') return {
    dist: pr.dist, delay: pr.delay, airHz: pr.airHz, send: pr.send, dur: pr.delay + 1.4,
    tone: { f0: jit(rng, 190, 0.12), f1: jit(rng, 78, 0.15), sweep: 0.55,
      env: { peak: g * 0.9, attack: 0.03, hold: 0.05, decay: jit(rng, 0.7, 0.2) } },
    formants: [jit(rng, 620, 0.15), jit(rng, 1180, 0.15)],
    breath: { env: { peak: g * 0.5, attack: 0.06, hold: 0, decay: jit(rng, 0.8, 0.2) } },
    // Body hitting the deck, ~0.55 s after the fatal round.
    fall: { t: jit(rng, 0.55, 0.2), f0: jit(rng, 96, 0.15), f1: 42,
      env: { peak: g * 1.1, attack: 0.003, hold: 0, decay: 0.22 } },
    gear: { t: jit(rng, 0.6, 0.2), hz: jit(rng, 4200, 0.2), env: { peak: g * 0.3, attack: 0.001, hold: 0, decay: 0.14 } },
  };
  return {
    dist: pr.dist, delay: pr.delay, airHz: pr.airHz, send: pr.send, dur: pr.delay + 0.5,
    tone: { f0: jit(rng, 260, 0.14), f1: jit(rng, 150, 0.15), sweep: 0.18,
      env: { peak: g * 0.8, attack: 0.012, hold: 0.02, decay: jit(rng, 0.22, 0.25) } },
    formants: [jit(rng, 780, 0.18), jit(rng, 1500, 0.18)],
    breath: { env: { peak: g * 0.45, attack: 0.01, hold: 0, decay: jit(rng, 0.16, 0.3) } },
    fall: null, gear: null,
  };
}

// =========================================================================
// Voice pool — hard cap on simultaneous voices, oldest-out stealing
// =========================================================================
// Pure and synchronous so it can be tested without Web Audio. Callers pass a
// `stop` callback; the pool never touches nodes itself.
export function createVoicePool(max = MAX_VOICES) {
  const live = [];
  let seq = 0;

  const drop = (i, reason) => {
    const v = live[i];
    live.splice(i, 1);
    v.stopped = reason;
    if (v.stop) v.stop(reason);
    return v;
  };

  return {
    get size() { return live.length; },
    get max() { return max; },
    list() { return live.slice(); },

    // Reap anything whose scheduled end has passed. Cheap: called once per tick.
    sweep(now) {
      let n = 0;
      for (let i = live.length - 1; i >= 0; i--) if (live[i].end <= now) { drop(i, 'expired'); n++; }
      return n;
    },

    // priority: 3 = player gunfire / critical, 2 = impacts + AI, 1 = footsteps/foley, 0 = ambience.
    // Returns the voice handle, or null if the incoming sound lost the contest.
    acquire(now, { priority = 1, end = now + 1, stop = null, tag = '' } = {}) {
      this.sweep(now);
      if (live.length >= max) {
        let k = -1;
        for (let i = 0; i < live.length; i++) {
          const v = live[i], b = k < 0 ? null : live[k];
          if (!b || v.priority < b.priority || (v.priority === b.priority && v.start < b.start)) k = i;
        }
        if (k < 0 || live[k].priority > priority) return null;   // never steal from something more important
        drop(k, 'stolen');
      }
      const v = { id: ++seq, start: now, end, priority, stop, tag, stopped: null };
      live.push(v);
      return v;
    },

    release(id, reason = 'released') {
      const i = live.findIndex((v) => v.id === id);
      return i < 0 ? false : (drop(i, reason), true);
    },
    clear(reason = 'cleared') { while (live.length) drop(live.length - 1, reason); },
  };
}

// =========================================================================
// Mix: ducking + master soft clip
// =========================================================================
// Sidechain shape used for both directions of ducking (ambience under gunfire,
// own gunfire under critical cues). Piecewise: exp attack -> hold -> exp release.
export function duckGainAt(t, t0, { amount = 0.5, attack = 0.012, hold = 0.05, release = 0.25 } = {}) {
  const d = t - t0;
  if (d <= 0 || d > attack + hold + release) return 1;
  const floor = 1 - clamp01(amount);
  if (d < attack) return 1 - (1 - floor) * (1 - Math.exp(-3 * d / attack));
  if (d < attack + hold) return floor;
  const r = (d - attack - hold) / release;
  return floor + (1 - floor) * (1 - Math.exp(-3 * r));
}

// tanh soft clip for the final safety stage — bounded, odd-symmetric, monotone.
export function makeSoftClipCurve(n = 2048, drive = 1.5) {
  const c = new Float32Array(n);
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / k;
  }
  return c;
}
