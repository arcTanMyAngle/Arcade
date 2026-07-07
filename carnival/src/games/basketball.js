// games/basketball.js — Level 5: Free-Throw (parabolic arc · rim · backspin "shooter's roll").
// Deterministic: aim + power + backspin fully determine the make/miss + every bounce. No random.
//   flight = integrate(G + quadratic drag + Magnus cM·(ω×v)); rim = sphereTorus + resolveBallContact
//   (spin-aware friction => a clip walks toward center); backboard/floor = plane restitution.
import { v3, copy, integrate, windDrag, sphereTorus, resolveBallContact, cross, G, add } from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [distance, rimR, rim e, backboard eB, drag kB, Magnus cM]
const TIERS = [
  { dist: 4.0, rimR: 0.240, e: 0.55, eB: 0.50, kB: 0.000, cM: 0.15 },
  { dist: 4.6, rimR: 0.230, e: 0.62, eB: 0.55, kB: 0.002, cM: 0.15 },
  { dist: 5.2, rimR: 0.225, e: 0.70, eB: 0.60, kB: 0.004, cM: 0.12 },
  { dist: 5.8, rimR: 0.220, e: 0.78, eB: 0.65, kB: 0.007, cM: 0.10 },
  { dist: 6.4, rimR: 0.216, e: 0.86, eB: 0.70, kB: 0.011, cM: 0.08 }
];

