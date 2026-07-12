// audio.js — "auditory tunnel vision".
// Ambient carnival bed = heavy lowpass + low gain (drowned). Critical SFX = dry, crisp,
// spatialized to emitter. 100% synthesized (no asset files).
let ctx = null, ambientGain = null, sfxGain = null, noiseBuf = null, ambientNode = null, lp = null, drone = null, droneGain = null;

// per-booth ambience: [lowpass Hz, bed gain, drone Hz] — each booth "wrong" in its own way
const PROFILES = {
  shooting: [380, 0.22, 52], anchor: [320, 0.20, 41], dart: [420, 0.20, 61],
  ringtoss: [350, 0.22, 49], basketball: [440, 0.24, 70], skee: [500, 0.24, 82]
};

function ensure() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  // --- ambient bus: lowpass ~400Hz, low gain (muffled bed) ---
  lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.4;
  ambientGain = ctx.createGain(); ambientGain.gain.value = 0.22;
  lp.connect(ambientGain).connect(ctx.destination);

  // --- sfx bus: dry, full-band, spatial ---
  sfxGain = ctx.createGain(); sfxGain.gain.value = 0.9;
  sfxGain.connect(ctx.destination);

  noiseBuf = makeNoise(2);
  ambientNode = ctx.createBufferSource();
  ambientNode.buffer = noiseBuf; ambientNode.loop = true;
  const bed = ctx.createBiquadFilter(); bed.type = 'bandpass'; bed.frequency.value = 220; bed.Q.value = 0.3;
  ambientNode.connect(bed).connect(lp);
  ambientNode.start();

  // --- low dread drone (booth-tuned root + a fifth), through the muffled bus ---
  drone = ctx.createOscillator(); drone.type = 'sine'; drone.frequency.value = 52;
  const d2 = ctx.createOscillator(); d2.type = 'sine'; d2.frequency.value = 78;
  droneGain = ctx.createGain(); droneGain.gain.value = 0.05;
  drone.connect(droneGain).connect(lp); d2.connect(droneGain);
  drone.start(); d2.start(); drone._d2 = d2;
}

function makeNoise(seconds) {
  const n = (ctx.sampleRate * seconds) | 0, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } // brown-ish
  return buf;
}

function panner(pos) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = 0.6;
  if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
  else p.setPosition(pos.x, pos.y, pos.z);
  return p;
}
const env = (g, t0, peak, dur) => { g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); };

