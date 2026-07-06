// games/dart.js — Level 3: Balloon Dart Gallery (FPS sniper · ballistic arc · thin hitbox).
// Deterministic: aim + throw frames + breath log + seeded drift/sway fully determine the pop set.
// Dart is a SLOW gravity+drag projectile (not hit-scan); the tip must sweep across a balloon
// sphere to pop it (sweptPointSphere) — no body-overlap fudge. Partial exposure = a real cut cap.
import {
  v3, copy, integrate, windDrag, sweptPointSphere, lerpSeg, mulberry32, G, add
} from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [vThrow, kD drag, rB, driftAmp seed, driftW seed, swayDeg, breathDrain(/s), exposure]
const TIERS = [
  { v: 30, kD: 0.000, rB: 0.20, dA: 0.0, dW: 0.0, sway: 0.2, drain: 0.25, expo: 1.00 },
  { v: 27, kD: 0.003, rB: 0.15, dA: 0.4, dW: 0.8, sway: 0.5, drain: 0.40, expo: 1.00 },
  { v: 24, kD: 0.006, rB: 0.11, dA: 0.9, dW: 1.1, sway: 0.9, drain: 0.55, expo: 0.70 },
  { v: 21, kD: 0.010, rB: 0.08, dA: 1.6, dW: 1.4, sway: 1.4, drain: 0.70, expo: 0.50 },
  { v: 18, kD: 0.016, rB: 0.05, dA: 2.6, dW: 1.7, sway: 2.2, drain: 0.90, expo: 0.35 }
];

