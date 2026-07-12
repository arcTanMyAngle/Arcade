// games/anchor.js — Level 2: ANCHOR SMASH (rhythm · flick · impulse). Replaces High Striker.
// Two-phase kinetic sports gesture, ZERO RNG in outcome (the L-key pattern is seeded + logged; the
// score is a pure fn of key/flick InputFrames). Cursor mode, N_SMASH attempts.
//   CHARGE  : a seeded pattern of A/S/D/F keys, one per beat on a pure-substep grid. A correct key
//             within ±win of its beat pumps the flywheel  E += E_HIT·beatAcc(err,win); a wrong key or
//             a missed beat bleeds it  E *= 0.85. Flywheel spin ∝ E; meter = E/E_MAX  (E_MAX=L·E_HIT).
//   RELEASE : a 90-substep capture window; the hammer is hoisted. A downward wrist-flick releases it —
//             vf from flick speed, align from its verticality — and the flywheel dumps E as drive force:
//             vImp = trackImpact(vf,E,mH,H,μ). power=vImp/VIMP_REF, mult=1+2·align², pts=400·power²·mult.
// Determinism: reads ONLY input.frame; no Math.random in step/scoring; fx bursts use a SEPARATE seeded
// rng so patterns are pure fn of tier; render-only camera kick (position/base pose never touch scoring).
import { trackImpact, H_TRACK, clamp, mulberry32, G } from '../core/physics.js';
import { beatAcc, DPHASE, K } from '../core/kinetics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';
import { makeBurst } from '../core/fx.js';

// [bpm, L beats, timing win(substeps), rail μ, hammer mass mH, energy per perfect hit E_HIT]
const TIERS = [
  { bpm: 92,  L: 6,  win: 6, mu: 0.02, mH: 10, E_HIT: 120 },
  { bpm: 102, L: 7,  win: 5, mu: 0.03, mH: 11, E_HIT: 115 },
  { bpm: 112, L: 8,  win: 4, mu: 0.04, mH: 12, E_HIT: 110 },
  { bpm: 122, L: 9,  win: 3, mu: 0.05, mH: 13, E_HIT: 105 },
  { bpm: 132, L: 10, win: 2, mu: 0.06, mH: 14, E_HIT: 100 }   // T5: 2-substep window — frame-tight, honest
];

