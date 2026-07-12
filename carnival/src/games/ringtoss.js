// games/ringtoss.js — Level 4: Ring Toss (friction tester · rigid-torus showcase).
// M12: cursor drag-flick control. Camera is fixed on the board; the player drags on a resting ring
// and flicks — on the RELEASE frame flickToLaunch turns the release velocity into launch speed +
// azimuth, drag steepness sets elevation, and A/D held pre-tilts the ring plane ±8° for edge-catch
// throws. stepRing() is UNTOUCHED (MAXV ≤ 4.6, spin is free). Deterministic: InputFrame + seeded layout.
import { v3, clamp, mulberry32, G, stepRing, ringSettle } from '../core/physics.js';
import { flickToLaunch, DPHASE, K } from '../core/kinetics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';
import { makeBurst } from '../core/fx.js';

// [peg pR, ring inner Ri, thickness r, e, μs, μk, catchV, board tilt°]
const TIERS = [
  { pR: 0.030, Ri: 0.075, r: 0.020, e: 0.25, mus: 0.9, muk: 0.70, catchV: 3.5, tilt: 0 },
  { pR: 0.026, Ri: 0.066, r: 0.017, e: 0.30, mus: 0.8, muk: 0.60, catchV: 3.0, tilt: 3 },
  { pR: 0.022, Ri: 0.058, r: 0.014, e: 0.35, mus: 0.7, muk: 0.50, catchV: 2.6, tilt: 6 },
  { pR: 0.019, Ri: 0.052, r: 0.011, e: 0.42, mus: 0.6, muk: 0.45, catchV: 2.2, tilt: 9 },
  { pR: 0.017, Ri: 0.047, r: 0.008, e: 0.50, mus: 0.5, muk: 0.35, catchV: 1.8, tilt: 12 }
];

