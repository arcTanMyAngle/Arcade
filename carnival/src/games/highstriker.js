// games/highstriker.js — Level 2: High Striker (mallet · impulse · timing).
// Deterministic: the outcome is a pure function of the release frame. The charge meter
// oscillates (triangle over 2·RISE frames); releasing near the peak yields high charge AND
// high timing-accuracy at once, so bell-ringing needs a near-perfect release.
//   sH = SWING·chargeGain·charge·acc   (mallet head speed)
//   v0 = (1+e)·mH/(mH+mP)·sH           (impulsive transfer to the puck)
//   H  = v0²/(2(g+µg))                 (rail apex; the puck clamps at the bell)
import { railImpulse, railApex, G, clamp } from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [chargeGain, sweet-window(frames), mP(kg), rail µ, bellHeight(rel), e]
const TIERS = [
  { gain: 1.35, win: 12, mP: 4, mu: 0.02, bell: 0.70,  e: 0.95 },
  { gain: 1.25, win: 8,  mP: 5, mu: 0.03, bell: 0.80,  e: 0.92 },
  { gain: 1.15, win: 5,  mP: 6, mu: 0.04, bell: 0.88,  e: 0.90 },
  { gain: 1.08, win: 3,  mP: 7, mu: 0.05, bell: 0.94,  e: 0.88 },
  { gain: 1.00, win: 1,  mP: 8, mu: 0.06, bell: 0.985, e: 0.85 }
];

