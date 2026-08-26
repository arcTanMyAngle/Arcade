// games/dart.js — Level 3: Balloon Dart Gallery (FPS sniper · ballistic arc · thin hitbox).
// M12: reads only input.frame (lock mode) — Space holds breath (steady), LMB press→release throws,
// RMB scopes. Seeded crosswind gust feeds windDrag. The dart is point-mass in flight, but its long
// axis φ rights toward the velocity angle via aeroPitch (per-tier kA): the SWEPT TIP (p + L_TIP·dir φ)
// does the popping, so a lagging φ on a slow lob shifts the tip and can shave a balloon — honest, not
// cosmetic. Deterministic: aim + throw frames + breath + seeded drift/sway/gust fix the pop set.
import {
  v3, copy, integrate, windDrag, sweptPointSphere, lerpSeg, aeroPitch, mulberry32, G, add
} from '../core/physics.js';
import { K } from '../core/kinetics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';
import { makeBurst } from '../core/fx.js';

// [vThrow, kD drag, rB, driftAmp seed, driftW seed, swayDeg, breathDrain/s, exposure, crosswind, aeroKa]
// low-tier v nudged up a hair (snappier easy rounds; the arc-hold-over skill is preserved by drag/drop).
const TIERS = [
  { v: 34, kD: 0.000, rB: 0.20, dA: 0.0, dW: 0.0, sway: 0.2, drain: 0.25, expo: 1.00, wind: 0.0, kA: 6 },
  { v: 30, kD: 0.003, rB: 0.15, dA: 0.4, dW: 0.8, sway: 0.5, drain: 0.40, expo: 1.00, wind: 0.6, kA: 5 },
  { v: 26, kD: 0.006, rB: 0.11, dA: 0.9, dW: 1.1, sway: 0.9, drain: 0.55, expo: 0.70, wind: 1.2, kA: 4 },
  { v: 21, kD: 0.010, rB: 0.08, dA: 1.6, dW: 1.4, sway: 1.4, drain: 0.70, expo: 0.50, wind: 2.0, kA: 3 },
  { v: 18, kD: 0.016, rB: 0.05, dA: 2.6, dW: 1.7, sway: 2.2, drain: 0.90, expo: 0.35, wind: 3.0, kA: 2 }
];

