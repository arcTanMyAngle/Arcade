// games/skeeball.js — Level 6: Skee-Ball (incline roll · lip-launch · ring drop). FINAL booth.
// Deterministic: (roll speed, lateral) fully determine the landing ring. No random.
// Roll: along-surface decel a = g·sinθ + μr·g·cosθ (climb) / μr·g (flat). Ball leaves the surface
// at the lip crest with the ramp's velocity (vy = f·tanθ + lip kick) → projectile → drops into a ring.
// Playability: launch speed is AUTO-TUNED per tier (binary search on the pure sim) so power sweeps
// the ring layout front→back, and a live predicted-landing marker shows where the shot will drop.
import { v3, copy, integrate, sphereTorus, resolveBallContact, G } from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [ramp θ°, ramp μr, lip height, flat μr, ring-radius scale, rail eW]
const TIERS = [
  { th: 26, muR: 0.020, lip: 0.02, muF: 0.015, sc: 1.00, eW: 0.30 },
  { th: 29, muR: 0.024, lip: 0.03, muF: 0.018, sc: 0.92, eW: 0.30 },
  { th: 32, muR: 0.028, lip: 0.04, muF: 0.022, sc: 0.84, eW: 0.35 },
  { th: 35, muR: 0.033, lip: 0.05, muF: 0.026, sc: 0.76, eW: 0.40 },
  { th: 38, muR: 0.040, lip: 0.06, muF: 0.030, sc: 0.68, eW: 0.45 }
];
// [x, z, baseR, value] — all at the same low aperture height so the descending arc drops through one
const RING_Y = 0.14;
const RINGS = [
  [0, -4.2, 0.34, 10], [0, -4.8, 0.27, 20], [0, -5.4, 0.22, 30], [0, -5.9, 0.18, 40],
  [0, -6.4, 0.15, 50], [-0.5, -6.9, 0.11, 100], [0.5, -6.9, 0.11, 100]
];

