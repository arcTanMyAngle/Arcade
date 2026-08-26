// games/shooting.js — Level 1: TARGET PLINKER (rifle · Z-lanes · honest hinge torque).
// FIRST booth on the kinetic layer: reads only input.frame (lock mode). Aim = frame yaw/pitch +
// seeded Lissajous sway; LMB edge (frame.press) fires; RMB (frame.rmb) scopes; Space (K.SPACE) holds
// breath to damp sway. Plates are hinged knock-down rods scored on KNOCKDOWN, not ring value: a
// bullet's momentum J=mB·|v| at hit-height h imparts ω=hingeKick; hingeStep topples it past break-over
// or rocks it back — heavier/taller plates demand center-mass speed and a high hit. Zero Math.random.
import {
  v3, copy, integrate, windDrag, segCrossPlaneZ, lerpSeg, mulberry32, G, add, len, clamp,
  hingeKick, hingeStep
} from '../core/physics.js';
import { K } from '../core/kinetics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';
import { makeBurst } from '../core/fx.js';

// [vMuzzle, dragK, windAmp, round s, per-lane drift amp[3], per-lane drift omega[3], sway°, breathDrain/s]
// round trimmed ~15% from M12 (60/50/45/40/35) for snappier rounds — honest, pacing only.
const TIERS = [
  { vMuzzle: 120, k: 0.000, wind: 0.0, round: 50, laneAmp: [0.0, 0.0, 0.0], laneOmega: [0.0, 0.0, 0.0], sway: 0.15, drain: 0.25 },
  { vMuzzle: 110, k: 0.004, wind: 1.0, round: 42, laneAmp: [0.4, 0.7, 1.0], laneOmega: [0.5, 0.7, 0.9], sway: 0.30, drain: 0.40 },
  { vMuzzle: 100, k: 0.008, wind: 2.5, round: 38, laneAmp: [0.7, 1.1, 1.6], laneOmega: [0.6, 0.9, 1.2], sway: 0.50, drain: 0.55 },
  { vMuzzle: 92,  k: 0.014, wind: 4.0, round: 34, laneAmp: [1.0, 1.5, 2.2], laneOmega: [0.8, 1.1, 1.4], sway: 0.70, drain: 0.70 },
  { vMuzzle: 85,  k: 0.020, wind: 6.0, round: 30, laneAmp: [1.4, 2.0, 3.0], laneOmega: [1.0, 1.3, 1.6], sway: 0.90, drain: 0.90 }
];