const BOARD_Z = -13, BAL_Z = -12.8, COLS = 6, ROWS = 4;
const DART_POOL = 12, N_DARTS = 18, L_TIP = 0.17;          // fewer darts = shorter rounds; tip lead = half the 0.34 cone
const FISHTAIL_GAIN = 1.9;                                  // render-only: exaggerate the φ-lag so the fishtail reads
const KICK_AMP = 0.014, KICK_DECAY = 4.5;                  // render-only pop camera kick
const BASE_FOV = 58, SCOPE_FOV = 22;
const STEADY = 0.9, RAMP = 4, REGEN = 0.5; // breath: steadied sway ×(1-STEADY); ramp/regen per s

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0xBA110 ^ (ctx.tier * 2654435761));
  const rngW = mulberry32(0xB1A5 ^ (ctx.tier * 2654435761)); // independent gust seed (keeps balloon layout stable)
  input.setMode('lock');
  const swayRad = T.sway * Math.PI / 180;
  const driftAmp = T.dA * 0.25;               // seed -> meters of lateral swing
  const driftW = 0.6 + T.dW * 0.6;            // seed -> rad/s

  // seeded Lissajous sway phases (deterministic per tier)
  const sph = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];
  // seeded crosswind gust curve (96 knots, lerped, period 2.2s)
  const GUST_P = 2.2, knots = Array.from({ length: 96 }, () => (rngW() * 2 - 1) * T.wind);
  const windX = (t) => { const s = t / GUST_P, i = Math.floor(s) % (knots.length - 1), f = s - Math.floor(s); return knots[i] * (1 - f) + knots[i + 1] * f; };

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0x39ff88, span: 8, back: BOARD_Z - 1 });
  const att = makeAttendant(THREE, scene, { at: [6.2, 0, -1], face: -0.7, hue: 0x2f5a6b, kind: 'attendant', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), mat.wood([84, 60, 40]));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), mat.paint([18, 24, 30]));
  board.position.set(0, 2.4, BOARD_Z - 0.05); board.receiveShadow = true; scene.add(board);
  const rimL = new THREE.PointLight(0x39ff88, 4, 26, 2); rimL.position.set(-7, 3, BOARD_Z + 4); scene.add(rimL);
  camera.position.set(0, 1.7, 3); camera.rotation.set(0, 0, 0, 'YXZ');

  // --- balloons (InstancedMesh: one draw call; egg-skewed latex) ---
  const balGeo = new THREE.SphereGeometry(1, 14, 12);
  const balMat = new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.0 }); // latex sheen
  const inst = new THREE.InstancedMesh(balGeo, balMat, COLS * ROWS);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage); inst.castShadow = true; scene.add(inst);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const hues = [[255, 60, 90], [80, 220, 255], [255, 210, 70], [180, 120, 255], [90, 255, 150], [255, 120, 60]];
  const bals = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    const bx = -4.5 + (9 / (COLS - 1)) * c + (rng() - 0.5) * 0.12; // packed regular, tiny jitter
    const by = 1.2 + (2.4 / (ROWS - 1)) * r + (rng() - 0.5) * 0.1;
    const col = hues[(c + r) % hues.length];
    inst.setColorAt(i, new THREE.Color(col[0] / 255, col[1] / 255, col[2] / 255));
    const skew = 1 + (rng() - 0.5) * 0.14;   // uneven inflation (egg)
    bals.push({ bx, by, x: bx, r: T.rB, phase: rng() * 6.28, skew, alive: true });
  }
  inst.instanceColor.needsUpdate = true;

  // exposure cutouts: cover the left (1-expo) of each balloon; pop only valid on the exposed cap
  if (T.expo < 1) {
    const cw = 2 * T.rB * (1 - T.expo);
    const cutGeo = new THREE.BoxGeometry(cw, T.rB * 3, 0.05), cutMat = mat.metal([40, 44, 50]);
    for (const b of bals) {
      const m = new THREE.Mesh(cutGeo, cutMat);
      m.position.set(b.bx - T.rB + cw / 2, b.by, BAL_Z + 0.12); m.castShadow = true;
      b.cut = m; scene.add(m);
    }
  }
  const popThresh = T.rB * (1 - 2 * T.expo); // local x a hit must exceed to clear the cutout edge

  // --- dart pool (slim cones) ---
  const dGeo = new THREE.ConeGeometry(0.03, 0.34, 8), dMat = mat.metal([210, 214, 220]);
  const darts = Array.from({ length: DART_POOL }, () => {
    const mesh = new THREE.Mesh(dGeo, dMat); mesh.visible = false; scene.add(mesh);
    return { p: v3(), v: v3(), prev: v3(), tipPrev: v3(), phi: 0, mesh, active: false, pops: 0 };
  });

  // --- pop FX: migrated off the hand-rolled shard pool to the shared pooled burst (plan §3.3) ---
  const fx = makeBurst(THREE, scene);

  // --- state + scratch ---
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _vdir = new THREE.Vector3();
  const _acc = {}, _wind = v3(), _bc = v3(), _tip = v3();
  const SWAY_W = 1.3; // base sway frequency (distinct from balloon drift)
  let simTime = 0, score = 0, streak = 0, clusters = 0, dartsLeft = N_DARTS, done = false;
  let armed = false, steady = 0, breath = 1, wasScope = false;
  let kick = 0, camP0 = 0, camY0 = 0;                       // camera kick + base aim (render kick pivots off these)
  audio.ambientProfile?.('dart');
  hud.mode('count'); hud.reticle(true); hud.count('DARTS', dartsLeft);
  hud.score(0); hud.combo(0); hud.breathShow(true); hud.breath(1); hud.wind(0);
  writeMatrices(); // seed instance transforms so balloons appear on frame 1

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  function aimDir(f) { // swayed aim: Lissajous offset, damped by steady-breath, braced by scope
    const a = swayRad * (1 - STEADY * steady) * (f.rmb ? 0.7 : 1);
    const dy = a * (Math.sin(SWAY_W * simTime + sph[0]) * 0.6 + Math.sin(2.1 * simTime + sph[1]) * 0.4);
    const dp = a * (Math.sin(1.7 * simTime + sph[2]) * 0.6 + Math.sin(2.7 * simTime + sph[3]) * 0.4);
    camP0 = f.pitch + dp; camY0 = f.yaw + dy;                // base aim (clean, no kick) → throw dir + render pivot
    camera.rotation.set(camP0, camY0, 0, 'YXZ');
    return camera.getWorldDirection(_fwd);
  }
  function writeMatrices() {
    for (let i = 0; i < bals.length; i++) {
      const b = bals[i]; const sc = b.alive ? b.r : 0;
      _p.set(b.x, b.by, BAL_Z); _q.identity(); _s.set(sc, b.alive ? b.r * b.skew : 0, sc);
      _m.compose(_p, _q, _s); inst.setMatrixAt(i, _m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
  function throwDart(fwd) {
    const d = darts.find((x) => !x.active) || darts[0];
    d.p.x = camera.position.x + fwd.x * 0.4; d.p.y = camera.position.y + fwd.y * 0.4; d.p.z = camera.position.z + fwd.z * 0.4;
    d.v.x = fwd.x * T.v; d.v.y = fwd.y * T.v; d.v.z = fwd.z * T.v;
    copy(d.prev, d.p); d.active = true; d.pops = 0; d.mesh.visible = true;
    const vh = Math.hypot(d.v.x, d.v.z) || 1e-6, cphi = Math.cos(d.phi = Math.atan2(d.v.y, vh));
    d.tipPrev.x = d.p.x + L_TIP * (d.v.x / vh) * cphi; d.tipPrev.y = d.p.y + L_TIP * Math.sin(d.phi); d.tipPrev.z = d.p.z + L_TIP * (d.v.z / vh) * cphi;
    dartsLeft--; hud.count('DARTS', dartsLeft); audio.playSpatial('whoosh', d.p);
  }
  function popBalloon(b, at) {
    b.alive = false; if (b.cut) b.cut.visible = false;
    const bonus = Math.round(0.20 / b.r);                 // smaller balloon -> more points
    const gain = Math.round(100 * bonus * (1 + streak * 0.1)); score += gain; streak++;
    fx.spawn(at, 12, rng, 2.4, 0xffffff); kick = Math.min(1, kick + 0.5);   // pooled shard burst (seeded)
    const s = toScreen(at); hud.pop(s.x, s.y, `POP ×${bonus} +${gain}`, '#ff2fb0');
    audio.playSpatial('pop', at); hud.score(score); hud.combo(streak); att.react('cheer');
  }
  function dartDone(d) {
    d.active = false; d.mesh.visible = false;
    if (d.pops === 0) { streak = 0; hud.combo(0); const s = toScreen(d.p); hud.pop(s.x, s.y, 'MISS', '#ff4d4d'); audio.playSpatial('thock', d.p); att.react('shake'); }
    else if (d.pops >= 2) { clusters++; const g = 150 * (d.pops - 1); score += g; const s = toScreen(d.p); hud.pop(s.x, s.y, `CLUSTER +${g}`, '#39ff88'); hud.score(score); }
    if (dartsLeft <= 0 && !darts.some((x) => x.active)) end();
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt;
      kick = Math.max(0, kick - dt * KICK_DECAY); fx.step(dt);
      const f = input.frame;
      _wind.x = windX(simTime);

      // scope zoom (RMB held)
      const sc = !!f.rmb;
      if (sc !== wasScope) { camera.fov = sc ? SCOPE_FOV : BASE_FOV; camera.updateProjectionMatrix(); hud.scope(sc); wasScope = sc; }

      // breath (Space): hold to steady sway, drains meter; empty ⇒ can't steady
      const spaceHeld = (f.keys & K.SPACE) !== 0, inhale = spaceHeld && breath > 0.001;
      if (inhale) { steady = Math.min(steady + dt * RAMP, 1); breath = Math.max(0, breath - T.drain * dt); }
      else { steady = Math.max(steady - dt * RAMP, 0); if (!spaceHeld) breath = Math.min(1, breath + REGEN * dt); }
      if ((f.keyPress & K.SPACE) && breath > 0.001) audio.playSpatial('breath', camera.position);
      hud.breath(breath);

      const fwd = aimDir(f);
      // LMB press→release throws at the (steadied) aim
      if (f.press) armed = true;
      if (f.release) { if (armed && dartsLeft > 0) throwDart(fwd); armed = false; }

      // balloon drift (deterministic sine)
      for (const b of bals) if (b.alive && driftAmp > 0) b.x = b.bx + driftAmp * Math.sin(driftW * simTime + b.phase);

      // darts: integrate + aero pitch-over → swept tip vs balloon spheres + board near-miss
      for (const d of darts) {
        if (!d.active) continue;
        copy(d.prev, d.p);
        add(G, windDrag(d.v, _wind, T.kD, _acc), _acc); // gravity + crosswind quadratic drag
        integrate(d.p, d.v, _acc, dt);
        d.mesh.position.set(d.p.x, d.p.y, d.p.z);

        // aero pitch-over: φ rights toward the velocity angle θv; tip leads the center along φ
        const sp = Math.hypot(d.v.x, d.v.y, d.v.z), vh = Math.hypot(d.v.x, d.v.z) || 1e-6, thV = Math.atan2(d.v.y, vh);
        d.phi = aeroPitch(d.phi, thV, sp, T.kA, dt);
        const cphi = Math.cos(d.phi), tdx = (d.v.x / vh) * cphi, tdy = Math.sin(d.phi), tdz = (d.v.z / vh) * cphi;
        _tip.x = d.p.x + L_TIP * tdx; _tip.y = d.p.y + L_TIP * tdy; _tip.z = d.p.z + L_TIP * tdz;  // true-φ swept tip (physics)
        // render-only: exaggerate the nose-lag (φ−θv) so the physical fishtail is legible; pop test stays true-φ
        const phiR = thV + (d.phi - thV) * FISHTAIL_GAIN, cR = Math.cos(phiR);
        d.mesh.quaternion.setFromUnitVectors(_up, _vdir.set((d.v.x / vh) * cR, Math.sin(phiR), (d.v.z / vh) * cR));

        // pop every balloon whose sphere the swept tip crosses this substep (cluster-capable)
        for (const b of bals) {
          if (!b.alive) continue;
          _bc.x = b.x; _bc.y = b.by; _bc.z = BAL_Z;
          const t = sweptPointSphere(d.tipPrev, _tip, _bc, b.r);
          if (t < 0) continue;
          const h = lerpSeg(d.tipPrev, _tip, t);
          if (h.x - b.x < popThresh) continue;  // blocked by the cutout cap -> not a valid pop
          popBalloon(b, h); d.pops++;
        }
        copy(d.tipPrev, _tip);
        // hit the board, or fell to the floor (short lob) -> resolve (near-miss in dartDone)
        if (d.active && (d.p.z <= BOARD_Z || d.p.y <= 0.05)) dartDone(d);
      }

      // respawn wave when the board is cleared (keep throwing until darts run out)
      if (dartsLeft > 0 && bals.every((b) => !b.alive)) for (const b of bals) { b.alive = true; b.phase = (b.phase + 1.3) % 6.28; if (b.cut) b.cut.visible = true; }

      writeMatrices();
      hud.combo(streak); hud.wind(_wind.x);
    },
    render() {
      // render-only camera kick: re-derive rotation from the clean base each frame (step overwrites it),
      // so it never feeds the throw direction — the sim/score/replay hash stay intact.
      const s = kick * KICK_AMP;
      camera.rotation.set(camP0 + s * Math.sin(simTime * 41), camY0 + s * 0.7 * Math.sin(simTime * 33 + 1.7), s * 0.5 * Math.sin(simTime * 27 + 0.6), 'YXZ');
      camera.getWorldDirection(_fwd); audio.listener(camera.position, _fwd);
      const d = darts.find((x) => x.active); att.update(simTime, d ? d.p : null);
    },
    teardown() { done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix(); hud.scope(false); hud.breathShow(false); fx.teardown(); att.teardown(); }
  };

  function end() {
    done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix();
    hud.scope(false); hud.breathShow(false); document.exitPointerLock?.();
    ctx.end('DARTS OUT', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`, { score, stats: { clusters } });
  }
}