// Voices ----------------------------------------------------------------
function vCrack(dst, t) { // rifle: bright noise burst + low click
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
  const g = ctx.createGain(); env(g, t, 0.9, 0.14);
  src.connect(hp).connect(g).connect(dst); src.start(t); src.stop(t + 0.16);
  const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 140;
  const g2 = ctx.createGain(); env(g2, t, 0.5, 0.05); o.connect(g2).connect(dst); o.start(t); o.stop(t + 0.06);
}
function vPing(dst, t, f = 900) { // plate hit: metallic partials
  [1, 2.4, 3.9].forEach((m, i) => {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
    const g = ctx.createGain(); env(g, t, 0.5 / (i + 1), 0.35 + i * 0.1);
    o.connect(g).connect(dst); o.start(t); o.stop(t + 0.6);
  });
}
function vWhistle(dst, t) { // bullet pass-by
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(2600, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.18);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 6;
  const g = ctx.createGain(); env(g, t, 0.25, 0.2);
  o.connect(bp).connect(g).connect(dst); o.start(t); o.stop(t + 0.22);
}
function vThock(dst, t) { // miss on wood
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
  const g = ctx.createGain(); env(g, t, 0.5, 0.09);
  src.connect(lp).connect(g).connect(dst); src.start(t); src.stop(t + 0.1);
}
function vThud(dst, t) { // mallet on the pad: low sine body + metallic ring + noise whack
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.18);
  const g = ctx.createGain(); env(g, t, 0.95, 0.24); o.connect(g).connect(dst); o.start(t); o.stop(t + 0.28);
  [1.7, 2.9].forEach((m, i) => { // steel-pad partials
    const s = ctx.createOscillator(); s.type = 'triangle'; s.frequency.value = 180 * m;
    const sg = ctx.createGain(); env(sg, t, 0.18 / (i + 1), 0.12); s.connect(sg).connect(dst); s.start(t); s.stop(t + 0.14);
  });
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
  const ng = ctx.createGain(); env(ng, t, 0.5, 0.05); n.connect(hp).connect(ng).connect(dst); n.start(t); n.stop(t + 0.06);
}
function vDing(dst, t) { // bell: bright inharmonic partials, long clear decay (cuts the muffled bed)
  [1, 2.76, 5.4, 8.9].forEach((m, i) => {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 660 * m;
    const g = ctx.createGain(); env(g, t, 0.6 / (i + 1), 1.5 - i * 0.24); o.connect(g).connect(dst); o.start(t); o.stop(t + 1.7);
  });
}
function vWhoosh(dst, t) { // thrown dart: soft band-passed noise rising as it leaves the hand
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(1600, t + 0.14);
  const g = ctx.createGain(); env(g, t, 0.28, 0.16); n.connect(bp).connect(g).connect(dst); n.start(t); n.stop(t + 0.18);
}
function vPop(dst, t) { // balloon: bright noise transient + quick rubber-snap downglide
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2000;
  const g = ctx.createGain(); env(g, t, 0.85, 0.05); n.connect(hp).connect(g).connect(dst); n.start(t); n.stop(t + 0.06);
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.05);
  const g2 = ctx.createGain(); env(g2, t, 0.5, 0.06); o.connect(g2).connect(dst); o.start(t); o.stop(t + 0.07);
}
function vBreath(dst, t) { // isolated inhale: band-passed noise, slow swell in/out
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.35, t + 0.28); g.gain.linearRampToValueAtTime(0.0001, t + 0.6);
  n.connect(bp).connect(g).connect(dst); n.start(t); n.stop(t + 0.62);
}
function vClack(dst, t, f = 320) { // ring on peg: bright wooden knock (two quick woody partials)
  [1, 1.9].forEach((mul, i) => {
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(f * mul, t); o.frequency.exponentialRampToValueAtTime(f * mul * 0.7, t + 0.05);
    const g = ctx.createGain(); env(g, t, 0.5 / (i + 1), 0.09); o.connect(g).connect(dst); o.start(t); o.stop(t + 0.1);
  });
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
  const g2 = ctx.createGain(); env(g2, t, 0.3, 0.03); n.connect(bp).connect(g2).connect(dst); n.start(t); n.stop(t + 0.04);
}
function vMurmur(dst, t) { // attendant: low uneasy vocalization (detuned sines + breathy noise, sagging)
  [88, 91, 132].forEach((fq, i) => {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(fq, t); o.frequency.linearRampToValueAtTime(fq * 0.93, t + 0.5);
    const g = ctx.createGain(); env(g, t, 0.14 / (i + 1), 0.5); o.connect(g).connect(dst); o.start(t); o.stop(t + 0.55);
  });
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 2;
  const g2 = ctx.createGain(); env(g2, t, 0.12, 0.4); n.connect(bp).connect(g2).connect(dst); n.start(t); n.stop(t + 0.45);
}
function vSwish(dst, t) { // clean make: soft net hiss (band-passed noise, quick down-sweep)
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(3600, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.22);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  n.connect(bp).connect(g).connect(dst); n.start(t); n.stop(t + 0.28);
}
function vScrape(dst, t) { // ring grinding on a peg: gritty band-passed noise, brief sustain
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
  bp.frequency.setValueAtTime(1600, t); bp.frequency.exponentialRampToValueAtTime(900, t + 0.15); // downward grind
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  n.connect(bp).connect(g).connect(dst); n.start(t); n.stop(t + 0.18);
}
function vTick(dst, t) { // metronome: 2 ms dry click (band-passed noise transient)
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 3;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  n.connect(bp).connect(g).connect(dst); n.start(t); n.stop(t + 0.02);
}
function vSlam(dst, t) { // anchor impact: sub-sine body 55→28 Hz + noise crack + long inharmonic ring
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(55, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
  const g = ctx.createGain(); env(g, t, 1.0, 0.55); o.connect(g).connect(dst); o.start(t); o.stop(t + 0.6);
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;                         // metal crack transient
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600;
  const ng = ctx.createGain(); env(ng, t, 0.7, 0.06); n.connect(hp).connect(ng).connect(dst); n.start(t); n.stop(t + 0.07);
  [1, 2.71, 5.13, 8.4].forEach((m, i) => {                                        // 1.2 s inharmonic anvil ring
    const p = ctx.createOscillator(); p.type = 'triangle'; p.frequency.value = 190 * m;
    const pg = ctx.createGain(); env(pg, t, 0.28 / (i + 1), 1.2 - i * 0.18); p.connect(pg).connect(dst); p.start(t); p.stop(t + 1.3);
  });
}
function vCrowd(dst, t) { // 3 band-passed noise swells, 1.4 s slow rise (uneasy cheer through the muffled bed)
  [520, 900, 1500].forEach((fq, i) => {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fq; bp.Q.value = 1.6;
    const g = ctx.createGain(); const t0 = t + i * 0.12;
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.16 / (i + 1), t0 + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    n.connect(bp).connect(g).connect(dst); n.start(t0); n.stop(t0 + 1.5);
  });
}
const VOICES = {
  crack: vCrack, ping: vPing, whistle: vWhistle, thock: vThock, thud: vThud, ding: vDing,
  whoosh: vWhoosh, pop: vPop, breath: vBreath, clack: vClack, swish: vSwish, murmur: vMurmur,
  scrape: vScrape, tick: vTick, slam: vSlam, crowd: vCrowd
};

export const audio = {
  resume() { ensure(); if (ctx.state === 'suspended') ctx.resume(); },
  ambient(on) { ensure(); ambientGain.gain.value = on ? 0.22 : 0.0; if (droneGain) droneGain.gain.value = on ? 0.05 : 0.0; },
  // retune the muffled bed + dread drone per booth — ramped (setTargetAtTime) so the transition slurs
  ambientProfile(name) {
    ensure(); const p = PROFILES[name] || PROFILES.shooting, t = ctx.currentTime;
    lp.frequency.setTargetAtTime(p[0], t, 0.4); ambientGain.gain.setTargetAtTime(p[1], t, 0.4);
    if (drone) { drone.frequency.setTargetAtTime(p[2], t, 0.4); drone._d2.frequency.setTargetAtTime(p[2] * 1.5, t, 0.4); }
  },
  // Update HRTF listener. Pass plain {x,y,z} camera position and forward direction.
  listener(pos, fwd) {
    if (!ctx) return; const l = ctx.listener;
    if (l.positionX) { l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z; }
    else l.setPosition(pos.x, pos.y, pos.z);
    if (l.forwardX) { l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
    else l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
  },
  playSpatial(name, pos, opts = {}) {
    ensure(); const t = ctx.currentTime + 0.001;
    let dst = sfxGain;
    if (pos) { const pn = panner(pos); pn.connect(sfxGain); dst = pn; }
    (VOICES[name] || vPing)(dst, t, opts.freq);
  }
};