const N_SMASH = 5;
const CAPTURE = 90;                 // substeps the flick window stays open after the last beat
const FLICK_MIN = 0.4;              // min downward flick (screen-heights/s) to count as a release
const FLICK_TO_V = 1.8, VCAP = 3.5; // flick → hammer entry speed: vf = 1.8·min(−flickVY, 3.5)
const g = -G.y;                     // 9.81
const BASE_Y = 0.8;                 // anvil top / track bottom
const TOP_Y = BASE_Y + H_TRACK;     // hoist height
const KICK_AMP = 0.02, KICK_DECAY = 4.5;
const FLY_MAX = 26;                 // flywheel top angular speed (visual)
const KEYS = [{ bit: K.A, g: 'A' }, { bit: K.S, g: 'S' }, { bit: K.D, g: 'D' }, { bit: K.F, g: 'F' }];
const KEY_MASK = K.A | K.S | K.D | K.F;

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rngPat = mulberry32(0xA7C4 ^ (ctx.tier * 2654435761));   // pattern seed (spec) — outcome-relevant, pure fn of tier
  const rngFx = mulberry32(0xA9C4 ^ (ctx.tier * 2654435761));    // fx bursts — decoupled so play can't desync patterns
  input.setMode('cursor');

  const SPB = Math.round(3600 / T.bpm);            // substeps per beat (pure: 60·60/bpm)
  const chargeEndN = (T.L - 1) * SPB + T.win + 1;  // charge runs until the last beat's window closes
  const E_MAX = T.L * T.E_HIT;
  const VIMP_REF = trackImpact(FLICK_TO_V * VCAP, E_MAX, T.mH, H_TRACK, T.mu); // perfect-play impact = power 1

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0xff2fb0, span: 6, back: -6 });
  const att = makeAttendant(THREE, scene, { at: [-3.6, 0, 1.0], face: 0.5, hue: 0x6b2f52, kind: 'clown', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat.wood([80, 58, 38]));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 14), mat.paint([22, 26, 24]));
  wall.position.set(0, 6, -6); wall.receiveShadow = true; scene.add(wall);

  // tower: base block + twin guide rails (the hammer rides between them) + anvil at the foot
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, BASE_Y, 1.6), mat.metal([116, 122, 128]));
  base.position.set(0, BASE_Y / 2, 0); base.castShadow = base.receiveShadow = true; scene.add(base);
  const anvil = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 1.1), mat.metal([150, 156, 162]));
  anvil.position.set(0, BASE_Y + 0.2, 0); anvil.castShadow = true; uncannySkew(anvil, 4, 0.05); scene.add(anvil);
  const railGeo = new THREE.BoxGeometry(0.08, H_TRACK, 0.08), railMat = mat.metal([150, 150, 156]);
  for (const x of [-0.5, 0.5]) {
    const r = new THREE.Mesh(railGeo, railMat); r.position.set(x, BASE_Y + H_TRACK / 2, 0); r.castShadow = true; scene.add(r);
  }
  // rung marks up the run (dead magenta neon) — a height scale behind the hammer
  const rungGeo = new THREE.BoxGeometry(1.06, 0.03, 0.05);
  for (let i = 1; i <= 4; i++) {
    const rung = new THREE.Mesh(rungGeo, mat.emissive(0xff2fb0, 1.4));
    rung.position.set(0, BASE_Y + (i / 5) * H_TRACK, -0.08); scene.add(rung);
  }

  // flywheel: a heavy off-color disc mounted on the side; spins ∝ stored energy E
  const flywheel = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.14, 28), mat.emissive(0x39ff88, 1.2));
  disc.rotation.x = Math.PI / 2; flywheel.add(disc);                       // axis → +z (faces the camera)
  for (let i = 0; i < 6; i++) {                                            // spokes so the spin reads
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.28, 0.04), mat.metal([90, 96, 104]));
    sp.rotation.z = i * Math.PI / 3; flywheel.add(sp);
  }
  flywheel.position.set(-1.5, 2.2, 0.2); uncannySkew(flywheel, 2, 0.05); scene.add(flywheel);

  // hammer block: rides the track. Sits on the anvil during charge, hoists during the capture window,
  // then integrates down the run on release (visual integration of trackImpact's constant accel).
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.9), mat.metal([120, 124, 130]));
  uncannySkew(hammer, 5, 0.07); hammer.castShadow = true; scene.add(hammer);

  camera.position.set(3.2, 2.7, 6.2); camera.lookAt(0, 2.2, 0);
  const camQ0 = camera.quaternion.clone();                                 // base pose; render kick pivots off this

  // --- state ---
  const fx = makeBurst(THREE, scene);
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3();
  const _kq = new THREE.Quaternion(), _ke = new THREE.Euler(0, 0, 0, 'YXZ');
  let phase = 'charge', cn = 0, rn = 0, bi = 0;          // phase counters + current beat index
  let pattern = [], glyphs = [];
  let E = 0, attemptClean = true;
  let attemptsLeft = N_SMASH, score = 0, done = false, pendingEnd = false;
  let simTime = 0, kick = 0, flyRate = 0, flyAng = 0;
  let hy = BASE_Y, hv = 0, hAcc = 0, curPts = 0, curPower = 0, curMult = 1;
  let restN = 0;
  let maxMult = 0, crits = 0, fullChain = false;         // round stats
  audio.ambientProfile?.('anchor');
  hud.mode('count'); hud.reticle(false); hud.striker(true); hud.sweet(1); // sweet band hidden — meter is an energy gauge
  hud.score(0); hud.combo(0); hud.count('SMASHES', attemptsLeft); hud.charge(0, false);
  startAttempt();

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }

  function startAttempt() {
    pattern = []; glyphs = [];
    for (let i = 0; i < T.L; i++) { const k = KEYS[Math.floor(rngPat() * 4)]; pattern.push(k); glyphs.push(k.g); }
    E = 0; cn = -SPB; bi = 0; attemptClean = true; phase = 'charge';       // one beat of lead-in (beat i at cn=i·SPB)
    hy = BASE_Y; hammer.position.set(0, hy + 0.45, 0);
    hud.charge(0, false); hud.rhythm(glyphs, 0, false);
  }

  // resolve the rhythm for this substep (charge phase); returns whether the flick meter is "hot"
  function stepBeats(f) {
    // steady metronome tick, independent of hits (lead-in + each beat center)
    if (cn === -SPB || (cn >= 0 && cn <= (T.L - 1) * SPB && cn % SPB === 0)) audio.playSpatial('tick', null);
    if (bi < T.L) {
      const center = bi * SPB, err = Math.abs(cn - center), inWin = err <= T.win;
      const kp = f.keyPress & KEY_MASK;
      if (inWin && kp) {
        if (kp & pattern[bi].bit) {                                        // correct key in window → pump
          E += T.E_HIT * beatAcc(err, T.win);
          audio.playSpatial('clack', { x: -1.5, y: 2.2, z: 0.2 }, { freq: 360 + (T.L - bi) * 20 });
        } else { E *= 0.85; attemptClean = false; }                       // wrong key → bleed
        bi++;
      } else if (cn > center + T.win) { E *= 0.85; attemptClean = false; bi++; } // missed beat → bleed
    }
    const curInWin = bi < T.L && Math.abs(cn - bi * SPB) <= T.win;
    hud.charge(clamp(E / E_MAX, 0, 1), curInWin);
    hud.rhythm(glyphs, bi, curInWin);
    return curInWin;
  }

  function fireSmash(vf, align) {
    const vImp = trackImpact(vf, E, T.mH, H_TRACK, T.mu);
    curPower = Math.min(vImp / VIMP_REF, 1);
    curMult = 1 + 2 * align * align;                                       // 1× (45°+) .. 3× (pure vertical)
    curPts = Math.round(400 * curPower * curPower * curMult);
    hv = vf; hAcc = g * (1 - T.mu) + E / (T.mH * H_TRACK);                 // v² = vf² + 2·hAcc·H → lands at vImp
    hy = TOP_Y; phase = 'slam';
    hud.rhythm(null); audio.playSpatial('whoosh', { x: 0, y: TOP_Y, z: 0 });  // whoosh on the drop
  }

  function land() {
    hy = BASE_Y; score += curPts;
    maxMult = Math.max(maxMult, curMult);
    if (curMult >= 2.5) crits++;
    if (attemptClean) fullChain = true;                                    // a clean rhythm chain (any attempt)
    const anvilPos = { x: 0, y: BASE_Y + 0.4, z: 0 };
    fx.spawn(anvilPos, Math.round(6 + 18 * curPower), rngFx, 2.4 + 3.2 * curPower, curMult >= 2.5 ? 0xff2fb0 : 0x39ff88);
    kick = Math.min(1, kick + 0.35 + 0.55 * curPower);                     // camera kick scaled by power
    audio.playSpatial('slam', anvilPos);
    if (curMult >= 2.5) audio.playSpatial('crowd', null);
    const s = toScreen({ x: 0, y: BASE_Y + 0.7, z: 0 });
    hud.pop(s.x, s.y, `${curPts}  ×${curMult.toFixed(1)}`, curMult >= 2.5 ? '#ff2fb0' : '#39ff88');
    hud.score(score); att.react(curPower > 0.6 ? 'cheer' : curPower > 0.25 ? 'nod' : 'shake');
    attemptsLeft--; hud.count('SMASHES', attemptsLeft);
    if (attemptsLeft <= 0) pendingEnd = true;
    phase = 'rest'; restN = 42;
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt;
      kick = Math.max(0, kick - dt * KICK_DECAY); fx.step(dt);
      const f = input.frame;

      if (phase === 'charge') {
        stepBeats(f); cn++;
        if (cn >= chargeEndN) {                                            // hoist; open the flick window
          while (bi < T.L) { E *= 0.85; attemptClean = false; bi++; }      // any un-pressed trailing beats miss
          phase = 'release'; rn = 0; hy = TOP_Y; hud.rhythm(null); hud.charge(clamp(E / E_MAX, 0, 1), false);
        }
      } else if (phase === 'release') {
        // downward wrist-flick on the RELEASE frame smashes; no flick before the window closes → limp drop
        if (f.dphase === DPHASE.RELEASE && f.flickVY < -FLICK_MIN) {
          const align = 1 - clamp(Math.abs(f.flickVX) / Math.abs(f.flickVY), 0, 1);
          fireSmash(FLICK_TO_V * Math.min(-f.flickVY, VCAP), align);
        } else if (rn >= CAPTURE) fireSmash(0, 0);
        rn++;
      } else if (phase === 'slam') {
        hv += hAcc * dt; hy -= hv * dt;                                    // integrate the run (visual; score already fixed)
        if (hy <= BASE_Y) land();
      } else if (phase === 'rest') {
        if (--restN <= 0) { if (pendingEnd) return end(); startAttempt(); }
      }

      // flywheel visual: rate chases E while spinning up, decays after release (energy dumped)
      const flyTarget = (phase === 'charge' || phase === 'release') ? E / E_MAX : 0;
      flyRate += (flyTarget - flyRate) * 0.1; flyAng += flyRate * FLY_MAX * dt;
    },
    render() {
      flywheel.rotation.z = flyAng;
      hammer.position.set(0, hy + 0.45, 0);                               // block centre offset above the track point
      // render-only camera kick: pivot off the base pose (position untouched ⇒ scoring stays deterministic)
      camera.quaternion.copy(camQ0);
      if (kick > 1e-4) { const s = kick * KICK_AMP; _ke.set(s * Math.sin(simTime * 41), s * 0.7 * Math.sin(simTime * 33 + 1.7), s * 0.5 * Math.sin(simTime * 27 + 0.6), 'YXZ'); camera.quaternion.multiply(_kq.setFromEuler(_ke)); }
      camera.getWorldDirection(_fwd); audio.listener(camera.position, _fwd);
      att.update(simTime, phase === 'slam' ? { x: 0, y: hy, z: 0 } : null);
    },
    teardown() { done = true; hud.striker(false); hud.rhythm(null); hud.mode('time'); fx.teardown(); att.teardown(); }
  };

  function end() {
    done = true; hud.striker(false); hud.rhythm(null); document.exitPointerLock?.();
    ctx.end('LAST SMASH', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`,
      { score, stats: { maxMult, crits, fullChain } });
  }
}
