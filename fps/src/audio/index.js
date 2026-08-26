// Fully synthesized event audio. The graph is created only after a user gesture;
// headless capture can emit every event with no AudioContext and never throw.

import { gunshotParams, impactParams, footstepParams, landParams, jumpParams, reloadParams, makeSoftClipCurve } from './dsp.js';

export function createAudio({ bus, camera }) {
  let ac = null, master = null, noiseBuf = null, seed = 0x51a7c3d2, foot = 0;
  const offs = [];
  const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  function init() {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -7; comp.knee.value = 10; comp.ratio.value = 7; comp.attack.value = 0.002; comp.release.value = 0.16;
    const shaper = ac.createWaveShaper(); shaper.curve = makeSoftClipCurve(2048, 1.35); shaper.oversample = '2x';
    master = ac.createGain(); master.gain.value = 0.72; master.connect(comp); comp.connect(shaper); shaper.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.8), ac.sampleRate);
    const a = noiseBuf.getChannelData(0); for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1;
  }

  function env(g, e, t) {
    const t0 = Math.max(ac.currentTime, t), a = Math.max(0.0004, e.attack ?? 0.001), h = e.hold ?? 0, d = Math.max(0.006, e.decay ?? 0.08);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, e.peak ?? 0.2), t0 + a);
    g.gain.setValueAtTime(Math.max(0.0002, e.peak ?? 0.2), t0 + a + h); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + h + d);
    return t0 + a + h + d + 0.02;
  }
  function tone(o, t = ac?.currentTime ?? 0, type = 'sine', pan = 0) {
    if (!ac || !o?.env) return;
    const s = ac.createOscillator(), g = ac.createGain(), p = ac.createStereoPanner(); s.type = type;
    s.frequency.setValueAtTime(Math.max(20, o.f0 ?? o.hz ?? 180), t); if (o.f1) s.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.sweep ?? o.env.decay ?? 0.1));
    p.pan.value = pan; s.connect(g); g.connect(p); p.connect(master); const end = env(g, o.env, t); s.start(t); s.stop(end);
  }
  function noise(o, t = ac?.currentTime ?? 0, pan = 0) {
    if (!ac || !o?.env || !noiseBuf) return;
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), p = ac.createStereoPanner();
    s.buffer = noiseBuf; f.type = o.hp ? 'bandpass' : 'lowpass'; f.frequency.value = Math.max(120, o.lp ?? o.hp ?? o.hz ?? 2400); f.Q.value = o.q ?? 0.8; p.pan.value = pan;
    s.connect(f); f.connect(g); g.connect(p); p.connect(master); const end = env(g, o.env, t); s.start(t, rnd() * 1.2); s.stop(end);
  }
  const surf = (m = '') => m.includes('metal') || m === 'corrugated' || m === 'rustedSteel' ? 'metal' : m === 'glass' ? 'glass' : m === 'wood' ? 'wood' : m === 'gravel' ? 'gravel' : 'concrete';

  function gun(e, ai = false) {
    if (!ac) return; const q = gunshotParams(rnd, { profile: ai ? 'smg' : 'rifle', gain: ai ? 0.52 : 0.82 }); const t = ac.currentTime;
    noise(q.crack, t); tone(q.body, t, 'triangle'); tone(q.sub, t, 'sine'); noise(q.tail, t + q.tail.t);
    if (q.mech) { tone({ hz: q.mech.hz, env: { peak: q.mech.g, attack: .001, decay: .025 } }, t + q.mech.t1, 'square'); tone({ hz: q.mech.ringHz, env: { peak: q.mech.g * .5, attack: .001, decay: .045 } }, t + q.mech.t2, 'sine'); }
    if (!ai) tone({ hz: 3100 + rnd() * 900, env: { peak: .13, attack: .001, decay: .055 } }, t + .065, 'square', .45);
  }
  function impact(e) {
    if (!ac) return; const q = impactParams(rnd, { surface: surf(e.mat), gain: .42 }), t = ac.currentTime;
    tone(q.thump, t, 'triangle'); noise(q.crack, t); if (q.ric) tone(q.ric, t + q.ric.t, 'sine');
    for (const x of q.debris) tone({ hz: x.hz, env: x.env }, t + x.t, 'square', rnd() * 2 - 1);
  }
  function stepSound(e) {
    if (!ac) return; const q = footstepParams(rnd, { surface: surf(e.surface), speed: e.speed ?? 4.4, crouched: !!e.crouched, index: foot++ }), t = ac.currentTime;
    noise(q.heel, t, q.pan); tone(q.body, t, 'triangle', q.pan); if (q.scuff) noise(q.scuff, t + q.scuff.t, q.pan); if (q.gear) tone(q.gear, t + q.gear.t, 'square', -q.pan);
  }
  function reload(e) {
    if (!ac) return; const q = reloadParams(rnd, e.stage), t = ac.currentTime;
    for (const x of q.clicks ?? []) tone({ hz: x.hz, env: x.env }, t + x.t, 'square', .22);
    for (const x of q.rings ?? []) tone({ hz: x.hz, env: x.env }, t + x.t, 'sine', .18);
    if (q.scrape) noise(q.scrape, t + q.scrape.t, .15); if (q.thump) tone(q.thump, t, 'triangle', .1);
  }

  offs.push(bus.on('weapon:fire', (e) => gun(e, false)));
  offs.push(bus.on('ai:fire', (e) => gun(e, true)));
  offs.push(bus.on('weapon:impact', impact));
  offs.push(bus.on('player:footstep', stepSound));
  offs.push(bus.on('weapon:reload', reload));
  offs.push(bus.on('player:land', (e) => { if (!ac) return; const q = landParams(rnd, { impact: Math.min(1, (e.impact ?? 0) / 10) }), t = ac.currentTime; noise(q.heel, t); tone(q.body, t, 'triangle'); }));
  offs.push(bus.on('player:jump', () => { if (!ac) return; const q = jumpParams(rnd), t = ac.currentTime; noise(q.cloth, t); tone(q.gear, t + q.gear.t, 'square'); }));

  return {
    step() {},
    resume() { init(); if (ac?.state === 'suspended') ac.resume(); },
    get ctx() { return ac; },
    dispose() { for (const off of offs) off(); ac?.close(); ac = null; },
  };
}