const bR = 0.12, RIM_TUBE = 0.02, RIM_H = 3.05, BALL_M = 0.62, N_SHOTS = 10;
const POWER_FR = 46, MINV = 6.5, MAXV = 11.5, SPIN = 34, MAG = 0.02; // launch speed + backspin + Magnus scale
const RIM_MU = 0.5, FLOOR_E = 0.6, FLOOR_MU = 0.5, BOARD_MU = 0.2;

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const D = T.dist, rimC = { cx: 0, cy: RIM_H, cz: -D, Rr: T.rimR, Tr: RIM_TUBE };
  const boardZ = -D - 0.18, boardW = 1.8, boardH = 1.05, boardY0 = RIM_H + 0.1;

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0xff2fb0, span: 5, back: boardZ - 0.6 });
  const att = makeAttendant(THREE, scene, { at: [3.3, 0, -D * 0.4], face: -0.5, hue: 0x6b2f52, kind: 'barker', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat.wood([120, 96, 58])); // gym boards
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  // backboard (too glossy)
  const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, boardH, 0.06), mat.paint([210, 214, 220]));
  board.material.roughness = 0.12; board.material.metalness = 0.0;
  board.position.set(0, boardY0 + boardH / 2, boardZ - 0.03); board.castShadow = true; scene.add(board);
  const sq = new THREE.Mesh(new THREE.BoxGeometry(0.59, 0.45, 0.008), mat.emissive(0xff2fb0, 1.6)); // shooter's square (neon)
  sq.position.set(0, RIM_H + 0.3, boardZ); scene.add(sq);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, boardY0 + boardH, 12), mat.metal());
  pole.position.set(0, (boardY0 + boardH) / 2, boardZ - 0.3); pole.castShadow = true; scene.add(pole);
  // rim (thin) + stiff net
  const rim = new THREE.Mesh(new THREE.TorusGeometry(T.rimR, RIM_TUBE, 12, 32), mat.metal([255, 120, 40]));
  rim.material.emissive = new THREE.Color(0xff5a1e); rim.material.emissiveIntensity = 0.6;
  rim.position.set(0, RIM_H, -D); rim.rotation.x = Math.PI / 2; uncannySkew(rim, 4, 0.04); scene.add(rim);
  const net = new THREE.Mesh(new THREE.CylinderGeometry(T.rimR * 0.95, T.rimR * 0.5, 0.4, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.9, transparent: true, opacity: 0.32, side: THREE.DoubleSide }));
  net.position.set(0, RIM_H - 0.2, -D); scene.add(net);

  camera.position.set(0, 1.75, 0.6); camera.lookAt(0, RIM_H * 0.8, -D);
  input.pitch = 0.42; input.yaw = 0; // start looking up toward the hoop

  // --- ball ---
  const ballGeo = new THREE.SphereGeometry(bR, 24, 18);
  const ballMat = mat.wood([180, 96, 40]); ballMat.roughness = 0.7; // pebbled leather-ish
  const ballMesh = new THREE.Mesh(ballGeo, ballMat); ballMesh.castShadow = true; uncannySkew(ballMesh, 6, 0.04); ballMesh.visible = false; scene.add(ballMesh);
  const ball = { p: v3(), v: v3(), w: v3(), r: bR, m: BALL_M };

  // --- state ---
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _proj = new THREE.Vector3();
  const _acc = {}, _zero = v3(), _mag = {}, _prev = v3();
  let shotsLeft = N_SHOTS, score = 0, streak = 0, done = false, pendingEnd = false;
  let charging = false, power = 0, flying = false, rimHit = false, scored = false, tFly = 0, lastBounce = -1, simTime = 0;
  audio.ambientProfile?.('basketball');
  hud.mode('count'); hud.reticle(true); hud.count('SHOTS', shotsLeft);
  hud.score(0); hud.combo(0); hud.striker(true); hud.sweet(1); hud.charge(0, false);

  function toScreen(p) { _proj.set(p.x, p.y, p.z).project(camera); return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight }; }
  function aim() { camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ'); return camera.getWorldDirection(_fwd); }
  function shoot(fwd) {
    const sp = MINV + power * (MAXV - MINV);
    _right.crossVectors(fwd, _up).normalize();               // backspin axis (lateral, ⟂ shot)
    copy(ball.p, { x: camera.position.x + fwd.x * 0.4, y: camera.position.y + fwd.y * 0.4, z: camera.position.z + fwd.z * 0.4 });
    ball.v.x = fwd.x * sp; ball.v.y = fwd.y * sp; ball.v.z = fwd.z * sp;
    const spin = SPIN * (0.6 + 0.4 * power);
    ball.w.x = _right.x * spin; ball.w.y = _right.y * spin; ball.w.z = _right.z * spin;
    flying = true; rimHit = false; scored = false; tFly = 0; ballMesh.visible = true;
    shotsLeft--; hud.count('SHOTS', shotsLeft); audio.playSpatial('whoosh', ball.p);
  }
  function scoreMake(swish) { // ball dropped through the rim; let it keep falling through the net
    streak++;
    const pts = Math.round((swish ? 150 : 100) * (1 + streak * 0.15)); score += pts;
    const s = toScreen(ball.p); hud.pop(s.x, s.y, `${swish ? 'SWISH' : 'MAKE'} +${pts}`, swish ? '#39ff88' : '#8fddc0');
    audio.playSpatial('swish', { x: 0, y: RIM_H - 0.2, z: -D }); hud.score(score); hud.combo(streak); att.react('cheer');
  }
  function endPossession() {
    if (!scored) { streak = 0; hud.combo(0); const s = toScreen(ball.p); hud.pop(s.x, s.y, 'MISS', '#ff4d4d'); att.react('shake'); }
    flying = false; ballMesh.visible = false;
    if (shotsLeft <= 0) pendingEnd = true;
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt; input.fireQueue.length = 0;
      const fwd = aim();

      if (!flying) {
        if (input.pressQueue.length && shotsLeft > 0) { input.pressQueue.length = 0; charging = true; power = 0; }
        if (charging) { power = Math.min(power + 1 / POWER_FR, 1); hud.charge(power, power > 0.7); }
        if (input.releaseQueue.length) { input.releaseQueue.length = 0; if (charging && shotsLeft > 0) shoot(fwd); charging = false; hud.charge(0, false); }
      } else {
        input.pressQueue.length = 0; input.releaseQueue.length = 0;
        tFly += dt; copy(_prev, ball.p);
        // accel = gravity + quadratic air drag + Magnus (cM·ω×v), scaled small
        add(G, windDrag(ball.v, _zero, T.kB, _acc), _acc);
        cross(ball.w, ball.v, _mag); _acc.x += _mag.x * T.cM * MAG; _acc.y += _mag.y * T.cM * MAG; _acc.z += _mag.z * T.cM * MAG;
        integrate(ball.p, ball.v, _acc, dt);
        ball.w.x *= 0.999; ball.w.y *= 0.999; ball.w.z *= 0.999; // slight spin decay

        // rim (sphere↔torus, spin-aware)
        const h = sphereTorus(ball.p, bR, rimC);
        if (h) { const jn = resolveBallContact(ball, h.n, h.pen, T.e, RIM_MU); rimHit = true; if (simTime - lastBounce > 0.04) { audio.playSpatial('ping', { x: ball.p.x, y: ball.p.y, z: ball.p.z }, { freq: 1100 }); lastBounce = simTime; } }
        // backboard (plane +z), only within its rectangle
        if (ball.p.z < boardZ + bR && _prev.z >= boardZ + bR && Math.abs(ball.p.x) < boardW / 2 && ball.p.y > boardY0 && ball.p.y < boardY0 + boardH) {
          resolveBallContact(ball, { x: 0, y: 0, z: 1 }, (boardZ + bR) - ball.p.z, T.eB, BOARD_MU); audio.playSpatial('thock', ball.p);
        }
        // floor
        if (ball.p.y < bR) { const jn = resolveBallContact(ball, { x: 0, y: 1, z: 0 }, bR - ball.p.y, FLOOR_E, FLOOR_MU); if (simTime - lastBounce > 0.06) { audio.playSpatial('thock', { x: ball.p.x, y: bR, z: ball.p.z }, { freq: 200 }); lastBounce = simTime; } }

        // make: center sweeps down through the rim plane inside the window
        if (!scored && _prev.y > RIM_H && ball.p.y <= RIM_H && ball.v.y < 0) {
          const hd = Math.hypot(ball.p.x - rimC.cx, ball.p.z - rimC.cz);
          if (hd < T.rimR - bR) { scored = true; scoreMake(!rimHit); }
        }

        ballMesh.position.set(ball.p.x, ball.p.y, ball.p.z);
        ballMesh.rotation.x += ball.w.x * dt; ballMesh.rotation.z += ball.w.z * dt; // visualize spin

        // end of possession: settled, out of bounds, or timed out (a make still falls through first)
        const settled = ball.p.y < bR + 0.02 && Math.hypot(ball.v.x, ball.v.y, ball.v.z) < 0.6;
        const oob = ball.p.z > 3 || Math.abs(ball.p.x) > 10 || ball.p.z < -D - 4;
        if (settled || tFly > 6 || (oob && !scored)) { endPossession(); if (pendingEnd) return finish(); }
      }
    },
    render() { audio.listener(camera.position, _fwd); att.update(simTime, flying ? ball.p : null); },
    teardown() { done = true; hud.striker(false); att.teardown(); }
  };

  function finish() {
    done = true; hud.striker(false); document.exitPointerLock?.();
    ctx.end('GAME', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