const BOARD_Z = -13, BAL_Z = -12.8, COLS = 6, ROWS = 4;
const DART_POOL = 12, SHARDS = 80, N_DARTS = 25;
const BASE_FOV = 58, SCOPE_FOV = 22;
const STEADY = 0.9, RAMP = 4, REGEN = 0.5; // breath: steadied sway ×(1-STEADY); ramp/regen per s

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0xBA110 ^ (ctx.tier * 2654435761));
  const swayRad = T.sway * Math.PI / 180;
  const driftAmp = T.dA * 0.25;               // seed -> meters of lateral swing
  const driftW = 0.6 + T.dW * 0.6;            // seed -> rad/s

  // seeded Lissajous sway phases (deterministic per tier)
  const sph = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];

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
    return { p: v3(), v: v3(), prev: v3(), mesh, active: false, pops: 0 };
  });

  // --- shard pool for pops (deterministic spread from rng) ---
  const shGeo = new THREE.TetrahedronGeometry(0.04), shMat = mat.emissive(0xffffff, 1.2);
  const shards = Array.from({ length: SHARDS }, () => {
    const mesh = new THREE.Mesh(shGeo, shMat); mesh.visible = false; scene.add(mesh);
    return { p: v3(), v: v3(), mesh, life: 0 };
  });
  let shHead = 0;
  function burst(at) { // 10 shards, deterministic spherical spread from the seeded rng
    for (let k = 0; k < 10; k++) {
      const s = shards[shHead]; shHead = (shHead + 1) % SHARDS;
      copy(s.p, at);
      const th = rng() * 6.28, ph = rng() * 3.14, sp = 1.5 + rng() * 2;
      s.v.x = Math.sin(ph) * Math.cos(th) * sp; s.v.y = Math.cos(ph) * sp; s.v.z = Math.sin(ph) * Math.sin(th) * sp;
      s.life = 0.5; s.mesh.visible = true; s.mesh.scale.setScalar(1);
    }
  }

  // --- state + scratch (module-free of per-frame GC) ---
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _vdir = new THREE.Vector3();
  const _acc = {}, _zero = v3(), _bc = v3();
  const SWAY_W = 1.3; // base sway frequency (distinct from balloon drift)
  let simTime = 0, score = 0, streak = 0, dartsLeft = N_DARTS, done = false;
  let holding = false, steady = 0, breath = 1, wasScope = false, prevInhale = false;
  audio.ambientProfile?.('dart');
  hud.mode('count'); hud.reticle(true); hud.count('DARTS', dartsLeft);
  hud.score(0); hud.combo(0); hud.breathShow(true); hud.breath(1);
  writeMatrices(); // seed instance transforms so balloons appear on frame 1

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  function aimDir() { // swayed aim: Lissajous offset, damped by steady-breath, braced by scope
    const a = swayRad * (1 - STEADY * steady) * (input.scope ? 0.7 : 1);
    const dy = a * (Math.sin(SWAY_W * simTime + sph[0]) * 0.6 + Math.sin(2.1 * simTime + sph[1]) * 0.4);
    const dp = a * (Math.sin(1.7 * simTime + sph[2]) * 0.6 + Math.sin(2.7 * simTime + sph[3]) * 0.4);
    camera.rotation.set(input.pitch + dp, input.yaw + dy, 0, 'YXZ');
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
    dartsLeft--; hud.count('DARTS', dartsLeft);
    audio.playSpatial('whoosh', d.p);
  }
  function popBalloon(b, at) {
    b.alive = false; if (b.cut) b.cut.visible = false;
    const bonus = Math.round(0.20 / b.r);                 // smaller balloon -> more points
    const gain = Math.round(100 * bonus * (1 + streak * 0.1)); score += gain; streak++;
    burst(at);
    const s = toScreen(at); hud.pop(s.x, s.y, `POP ×${bonus} +${gain}`, '#ff2fb0');
    audio.playSpatial('pop', at); hud.score(score); hud.combo(streak); att.react('cheer');
  }
  function dartDone(d) {
    d.active = false; d.mesh.visible = false;
    if (d.pops === 0) { streak = 0; hud.combo(0); const s = toScreen(d.p); hud.pop(s.x, s.y, 'MISS', '#ff4d4d'); audio.playSpatial('thock', d.p); att.react('shake'); }
    else if (d.pops >= 2) { const g = 150 * (d.pops - 1); score += g; const s = toScreen(d.p); hud.pop(s.x, s.y, `CLUSTER +${g}`, '#39ff88'); hud.score(score); }
    if (dartsLeft <= 0 && !darts.some((x) => x.active)) end();
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt;
      input.fireQueue.length = 0; // hold(breath)/release(throw), not edge-fire

      // scope zoom
      if (input.scope !== wasScope) { camera.fov = input.scope ? SCOPE_FOV : BASE_FOV; camera.updateProjectionMatrix(); hud.scope(input.scope); wasScope = input.scope; }

      // breath / steady (LMB hold steadies sway, drains meter; empty -> can't hold)
      if (input.pressQueue.length && dartsLeft > 0) { input.pressQueue.length = 0; holding = true; }
      if (holding && breath > 0.001) { steady = Math.min(steady + dt * RAMP, 1); breath = Math.max(0, breath - T.drain * dt); }
      else { steady = Math.max(steady - dt * RAMP, 0); if (!holding) breath = Math.min(1, breath + REGEN * dt); }
      const inhale = holding && breath > 0.001;
      if (inhale && !prevInhale) audio.playSpatial('breath', camera.position); // isolated cue on hold start
      prevInhale = inhale;
      hud.breath(breath);

      const fwd = aimDir();
      // release -> throw at the (steadied) aim
      if (input.releaseQueue.length) {
        input.releaseQueue.length = 0;
        if (holding && dartsLeft > 0) throwDart(fwd);
        holding = false;
      }

      // balloon drift (deterministic sine)
      for (const b of bals) if (b.alive && driftAmp > 0) b.x = b.bx + driftAmp * Math.sin(driftW * simTime + b.phase);

      // darts: integrate + swept tip vs balloon spheres + board near-miss
      for (const d of darts) {
        if (!d.active) continue;
        copy(d.prev, d.p);
        add(G, windDrag(d.v, _zero, T.kD, _acc), _acc); // gravity + light quadratic drag
        integrate(d.p, d.v, _acc, dt);
        d.mesh.position.set(d.p.x, d.p.y, d.p.z);
        d.mesh.quaternion.setFromUnitVectors(_up, _vdir.set(d.v.x, d.v.y, d.v.z).normalize()); // nose along velocity

        // pop every balloon whose sphere the tip sweeps this substep (cluster-capable)
        for (const b of bals) {
          if (!b.alive) continue;
          _bc.x = b.x; _bc.y = b.by; _bc.z = BAL_Z;
          const t = sweptPointSphere(d.prev, d.p, _bc, b.r);
          if (t < 0) continue;
          const h = lerpSeg(d.prev, d.p, t);
          if (h.x - b.x < popThresh) continue;  // blocked by the cutout cap -> not a valid pop
          popBalloon(b, h); d.pops++;
        }
        // hit the board, or fell to the floor (short lob) -> resolve (near-miss in dartDone)
        if (d.active && (d.p.z <= BOARD_Z || d.p.y <= 0.05)) dartDone(d);
      }

      // respawn wave when the board is cleared (keep throwing until darts run out)
      if (dartsLeft > 0 && bals.every((b) => !b.alive)) for (const b of bals) { b.alive = true; b.phase = (b.phase + 1.3) % 6.28; if (b.cut) b.cut.visible = true; }

      // shards
      for (const s of shards) {
        if (s.life <= 0) continue;
        s.life -= dt; if (s.life <= 0) { s.mesh.visible = false; continue; }
        s.v.y += G.y * dt; s.p.x += s.v.x * dt; s.p.y += s.v.y * dt; s.p.z += s.v.z * dt;
        s.mesh.position.set(s.p.x, s.p.y, s.p.z); s.mesh.scale.setScalar(Math.max(0.01, s.life * 2));
      }

      writeMatrices();
      hud.combo(streak);
    },
    render() { audio.listener(camera.position, _fwd); const d = darts.find((x) => x.active); att.update(simTime, d ? d.p : null); },
    teardown() { done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix(); hud.scope(false); hud.breathShow(false); att.teardown(); }
  };

  function end() {
    done = true; camera.fov = BASE_FOV; camera.updateProjectionMatrix();
    hud.scope(false); hud.breathShow(false); document.exitPointerLock?.();
    ctx.end('DARTS OUT', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