// Z-lanes: farther = higher multiplier + heavier plate. y0 staggered up so far plates peek over near.
const TYPES = {
  tin:  { m: 0.4, H: 0.30, W: 0.50, pts: 20,  make: () => mat.paint([206, 210, 206]) },
  iron: { m: 2.2, H: 0.34, W: 0.56, pts: 60,  make: () => mat.metal([92, 98, 106]) },
  gong: { m: 5.0, H: 0.40, W: 0.72, pts: 150, make: () => mat.metal([198, 150, 54]) }
};
const LANES = [
  { z: -10, mul: 1, type: 'tin',  y0: 1.00, xs: [-3.0, 0, 3.0] },
  { z: -16, mul: 2, type: 'iron', y0: 1.35, xs: [-4.2, 0, 4.2] },
  { z: -22, mul: 3, type: 'gong', y0: 1.70, xs: [-5.4, 0, 5.4] }
];
const WALL_Z = -24, POOL = 40, RESPAWN = 0.9;
const BULLET_M = 0.008, HINGE_DAMP = 1.2, BULL_ARM = 0.85; // hit in top 15% of plate height = bull
const BASE_FOV = 58, SCOPE_FOV = 30;
const STEADY = 0.9, RAMP = 4, REGEN = 0.5;
const KICK_AMP = 0.014, KICK_DECAY = 4.5;                  // render-only impact camera kick

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0x5EED ^ (ctx.tier * 2654435761));
  input.setMode('lock');
  const swayRad = T.sway * Math.PI / 180;

  // deterministic gust curve: 96 seeded knots, lerped, period 2.2s
  const GUST_P = 2.2, knots = Array.from({ length: 96 }, () => (rng() * 2 - 1) * T.wind);
  const windX = (t) => {
    const s = t / GUST_P, i = Math.floor(s) % (knots.length - 1), f = s - Math.floor(s);
    return knots[i] * (1 - f) + knots[i + 1] * f;
  };
  // seeded Lissajous sway phases
  const sph = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0x39ff88, span: 9, back: WALL_Z });
  const att = makeAttendant(THREE, scene, { at: [7.2, 0, -3], face: -0.7, hue: 0x2f5a6b, kind: 'barker', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat.wood([90, 64, 40]));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(48, 14), mat.paint([26, 30, 28]));
  back.position.set(0, 5, WALL_Z - 0.3); back.receiveShadow = true; scene.add(back);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(16, 1, 1.2), mat.metal());
  counter.position.set(0, 1.0, 0.6); counter.castShadow = true; scene.add(counter);
  camera.position.set(0, 1.7, 2); camera.rotation.set(0, 0, 0, 'YXZ');

  // --- plates: one hinged rod per slot, grouped by lane ---
  const bullMat = mat.emissive(0xff2fb0, 2.4);
  const plates = [];
  LANES.forEach((ln, li) => {
    const ty = TYPES[ln.type], geo = new THREE.BoxGeometry(ty.W, ty.H, 0.045);
    ln.xs.forEach((bx, pi) => {
      const grp = new THREE.Group();
      const disc = new THREE.Mesh(geo, ty.make()); disc.position.y = ty.H / 2; disc.castShadow = true; grp.add(disc);
      const bull = new THREE.Mesh(new THREE.CircleGeometry(ty.W * 0.16, 16), bullMat);
      bull.position.set(0, ty.H * 0.9, 0.03); grp.add(bull);           // top-edge = max torque arm
      grp.position.set(bx, ln.y0, ln.z); uncannySkew(grp, li * 3 + pi, 0.05); scene.add(grp);
      plates.push({ grp, lane: li, ln, ty, baseX: bx, x: bx, phase: rng() * Math.PI * 2,
        th: 0, om: 0, alive: true, fallen: false, respawnAt: 0, maxArm: 0 });
    });
  });

  // --- bullet pool ---
  const bGeo = new THREE.SphereGeometry(0.03, 8, 6), bMat = mat.emissive(0xfff2a0, 3);
  const bullets = Array.from({ length: POOL }, () => {
    const mesh = new THREE.Mesh(bGeo, bMat); mesh.visible = false; scene.add(mesh);
    return { p: v3(), v: v3(), prev: v3(), mesh, active: false };
  });
  const spawnBullet = (fwd) => {
    const b = bullets.find((x) => !x.active) || bullets[0];
    b.p.x = camera.position.x + fwd.x * 0.3; b.p.y = camera.position.y + fwd.y * 0.3; b.p.z = camera.position.z + fwd.z * 0.3;
    b.v.x = fwd.x * T.vMuzzle; b.v.y = fwd.y * T.vMuzzle; b.v.z = fwd.z * T.vMuzzle;
    copy(b.prev, b.p); b.active = true; b.mesh.visible = true;
  };

  // --- scratch + state ---
  const fx = makeBurst(THREE, scene);                       // pooled impact FX (seeded, visual-only)
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3(), _acc = {}, _wind = v3();
  let simTime = 0, score = 0, streak = 0, bulls = 0, heavies = 0, done = false;
  let steady = 0, breath = 1, wasScope = false, prevSpace = false;
  let kick = 0, camP0 = 0, camY0 = 0;                       // camera kick + base aim (render kick pivots off these)
  audio.ambientProfile?.('shooting');
  hud.mode('time'); hud.reticle(true); hud.wind(0); hud.score(0); hud.combo(0);
  hud.breathShow(true); hud.breath(1);

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  function hitPlate(pl, b, h) {
    const arm = clamp(h.y - pl.ln.y0, 0.02, pl.ty.H);      // torque arm above the hinge
    pl.om += hingeKick(BULLET_M * len(b.v), arm, pl.ty.m, pl.ty.H);
    pl.maxArm = Math.max(pl.maxArm, arm / pl.ty.H);
    // survived-hit read: small amber SPARK + dry ping. A knockdown reads as a big burst + bell —
    // so "hit but standing" (need a higher/harder hit) is legible against a clean drop.
    fx.spawn(h, 5, rng, 1.6, 0xffe08f); kick = Math.min(1, kick + 0.18);
    audio.playSpatial('ping', h, { freq: 500 + arm * 600 });
  }
  function knockdown(pl) {
    pl.alive = false; pl.fallen = true; pl.respawnAt = simTime + RESPAWN;
    streak++; const gain = Math.round(pl.ty.pts * pl.ln.mul * (1 + streak * 0.1)); score += gain;
    if (pl.ln.type !== 'tin') heavies++;
    const bull = pl.maxArm >= BULL_ARM; if (bull) bulls++;
    const top = { x: pl.x, y: pl.ln.y0 + pl.ty.H, z: pl.ln.z }, s = toScreen(top);
    fx.spawn(top, 14, rng, 3.4, bull ? 0xff2fb0 : 0x39ff88); kick = Math.min(1, kick + 0.6);
    hud.pop(s.x, s.y, `${pl.ln.type.toUpperCase()} +${gain}`, bull ? '#ff2fb0' : '#39ff88');
    audio.playSpatial('ding', top, { freq: 300 + pl.ln.mul * 120 });
    hud.score(score); hud.combo(streak); att.react(pl.ln.mul >= 2 ? 'cheer' : 'nod');
  }
  function miss(at) {
    streak = 0; hud.combo(0); const s = toScreen(at);
    hud.pop(s.x, s.y, 'MISS', '#ff4d4d'); audio.playSpatial('thock', at); att.react('shake');
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt;
      kick = Math.max(0, kick - dt * KICK_DECAY); fx.step(dt);
      if (simTime >= T.round) { end(); return; }
      const f = input.frame;
      _wind.x = windX(simTime);

      // scope zoom (RMB held)
      const sc = !!f.rmb;
      if (sc !== wasScope) { camera.fov = sc ? SCOPE_FOV : BASE_FOV; camera.updateProjectionMatrix(); hud.scope(sc); wasScope = sc; }

      // breath: hold Space to steady sway (drains meter; empty ⇒ can't steady)
      const space = (f.keys & K.SPACE) !== 0 && breath > 0.001;
      if (space) { steady = Math.min(steady + dt * RAMP, 1); breath = Math.max(0, breath - T.drain * dt); }
      else { steady = Math.max(steady - dt * RAMP, 0); if (!(f.keys & K.SPACE)) breath = Math.min(1, breath + REGEN * dt); }
      if ((f.keyPress & K.SPACE) && breath > 0.001) audio.playSpatial('breath', camera.position);
      prevSpace = space; hud.breath(breath);

      // swayed aim (Lissajous, damped by steady, braced by scope)
      const a = swayRad * (1 - STEADY * steady) * (sc ? 0.7 : 1);
      const dy = a * (Math.sin(1.3 * simTime + sph[0]) * 0.6 + Math.sin(2.1 * simTime + sph[1]) * 0.4);
      const dp = a * (Math.sin(1.7 * simTime + sph[2]) * 0.6 + Math.sin(2.7 * simTime + sph[3]) * 0.4);
      camP0 = f.pitch + dp; camY0 = f.yaw + dy;              // base aim (clean, no kick) → firing dir + render pivot
      camera.rotation.set(camP0, camY0, 0, 'YXZ');
      camera.getWorldDirection(_fwd);

      // fire (LMB edges this substep)
      for (let i = 0; i < f.press; i++) { spawnBullet(_fwd); audio.playSpatial('crack', null); }

      // plates: drift + topple (alive) or respawn (fallen)
      for (const pl of plates) {
        if (pl.fallen) {
          if (simTime >= pl.respawnAt) { pl.th = 0; pl.om = 0; pl.alive = true; pl.fallen = false; pl.maxArm = 0; pl.phase = (pl.phase + 1.7) % (Math.PI * 2); }
        } else {
          pl.x = pl.baseX + T.laneAmp[pl.lane] * Math.sin(T.laneOmega[pl.lane] * simTime + pl.phase);
          if (hingeStep(pl, pl.ty.m, pl.ty.H, HINGE_DAMP, dt)) knockdown(pl);
        }
        pl.grp.position.x = pl.x; pl.grp.rotation.x = -pl.th;         // −th tips the top away from the shooter
      }

      // bullets
      for (const b of bullets) {
        if (!b.active) continue;
        copy(b.prev, b.p);
        add(G, windDrag(b.v, _wind, T.k, _acc), _acc);               // a = g + wind drag
        integrate(b.p, b.v, _acc, dt);
        b.mesh.position.set(b.p.x, b.p.y, b.p.z);
        for (let li = 0; li < LANES.length; li++) {                  // crossing a lane plane (travelling −z)
          const ln = LANES[li];
          if (b.prev.z > ln.z && b.p.z <= ln.z) {
            const t = segCrossPlaneZ(b.prev, b.p, ln.z), h = lerpSeg(b.prev, b.p, t);
            let best = null, bestDx = Infinity;
            for (const pl of plates) {
              if (pl.lane !== li || !pl.alive) continue;
              const dx = Math.abs(h.x - pl.x);
              if (dx <= pl.ty.W / 2 && h.y >= ln.y0 && h.y <= ln.y0 + pl.ty.H && dx < bestDx) { bestDx = dx; best = pl; }
            }
            if (best) { hitPlate(best, b, h); b.active = false; b.mesh.visible = false; break; }
          }
        }
        if (b.active && b.p.z <= WALL_Z) { b.active = false; b.mesh.visible = false; miss(b.p); }
      }

      hud.time(T.round - simTime); hud.wind(_wind.x);
    },
    render() {
      // render-only camera kick: re-derive rotation from the clean base each frame (step overwrites it) —
      // never feeds the firing direction, so the ?dev=1 replay hash + score are unaffected.
      const s = kick * KICK_AMP;
      camera.rotation.set(camP0 + s * Math.sin(simTime * 41), camY0 + s * 0.7 * Math.sin(simTime * 33 + 1.7), s * 0.5 * Math.sin(simTime * 27 + 0.6), 'YXZ');
      camera.getWorldDirection(_fwd); audio.listener(camera.position, _fwd);
      const b = bullets.find((x) => x.active); att.update(simTime, b ? b.p : null);
    },
    teardown() { done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix(); hud.scope(false); hud.breathShow(false); fx.teardown(); att.teardown(); }
  };

  function end() {
    done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix();
    hud.scope(false); hud.breathShow(false); document.exitPointerLock?.();
    ctx.end('ROUND OVER', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`, { score, stats: { bulls, heavies } });
  }
}
