// games/ringtoss.js — Level 4: Ring Toss (friction tester · rigid-torus showcase).
// The hardest solver: a rigid ring (torus) tossed at pegs, resolved by physics.stepRing()
// (sampled-node torus↔cylinder/plane contacts, restitution + Coulomb friction, micro-substepped
// so a thin fast ring can't tunnel the shaft). Deterministic: aim + power + seeded layout only.
import { v3, mulberry32, G, stepRing } from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [peg pR, ring inner Ri, thickness r, e, μs, μk, catchV, board tilt°]
const TIERS = [
  { pR: 0.030, Ri: 0.075, r: 0.020, e: 0.25, mus: 0.9, muk: 0.70, catchV: 3.5, tilt: 0 },
  { pR: 0.026, Ri: 0.066, r: 0.017, e: 0.30, mus: 0.8, muk: 0.60, catchV: 3.0, tilt: 3 },
  { pR: 0.022, Ri: 0.058, r: 0.014, e: 0.35, mus: 0.7, muk: 0.50, catchV: 2.6, tilt: 6 },
  { pR: 0.019, Ri: 0.052, r: 0.011, e: 0.42, mus: 0.6, muk: 0.45, catchV: 2.2, tilt: 9 },
  { pR: 0.017, Ri: 0.047, r: 0.008, e: 0.50, mus: 0.5, muk: 0.35, catchV: 1.8, tilt: 12 }
];