const bR = 0.05, BALL_M = 0.2, N_BALLS = 9, dt = 1 / 60;
const Z_FLAT_END = -2.0, Z_LIP = -2.6, RAIL = 0.62, Z_BACK = -7.5;
const POWER_FR = 46, RING_TUBE = 0.016, RING_E = 0.4, RING_MU = 0.4;
const FIXED_PITCH = -0.12, YAW_CLAMP = 0.32;

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const g = -G.y, th = T.th * Math.PI / 180, tanT = Math.tan(th), cosT = Math.cos(th), sinT = Math.sin(th);
  const lipY = bR + (Z_FLAT_END - Z_LIP) * tanT, lipKick = Math.sqrt(2 * g * T.lip);
  const rings = RINGS.map(([x, z, r, v]) => ({ x, y: RING_Y, z, r: r * T.sc, v }));

  const surfaceY = (z) => z >= Z_FLAT_END ? bR : bR + (Z_FLAT_END - z) * tanT;
  // pure roll→lip→fly forward sim (shared by tuning + the aim marker) → landing {x,z,stall}
  function rollFly(f0, lv) {
    let z = -0.1, x = 0, f = f0, l = lv;
    for (let i = 0; i < 3000 && z > Z_LIP && f > 0.05; i++) {
      const onRamp = z <= Z_FLAT_END, aF = onRamp ? (g * sinT + T.muR * g * cosT) * cosT : T.muF * g;
      f = Math.max(0, f - aF * dt);
      const la = T.muF * g * dt; l = Math.abs(l) <= la ? 0 : l - Math.sign(l) * la;
      z -= f * dt; x += l * dt;
      if (Math.abs(x) > RAIL) { x = Math.sign(x) * RAIL; l = -l * T.eW; }
    }
    if (f <= 0.05) return { x, z, stall: true };
    let px = x, py = lipY, pz = z, vx = l, vy = f * tanT + lipKick, vz = -f;
    for (let i = 0; i < 1500 && py >= bR; i++) {
      vy += G.y * dt; px += vx * dt; py += vy * dt; pz += vz * dt;
      if (Math.abs(px) > RAIL) { px = Math.sign(px) * RAIL; vx = -vx * T.eW; }
    }
    return { x: px, z: pz, stall: false };
  }
  // auto-tune: min power lands at the front ring, max power just past the back corner
  const findV = (targetZ) => { let lo = 2.5, hi = 13; for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2, r = rollFly(m, 0); const lz = r.stall ? Z_LIP : r.z; if (lz > targetZ) lo = m; else hi = m; } return (lo + hi) / 2; };
  const MINV = findV(-4.15), MAXV = findV(-7.2);

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0x39ff88, span: 5, back: Z_BACK - 0.5 });
  const room = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat.wood([70, 52, 34]));
  room.rotation.x = -Math.PI / 2; room.receiveShadow = true; scene.add(room);
  const laneMat = mat.wood([175, 124, 68]); laneMat.roughness = 0.36;
  const flat = new THREE.Mesh(new THREE.BoxGeometry(2 * RAIL, 0.1, 2.4), laneMat);
  flat.position.set(0, bR - 0.05, (0.3 + Z_FLAT_END) / 2); flat.receiveShadow = true; scene.add(flat);
  const rampLen = (Z_FLAT_END - Z_LIP) / cosT, ramp = new THREE.Mesh(new THREE.BoxGeometry(2 * RAIL, 0.1, rampLen), laneMat);
  ramp.position.set(0, surfaceY((Z_FLAT_END + Z_LIP) / 2) - 0.05 * cosT, (Z_FLAT_END + Z_LIP) / 2);
  ramp.rotation.x = -th; ramp.receiveShadow = true; scene.add(ramp);
  // scoring apron (recessed tray) + side rails run the whole lane
  const apron = new THREE.Mesh(new THREE.BoxGeometry(2 * RAIL, 0.08, 4.0), mat.wood([120, 92, 52]));
  apron.position.set(0, bR - 0.06, -5.5); apron.receiveShadow = true; scene.add(apron);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 8.2), mat.metal([150, 154, 160]));
    rail.position.set(sx * RAIL, 0.17, -3.4); rail.castShadow = true; scene.add(rail);
  }
  const backboard = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.4), mat.paint([16, 24, 20]));
  backboard.position.set(0, 1.0, Z_BACK - 0.1); scene.add(backboard);

  // ring targets: neon tori + recessed cups + a value pip stack (count = value/10, capped)
  for (const rg of rings) {
    const hot = rg.v === 100, col = hot ? 0xff2fb0 : 0x39ff88;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(rg.r, RING_TUBE, 10, 30), mat.emissive(col, 2.4));
    torus.position.set(rg.x, rg.y, rg.z); torus.rotation.x = Math.PI / 2; uncannySkew(torus, rg.v, 0.04); scene.add(torus);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(rg.r, rg.r * 0.6, 0.22, 18, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x081109, roughness: 0.95, side: THREE.DoubleSide }));
    cup.position.set(rg.x, rg.y - 0.12, rg.z); scene.add(cup);
    const pips = Math.min(hot ? 10 : rg.v / 10, 10);            // stacked value markers behind the cup
    for (let k = 0; k < pips; k++) { const pip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.01), mat.emissive(col, 1.6)); pip.position.set(rg.x - 0.24 + (k % 5) * 0.06, 0.4 + Math.floor(k / 5) * 0.07, rg.z - 0.02); scene.add(pip); }
  }
  // aim / predicted-landing marker
  const marker = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.012, 8, 24), mat.emissive(0x8fffe0, 3));
  marker.rotation.x = Math.PI / 2; marker.visible = false; scene.add(marker);

  camera.position.set(0, 1.05, 1.5); camera.rotation.set(FIXED_PITCH, 0, 0, 'YXZ');
  input.pitch = FIXED_PITCH; input.yaw = 0;

  // attendant: a lane-side watcher who tracks the ball
  const att = makeAttendant(THREE, scene, { at: [RAIL + 0.5, 0, -1.4], face: -0.5, hue: 0x2f6b4a, kind: 'barker', audio });

  // --- ball ---
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(bR, 20, 16), mat.wood([205, 72, 60]));
  ballMesh.castShadow = true; uncannySkew(ballMesh, 8, 0.04); ballMesh.visible = false; scene.add(ballMesh);
  const ball = { p: v3(), v: v3(), w: v3(0, 0, 0), r: bR, m: BALL_M };

  // --- state ---
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3(), _prev = v3();
  let ballsLeft = N_BALLS, score = 0, streak = 0, done = false, simTime = 0;
  let mode = 'ready', charging = false, power = 0, f = 0, l = 0, spin = 0, scored = false, tFly = 0, lastR = -1;
  audio.ambientProfile?.('skee');
  hud.mode('count'); hud.reticle(true); hud.count('BALLS', ballsLeft);
  hud.score(0); hud.combo(0); hud.striker(true); hud.sweet(1); hud.charge(0, false);

  function toScreen(p) { _proj.set(p.x, p.y, p.z).project(camera); return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight }; }
  function aim() { // lateral-only: fixed pitch, clamped yaw
    input.pitch = FIXED_PITCH; input.yaw = Math.max(-YAW_CLAMP, Math.min(YAW_CLAMP, input.yaw));
    camera.rotation.set(FIXED_PITCH, input.yaw, 0, 'YXZ'); return camera.getWorldDirection(_fwd);
  }
  function updateMarker(fwd) { // predicted landing for current power + lateral
    const sp = MINV + power * (MAXV - MINV), hl = Math.hypot(fwd.x, fwd.z) || 1;
    const land = rollFly(sp * (-fwd.z / hl), sp * (fwd.x / hl));
    marker.position.set(land.x, RING_Y + 0.005, land.z); marker.visible = true;
  }
  function launch(fwd) {
    const sp = MINV + power * (MAXV - MINV), hl = Math.hypot(fwd.x, fwd.z) || 1;
    f = Math.max(0.1, sp * (-fwd.z / hl)); l = sp * (fwd.x / hl);
    copy(ball.p, { x: 0, y: bR, z: -0.1 }); spin = 0; scored = false; mode = 'roll';
    ballMesh.visible = true; marker.visible = false; ballsLeft--; hud.count('BALLS', ballsLeft);
    audio.playSpatial('whoosh', ball.p); att.react('throw');
  }
  function resolve(value) {
    const s = toScreen(ball.p);
    if (value > 0) { streak++; const pts = Math.round(value * (1 + streak * 0.12)); score += pts; hud.pop(s.x, s.y, `${value} +${pts}`, value === 100 ? '#ff2fb0' : '#39ff88'); audio.playSpatial(value === 100 ? 'ding' : 'thud', ball.p); att.react(value >= 50 ? 'cheer' : 'nod'); }
    else { streak = 0; hud.pop(s.x, s.y, 'GUTTER', '#ff4d4d'); audio.playSpatial('thock', ball.p); att.react('shake'); }
    hud.score(score); hud.combo(streak); mode = 'ready'; ballMesh.visible = false;
    if (ballsLeft <= 0) finish();
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt; input.fireQueue.length = 0;
      const fwd = aim();

      if (mode === 'ready') {
        updateMarker(fwd);
        if (input.pressQueue.length && ballsLeft > 0) { input.pressQueue.length = 0; charging = true; power = 0; }
        if (charging) { power = Math.min(power + 1 / POWER_FR, 1); hud.charge(power, power > 0.72); }
        if (input.releaseQueue.length) { input.releaseQueue.length = 0; if (charging && ballsLeft > 0) launch(fwd); charging = false; hud.charge(0, false); }
      } else if (mode === 'roll') {
        input.pressQueue.length = 0; input.releaseQueue.length = 0;
        const onRamp = ball.p.z <= Z_FLAT_END, aF = onRamp ? (g * sinT + T.muR * g * cosT) * cosT : T.muF * g;
        f = Math.max(0, f - aF * dt);
        const la = T.muF * g * dt; l = Math.abs(l) <= la ? 0 : l - Math.sign(l) * la;
        ball.p.z -= f * dt; ball.p.x += l * dt; ball.p.y = surfaceY(ball.p.z);
        if (Math.abs(ball.p.x) > RAIL) { ball.p.x = Math.sign(ball.p.x) * RAIL; l = -l * T.eW; audio.playSpatial('clack', ball.p, { freq: 260 }); }
        spin += (f / bR) * dt; ballMesh.rotation.x = -spin;
        if (f > 0.3 && simTime - lastR > 0.13) { audio.playSpatial('thock', ball.p, { freq: 110 + f * 34 }); lastR = simTime; }
        if (ball.p.z <= Z_LIP) { ball.v.x = l; ball.v.y = f * tanT + lipKick; ball.v.z = -f; mode = 'fly'; tFly = 0; audio.playSpatial('clack', ball.p, { freq: 950 }); }
        else if (f <= 0.05) resolve(0);
      } else { // fly
        input.pressQueue.length = 0; input.releaseQueue.length = 0;
        tFly += dt; copy(_prev, ball.p);
        integrate(ball.p, ball.v, G, dt);
        ballMesh.position.set(ball.p.x, ball.p.y, ball.p.z); ballMesh.rotation.x -= (f / bR) * dt;
        for (const rg of rings) {
          if (!scored && _prev.y > rg.y && ball.p.y <= rg.y && ball.v.y < 0 && Math.hypot(ball.p.x - rg.x, ball.p.z - rg.z) < rg.r - bR * 0.4) { scored = true; resolve(rg.v); break; }
          const h = sphereTorus(ball.p, bR, { cx: rg.x, cy: rg.y, cz: rg.z, Rr: rg.r, Tr: RING_TUBE });
          if (h) { resolveBallContact(ball, h.n, h.pen, RING_E, RING_MU); if (simTime - lastR > 0.05) { audio.playSpatial('clack', ball.p, { freq: 700 }); lastR = simTime; } }
        }
        if (scored) return;
        if (ball.p.y < bR) resolveBallContact(ball, { x: 0, y: 1, z: 0 }, bR - ball.p.y, 0.3, 0.6);
        const settled = ball.p.y < bR + 0.02 && Math.hypot(ball.v.x, ball.v.y, ball.v.z) < 0.5;
        if (ball.p.z < Z_BACK || settled || tFly > 5) resolve(0);
      }
      att.update(simTime, mode === 'roll' || mode === 'fly' ? ball.p : null);
    },
    render() { audio.listener(camera.position, _fwd); },
    teardown() { done = true; hud.striker(false); att.teardown(); }
  };

  function finish() {
    done = true; hud.striker(false); document.exitPointerLock?.();
    ctx.end('LANE CLOSED', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