// peg board layout: [x, z, points] — farther pegs worth more; last row = the back peg
const PEGS = [[0, -0.9, 10], [-0.55, -1.5, 20], [0.55, -1.5, 25], [0, -2.15, 45], [0, -2.85, 80]];
const BACK_PEG = PEGS.length - 1;
const BOARD_Y = 0.9, PEG_H = 0.22, N_RINGS = 8, RING_M = 0.05;
const MINV = 2.0, MAXV = 4.6, SPIN = 26, TILT = 8 * Math.PI / 180; // launch speed clamp + backspin + A/D pre-tilt
const RING_CFG = { k: 2.2, vMin: MINV, vMax: MAXV, azK: 0.6, azMax: 0.35 };
const RESOLVE_T = 3.5;                                              // hard timeout (was 6): next throw comes fast
const KICK_AMP = 0.014, KICK_DECAY = 4.5;                          // render-only impact camera kick

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0x21A6 ^ (ctx.tier * 2654435761));
  input.setMode('cursor');
  const R = T.Ri + T.r;                                   // ring centerline radius
  const tilt = T.tilt * Math.PI / 180;
  const board = { nx: 0, ny: Math.cos(tilt), nz: Math.sin(tilt), ox: 0, oy: BOARD_Y, oz: -1.9 };
  const pegY = (z) => board.oy - board.nz / board.ny * (z - board.oz); // board plane height at z
  const P = {
    g: G.y, nodes: 14, pegE: T.e, pegMuk: T.muk, boardE: T.e * 0.7, boardMuk: Math.max(T.muk, 0.6),
    sleepLin: 0.06, sleepAng: 0.5, sleepN: 16                          // wobble exposure vs settle pace (M12=20; balance call)
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

  camera.position.set(0, 1.5, 0.7); camera.lookAt(0, BOARD_Y, -2.0);   // fixed view down the board
  const camQ0 = camera.quaternion.clone();                             // base pose; render kick pivots off this

  // --- state ---
  const fx = makeBurst(THREE, scene);                                  // pooled ringer shockwave (seeded, visual-only)
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _proj = new THREE.Vector3();
  const _kq = new THREE.Quaternion(), _ke = new THREE.Euler(0, 0, 0, 'YXZ');
  const _o = { v0: 0, az: 0, mag: 0 };
  let ringsLeft = N_RINGS, score = 0, streak = 0, maxStreak = 0, backPeg = false, done = false, pendingEnd = false;
  let cur = null, lastClack = -1, lastScrape = -1, simTime = 0, kick = 0;
  audio.ambientProfile?.('ringtoss');
  hud.mode('count'); hud.reticle(false); hud.count('RINGS', ringsLeft);
  hud.score(0); hud.combo(0); hud.striker(false); hud.ribbon(null);

  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  const ndcToPx = (nx, ny) => ({ x: (nx * 0.5 + 0.5) * innerWidth, y: (-ny * 0.5 + 0.5) * innerHeight });

  // RELEASE frame → launch: flick sets speed+azimuth, drag steepness sets elevation, A/D pre-tilts plane
  function toss(f) {
    const slot = rings.find((r) => !r.live); if (!slot) return;
    flickToLaunch(f.flickVX, f.flickVY, RING_CFG, _o);
    const steep = clamp(Math.atan2(Math.max(f.dragDY, 1e-4), Math.abs(f.dragDX) + 1e-4), 0.35, 0.95);
    const cE = Math.cos(steep), sE = Math.sin(steep), cA = Math.cos(_o.az), sA = Math.sin(_o.az);
    const vx = _o.v0 * cE * sA, vy = _o.v0 * sE, vz = -_o.v0 * cE * cA;   // forward = −z
    const spin = SPIN * clamp((_o.v0 - MINV) / (MAXV - MINV), 0, 1);      // backspin ∝ flick speed
    _fwd.set(vx, vy, vz).normalize(); _right.crossVectors(_fwd, _up).normalize(); // backspin axis ⟂ throw, horizontal
    let tz = 0; if (f.keys & K.A) tz += TILT; if (f.keys & K.D) tz -= TILT;
    const hz = tz * 0.5;                                                  // quaternion half-angle about z
    slot.body = {
      p: v3(camera.position.x + _fwd.x * 0.3, camera.position.y + _fwd.y * 0.3, camera.position.z + _fwd.z * 0.3),
      v: v3(vx, vy, vz),
      q: { x: 0, y: 0, z: Math.sin(hz), w: Math.cos(hz) },               // ring plane tilted ±8° by A/D
      w: v3(_right.x * spin, _right.y * spin, _right.z * spin),
      R, r: T.r, m: RING_M, rest: false, slp: 0
    };
    slot.live = true; slot.t = 0; slot.mesh.visible = true; cur = slot;
    ringsLeft--; hud.count('RINGS', ringsLeft);
    audio.playSpatial('whoosh', slot.body.p);
  }

  function classify(b) {
    let best = null, bestD = Infinity, bestIdx = -1;
    pegs.forEach((pg, i) => { const d = Math.hypot(b.p.x - pg.bx, b.p.z - pg.bz); if (d < bestD) { bestD = d; best = pg; bestIdx = i; } });
    const s = toScreen(b.p);
    if (best && bestD < best.pR + T.Ri * 0.7 && b.p.y < best.by + PEG_H) {   // encircling & low -> ringer
      streak++; maxStreak = Math.max(maxStreak, streak); if (bestIdx === BACK_PEG) backPeg = true;
      const pts = Math.round(best.pts * (1 + streak * 0.15)); score += pts;
      fx.spawn({ x: best.bx, y: best.by + PEG_H, z: best.bz }, 16, rng, 2.6, 0x39ff88); kick = Math.min(1, kick + 0.7);
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
      simTime += dt;
      kick = Math.max(0, kick - dt * KICK_DECAY); fx.step(dt);
      const f = input.frame;

      // ready: show drag ribbon, launch on the RELEASE frame
      if (!cur) {
        if (f.dphase === DPHASE.DRAG) {
          const a = ndcToPx(f.dragX0, f.dragY0), b = ndcToPx(f.dragX0 + f.dragDX, f.dragY0 + f.dragDY);
          hud.ribbon(a.x, a.y, b.x, b.y);
        } else hud.ribbon(null);
        if (f.dphase === DPHASE.RELEASE && ringsLeft > 0) { hud.ribbon(null); toss(f); }
      }

      // simulate the active ring
      if (cur) {
        const b = cur.body; cur.t += dt;
        const ev = stepRing(b, nearestPeg(b), board, P, dt);
        if (ev.clack > 0.004 && simTime - lastClack > 0.05) { audio.playSpatial('clack', ev.cp, { freq: 300 + ev.clack * 40 }); lastClack = simTime; }
        if (ev.slide > 0.02 && simTime - lastScrape > 0.08) { audio.playSpatial('scrape', b.p); lastScrape = simTime; } // rim grinds on the peg
        cur.mesh.position.set(b.p.x, b.p.y, b.p.z);
        cur.mesh.quaternion.set(b.q.x, b.q.y, b.q.z, b.q.w);
        // resolve on: settle latch · off the board · EARLY capture (instant ringer) · hard timeout
        if (b.rest || b.p.y < -0.5 || ringSettle(b, nearestPeg(b), T.Ri, PEG_H) || cur.t > RESOLVE_T) {
          classify(b); cur.live = b.p.y >= -0.5; cur = null; if (pendingEnd) return finish();
        }
      }
    },
    render() {
      // render-only camera kick: pivot off the base pose (position never touched ⇒ toss() stays deterministic)
      camera.quaternion.copy(camQ0);
      if (kick > 1e-4) { const s = kick * KICK_AMP; _ke.set(s * Math.sin(simTime * 41), s * 0.7 * Math.sin(simTime * 33 + 1.7), s * 0.5 * Math.sin(simTime * 27 + 0.6), 'YXZ'); camera.quaternion.multiply(_kq.setFromEuler(_ke)); }
      camera.getWorldDirection(_fwd); audio.listener(camera.position, _fwd); att.update(simTime, cur ? cur.body.p : null);
    },
    teardown() { done = true; hud.ribbon(null); fx.teardown(); att.teardown(); }
  };

  // active ring collides against its nearest peg (single-peg contact is enough at these speeds)
  function nearestPeg(b) {
    let best = pegs[0], bestD = Infinity;
    for (const pg of pegs) { const d = Math.hypot(b.p.x - pg.bx, b.p.z - pg.bz); if (d < bestD) { bestD = d; best = pg; } }
    return best;
  }
  function finish() {
    done = true; hud.ribbon(null); document.exitPointerLock?.();
    ctx.end('LAST RING', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`, { score, stats: { backPeg, maxStreak } });
  }
}