// peg board layout: [x, z, points] — farther pegs worth more
const PEGS = [[0, -0.9, 10], [-0.55, -1.5, 20], [0.55, -1.5, 25], [0, -2.15, 45], [0, -2.85, 80]];
const BOARD_Y = 0.9, PEG_H = 0.22, N_RINGS = 8, RING_M = 0.05;
const POWER_FR = 48, MINV = 2.0, MAXV = 4.6, SPIN = 26; // throw speed + backspin scaling

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0x21A6 ^ (ctx.tier * 2654435761));
  const R = T.Ri + T.r;                                   // ring centerline radius
  const tilt = T.tilt * Math.PI / 180;
  const board = { nx: 0, ny: Math.cos(tilt), nz: Math.sin(tilt), ox: 0, oy: BOARD_Y, oz: -1.9 };
  const pegY = (z) => board.oy - board.nz / board.ny * (z - board.oz); // board plane height at z
  const P = {
    g: G.y, nodes: 14, pegE: T.e, pegMuk: T.muk, boardE: T.e * 0.7, boardMuk: Math.max(T.muk, 0.6),
    sleepLin: 0.06, sleepAng: 0.5, sleepN: 12
  };

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0x39ff88, span: 6, back: -6 });
  const att = makeAttendant(THREE, scene, { at: [2.7, 0, -0.2], face: -0.6, hue: 0x2f6b4a, kind: 'attendant', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), mat.wood([70, 50, 34]));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const tableMat = mat.wood([60, 96, 78]);               // sickly-green board
  const table = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 4.2), tableMat);
  table.position.set(0, BOARD_Y - 0.06, board.oz); table.rotation.x = -tilt; table.receiveShadow = true; scene.add(table);
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), mat.paint([16, 22, 20]));
  backdrop.position.set(0, 5, -6); scene.add(backdrop);

  // pegs (InstancedMesh: too-tall, too-even — uncanny)
  const pegGeo = new THREE.CylinderGeometry(T.pR, T.pR * 1.15, PEG_H, 14);
  const pegs = PEGS.map(([x, z, pts]) => ({ bx: x, by: pegY(z), bz: z, pR: T.pR, pH: PEG_H, pts }));
  const pegInst = new THREE.InstancedMesh(pegGeo, mat.metal([150, 154, 160]), pegs.length);
  pegInst.castShadow = true; scene.add(pegInst);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _pp = new THREE.Vector3();
  pegs.forEach((pg, i) => { _pp.set(pg.bx, pg.by + PEG_H / 2, pg.bz); _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rng() - 0.5) * 0.05); _m.compose(_pp, _q, _s); pegInst.setMatrixAt(i, _m); });
  pegInst.instanceMatrix.needsUpdate = true;

  // ring pool: lacquered wooden torus, faintly non-circular
  const ringGeo = new THREE.TorusGeometry(R, T.r, 12, 28);
  const ringMat = mat.wood([150, 90, 60]); ringMat.roughness = 0.34; ringMat.metalness = 0.05;
  const rings = Array.from({ length: N_RINGS }, () => {
    const mesh = new THREE.Mesh(ringGeo, ringMat); mesh.visible = false; mesh.castShadow = true; uncannySkew(mesh, 2, 0.05); scene.add(mesh);
    return { mesh, body: null, live: false, t: 0 };
  });

  camera.position.set(0, 1.5, 0.7); camera.lookAt(0, BOARD_Y, -2.0);
  input.pitch = -0.55; input.yaw = 0; // start looking down at the board (aim() drives it thereafter)

  // --- state ---
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _proj = new THREE.Vector3();
  let ringsLeft = N_RINGS, score = 0, streak = 0, done = false, pendingEnd = false;
  let charging = false, power = 0, cur = null, lastClack = -1, simTime = 0;
  audio.ambientProfile?.('ringtoss');
  hud.mode('count'); hud.reticle(true); hud.count('RINGS', ringsLeft);
  hud.score(0); hud.combo(0); hud.striker(true); hud.sweet(1); hud.charge(0, false); // meter as plain power bar

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  function aim() { camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ'); return camera.getWorldDirection(_fwd); }
  function toss(fwd) {
    const slot = rings.find((r) => !r.live); if (!slot) return;
    const sp = MINV + power * (MAXV - MINV);
    _right.crossVectors(fwd, _up).normalize();             // backspin axis (⟂ throw, horizontal)
    slot.body = {
      p: v3(camera.position.x + fwd.x * 0.3, camera.position.y + fwd.y * 0.3, camera.position.z + fwd.z * 0.3),
      v: v3(fwd.x * sp, fwd.y * sp, fwd.z * sp),
      q: { x: 0, y: 0, z: 0, w: 1 },                        // flat ring (axis +y) so it can drop over a peg
      w: v3(_right.x * SPIN * power, _right.y * SPIN * power, _right.z * SPIN * power),
      R, r: T.r, m: RING_M, rest: false, slp: 0
    };
    slot.live = true; slot.t = 0; slot.mesh.visible = true; cur = slot;
    ringsLeft--; hud.count('RINGS', ringsLeft);
    audio.playSpatial('whoosh', slot.body.p);
  }
  function classify(b) {
    let best = null, bestD = Infinity;
    for (const pg of pegs) { const d = Math.hypot(b.p.x - pg.bx, b.p.z - pg.bz); if (d < bestD) { bestD = d; best = pg; } }
    const s = toScreen(b.p);
    if (best && bestD < best.pR + T.Ri * 0.7 && b.p.y < best.by + PEG_H) {   // encircling & low -> ringer
      streak++; const pts = Math.round(best.pts * (1 + streak * 0.15)); score += pts;
      hud.pop(s.x, s.y, `RINGER ×${best.pts} +${pts}`, '#39ff88'); audio.playSpatial('clack', b.p, { freq: 520 }); att.react('cheer');
    } else if (best && bestD < T.Ri + T.r + best.pR) {                       // leaning on the peg
      streak = 0; const pts = Math.round(best.pts * 0.3); score += pts;
      hud.pop(s.x, s.y, `LEAN +${pts}`, '#8fddc0'); att.react('nod');
    } else { streak = 0; hud.pop(s.x, s.y, 'MISS', '#ff4d4d'); audio.playSpatial('thock', b.p); att.react('shake'); }
    hud.score(score); hud.combo(streak);
    if (ringsLeft <= 0) pendingEnd = true;
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt; input.fireQueue.length = 0;

      const fwd = aim();
      // power: hold LMB to build, release to toss (no ring in flight)
      if (!cur) {
        if (input.pressQueue.length && ringsLeft > 0) { input.pressQueue.length = 0; charging = true; power = 0; }
        if (charging) { power = Math.min(power + 1 / POWER_FR, 1); hud.charge(power, power > 0.66); }
        if (input.releaseQueue.length) { input.releaseQueue.length = 0; if (charging && ringsLeft > 0) toss(fwd); charging = false; hud.charge(0, false); }
      } else { input.pressQueue.length = 0; input.releaseQueue.length = 0; }

      // simulate the active ring
      if (cur) {
        const b = cur.body; cur.t += dt;
        const ev = stepRing(b, nearestPeg(b), board, P, dt);
        if (ev.clack > 0.004 && simTime - lastClack > 0.05) { audio.playSpatial('clack', ev.cp, { freq: 300 + ev.clack * 40 }); lastClack = simTime; }
        cur.mesh.position.set(b.p.x, b.p.y, b.p.z);
        cur.mesh.quaternion.set(b.q.x, b.q.y, b.q.z, b.q.w);
        // resolve when the ring sleeps, falls off, or times out
        if (b.rest || b.p.y < -0.5 || cur.t > 6) { classify(b); cur.live = b.p.y >= -0.5; cur = null; if (pendingEnd) return finish(); }
      }
    },
    render() { audio.listener(camera.position, _fwd); att.update(simTime, cur ? cur.body.p : null); },
    teardown() { done = true; hud.striker(false); att.teardown(); }
  };

  // active ring collides against its nearest peg (single-peg contact is enough at these speeds)
  function nearestPeg(b) {
    let best = pegs[0], bestD = Infinity;
    for (const pg of pegs) { const d = Math.hypot(b.p.x - pg.bx, b.p.z - pg.bz); if (d < bestD) { bestD = d; best = pg; } }
    return best;
  }
  function finish() {
    done = true; hud.striker(false); document.exitPointerLock?.();
    ctx.end('LAST RING', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