const g = -G.y;       // 9.81 (gravity magnitude)
const mH = 12;        // mallet head mass (kg), fixed across tiers
const SWING = 8;      // mallet-head speed scale (m/s per unit gain·charge·acc)
const RISE = 42;      // frames for the charge meter to sweep 0->1 (triangle; period 2·RISE)
const ACC_MIN = 0.5;  // timing floor: a mistimed-but-charged swing still launches at half power
const N_SWINGS = 10;
const BASE_Y = 0.8, RAIL_H = 4.1;

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);

  // Fixed height reference shared by ALL tiers: the T5 perfect-play apex defines the bell scale,
  // so heavier puck / more friction / lower gain genuinely lower your reach against one bar.
  const REF = TIERS[4];
  const v0ref = railImpulse(SWING * REF.gain, mH, REF.mP, REF.e);
  const H_REF = railApex(v0ref, g, REF.mu) / REF.bell;
  const bellY = BASE_Y + T.bell * H_REF;
  const sweetLo = 1 - T.win / RISE; // meter fraction at which the sweet-spot band begins

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0xff2fb0, span: 6, back: -6 });
  const att = makeAttendant(THREE, scene, { at: [-3.4, 0, 1.2], face: 0.5, hue: 0x6b2f52, kind: 'clown', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat.wood([80, 58, 38]));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 14), mat.paint([24, 28, 26]));
  wall.position.set(0, 6, -6); wall.receiveShadow = true; scene.add(wall);

  // tower: base block + twin scratched-steel rails
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, BASE_Y, 1.6), mat.metal([118, 124, 130]));
  base.position.set(0, BASE_Y / 2, 0); base.castShadow = base.receiveShadow = true; scene.add(base);
  const railGeo = new THREE.BoxGeometry(0.09, RAIL_H, 0.09), railMat = mat.metal([150, 150, 156]);
  for (const x of [-0.34, 0.34]) {
    const r = new THREE.Mesh(railGeo, railMat); r.position.set(x, BASE_Y + RAIL_H / 2, 0);
    r.castShadow = true; scene.add(r);
  }

  // ring rungs up the rail at 20/40/60/80% of bell height (magenta neon numerals stand-in)
  const rungGeo = new THREE.BoxGeometry(0.82, 0.03, 0.14);
  for (let i = 1; i <= 4; i++) {
    const rung = new THREE.Mesh(rungGeo, mat.emissive(0xff2fb0, 1.6));
    rung.position.set(0, BASE_Y + (i / 5) * (bellY - BASE_Y), 0.02); scene.add(rung);
  }
  const bell = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.09, 12, 28), mat.emissive(0xfff2a0, 2.2));
  bell.position.set(0, bellY, 0); bell.rotation.x = Math.PI / 2; uncannySkew(bell, 3, 0.06); scene.add(bell);

  // puck: off-color glowing disc that rides the rail
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 20), mat.emissive(0x39ff88, 1.4));
  puck.position.set(0, BASE_Y, 0); uncannySkew(puck, 1, 0.05); puck.castShadow = true; scene.add(puck);

  // mallet: oversized head (uncanny) on a handle, pivots beside the base (visual only)
  const mallet = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 10), mat.wood([120, 84, 44]));
  handle.position.y = 0.8; mallet.add(handle);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.34), mat.metal([120, 124, 130]));
  head.position.y = 1.55; uncannySkew(head, 5, 0.08); mallet.add(head);
  mallet.position.set(1.55, BASE_Y, 0.7); scene.add(mallet);

  camera.position.set(2.4, 2.7, 6.6); camera.lookAt(0, 2.4, 0);

  // --- state ---
  const _proj = new THREE.Vector3(), _fwd = new THREE.Vector3();
  camera.getWorldDirection(_fwd);
  let st = 'ready', cyc = 0, vy = 0, apex = BASE_Y, rung = false, resolved = false;
  let swingsLeft = N_SWINGS, score = 0, streak = 0, done = false, pendingEnd = false;
  let swingClock = 0, kick = 0, tSec = 0; // mallet-swing + screen-kick + attendant clock
  audio.ambientProfile?.('highstriker');
  hud.mode('count'); hud.reticle(false); hud.striker(true); hud.sweet(sweetLo);
  hud.score(0); hud.combo(0); hud.count('SWINGS', swingsLeft); hud.charge(0, false);

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  // triangle meter -> (charge, timing accuracy) as a pure function of the charge-cycle frame
  function swing() {
    const ph = cyc % (2 * RISE);
    const charge = ph <= RISE ? ph / RISE : (2 * RISE - ph) / RISE;
    const d = Math.abs(ph - RISE);                              // frames from the meter peak
    const acc = ACC_MIN + (1 - ACC_MIN) * Math.max(0, 1 - d / T.win);
    return { charge, acc, hot: d <= T.win };
  }
  function launch() {
    const s = swing();
    vy = railImpulse(SWING * T.gain * s.charge * s.acc, mH, T.mP, T.e);
    puck.position.y = BASE_Y; apex = BASE_Y; rung = false; resolved = false;
    st = 'fly'; swingClock = 1; kick = 0.18;
    audio.playSpatial('thud', { x: 0, y: BASE_Y, z: 0 });
  }
  function resolve() {
    resolved = true; swingsLeft--; hud.count('SWINGS', swingsLeft);
    const s = toScreen(puck.position);
    if (rung) {
      streak++; const pts = Math.round(200 * (1 + streak * 0.1)); score += pts;
      hud.pop(s.x, s.y, `BELL! +${pts}`, '#ff2fb0');
      audio.playSpatial('ding', { x: 0, y: bellY, z: 0 }); kick = 0.34; att.react('cheer');
    } else {
      streak = 0;
      const reach = (apex - BASE_Y) / (bellY - BASE_Y); // 0..1 of the way to the bell
      const ring = clamp(Math.floor(reach * 5), 0, 4);
      const pts = ring * 25; score += pts;
      hud.pop(s.x, s.y, ring > 0 ? `RING ${ring} · +${pts}` : 'MISTIMED', ring > 0 ? '#8fddc0' : '#ff4d4d');
      att.react(ring > 2 ? 'nod' : 'shake');
    }
    hud.score(score); hud.combo(streak);
    if (swingsLeft <= 0) pendingEnd = true;
  }

  return {
    step(dt) {
      if (done) return;
      tSec += dt; input.fireQueue.length = 0; // this booth uses hold/release, not the edge-fire queue

      if (st === 'ready') {
        if (input.pressQueue.length) { input.pressQueue.length = 0; cyc = 0; st = 'charge'; }
        input.releaseQueue.length = 0;
      } else if (st === 'charge') {
        cyc++;
        const s = swing(); hud.charge(s.charge, s.hot);
        // release edge, or a release that slipped between substeps -> swing
        if (input.releaseQueue.length || !input.lmb) {
          input.releaseQueue.length = 0; input.pressQueue.length = 0; hud.charge(0, false); launch();
        }
      } else { // 'fly' — 1-D rail integration against gravity + rail friction
        input.pressQueue.length = 0; input.releaseQueue.length = 0;
        const aUp = -(g + T.mu * g), aDn = -(g - T.mu * g); // friction opposes motion both ways
        vy += (!rung && vy > 0 ? aUp : aDn) * dt;
        puck.position.y += vy * dt;
        if (!rung && puck.position.y >= bellY) { puck.position.y = bellY; vy = 0; rung = true; }
        if (puck.position.y > apex) apex = puck.position.y;
        if (!resolved && (rung || vy <= 0)) resolve();
        if (resolved && puck.position.y <= BASE_Y) {
          puck.position.y = BASE_Y; vy = 0;
          if (pendingEnd) return end();
          st = 'ready'; hud.charge(0, false);
        }
      }
    },
    render() {
      audio.listener(camera.position, _fwd);
      // mallet: wind up with charge, snap down on release, ease back to rest
      let ang = -0.25;
      if (st === 'charge') ang = -0.25 - swing().charge * 1.0;
      else if (swingClock > 0) { swingClock++; ang = -1.25 + Math.min(swingClock / 10, 1) * 1.7; if (swingClock > 22) swingClock = 0; }
      mallet.rotation.z += (ang - mallet.rotation.z) * 0.5;
      // brief screen kick on contact (decays; purely cosmetic)
      if (kick > 0.001) { camera.position.x = 2.4 + (Math.random() * 2 - 1) * kick; camera.position.y = 2.7 + (Math.random() * 2 - 1) * kick; kick *= 0.8; }
      else { camera.position.x = 2.4; camera.position.y = 2.7; }
      att.update(tSec, st === 'fly' ? puck.position : null);
    },
    teardown() { done = true; hud.striker(false); hud.mode('time'); att.teardown(); }
  };

  function end() {
    done = true; hud.striker(false); document.exitPointerLock?.();
    ctx.end('BELL', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
