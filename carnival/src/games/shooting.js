// games/shooting.js — Level 1: Shooting Gallery (rifle · bullet drop · wind).
// Deterministic: aim + fire times + seeded gusts fully determine every hit. No Math.random.
import {
  v3, copy, integrate, windDrag, segCrossPlaneZ, lerpSeg, mulberry32, G, add
} from '../core/physics.js';
import { tier } from '../core/tiers.js';
import { mat, clinicalLights, uncannySkew } from '../core/materials.js';
import { carnivalDress } from '../core/decor.js';
import { makeAttendant } from '../core/characters.js';

// [vMuzzle, dragK, windAmp, R, amp, omega, rBull, round]
const TIERS = [
  { vMuzzle: 120, k: 0.000, wind: 0.0, R: 0.40, amp: 0.0, omega: 0.0,  rBull: 0.12,  round: 60 },
  { vMuzzle: 110, k: 0.004, wind: 1.0, R: 0.32, amp: 0.8, omega: 0.75, rBull: 0.09,  round: 50 },
  { vMuzzle: 100, k: 0.008, wind: 2.5, R: 0.24, amp: 1.2, omega: 1.00, rBull: 0.06,  round: 45 },
  { vMuzzle: 92,  k: 0.014, wind: 4.0, R: 0.18, amp: 1.6, omega: 1.25, rBull: 0.045, round: 40 },
  { vMuzzle: 85,  k: 0.020, wind: 6.0, R: 0.12, amp: 2.2, omega: 1.45, rBull: 0.03,  round: 35 }
];

const TARGET_Z = -16, WALL_Z = -17.2, N_PLATES = 6, POOL = 40, RESPAWN = 0.8;

export function create(ctx) {
  const { THREE, scene, camera, input, audio, hud } = ctx;
  const T = tier(TIERS, ctx.tier);
  const rng = mulberry32(0x5EED ^ (ctx.tier * 2654435761));

  // deterministic gust curve: 64 seeded knots, lerped, period 2.2s
  const GUST_P = 2.2, knots = Array.from({ length: 96 }, () => (rng() * 2 - 1) * T.wind);
  const windX = (t) => {
    const s = t / GUST_P, i = Math.floor(s) % (knots.length - 1), f = s - Math.floor(s);
    return knots[i] * (1 - f) + knots[i + 1] * f;
  };

  // --- environment ---
  clinicalLights(scene, THREE);
  carnivalDress(THREE, scene, { theme: 0x39ff88, span: 8, back: WALL_Z - 1 });
  const att = makeAttendant(THREE, scene, { at: [6.6, 0, -3], face: -0.7, hue: 0x2f5a6b, kind: 'barker', audio });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), mat.wood([90, 64, 40]));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0; floor.receiveShadow = true; scene.add(floor);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), mat.paint([26, 30, 28]));
  back.position.set(0, 4, WALL_Z - 0.3); back.receiveShadow = true; scene.add(back);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(14, 1, 1.2), mat.metal());
  counter.position.set(0, 1.0, 0.6); counter.castShadow = true; scene.add(counter);

  camera.position.set(0, 1.7, 2); camera.rotation.set(0, 0, 0, 'YXZ');

  // --- plates ---
  const plateGeo = new THREE.CylinderGeometry(1, 1, 0.05, 28); // unit; scaled per tier
  const outMat = mat.paint([232, 236, 230]);
  const bullMat = mat.emissive(0xff2fb0, 2.4);
  const plates = [];
  for (let i = 0; i < N_PLATES; i++) {
    const grp = new THREE.Group();
    const disc = new THREE.Mesh(plateGeo, outMat); disc.rotation.x = Math.PI / 2; disc.castShadow = true; grp.add(disc);
    const bull = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.06, 20), bullMat); bull.rotation.x = Math.PI / 2; grp.add(bull);
    const baseX = -4.5 + (9 / (N_PLATES - 1)) * i;
    const y = 1.5 + ((i % 3) * 0.42);
    grp.scale.setScalar(T.R); bull.scale.setScalar(T.rBull / T.R);
    grp.position.set(baseX, y, TARGET_Z); uncannySkew(grp, i, 0.05);
    scene.add(grp);
    plates.push({ grp, baseX, y, phase: rng() * Math.PI * 2, x: baseX, alive: true, respawnAt: 0 });
  }

  // --- bullet pool ---
  const bGeo = new THREE.SphereGeometry(0.03, 8, 6), bMat = mat.emissive(0xfff2a0, 3);
  const bullets = Array.from({ length: POOL }, () => {
    const mesh = new THREE.Mesh(bGeo, bMat); mesh.visible = false; scene.add(mesh);
    return { p: v3(), v: v3(), prev: v3(), mesh, active: false, scored: false };
  });
  const spawnBullet = (fwd) => {
    const b = bullets.find((x) => !x.active) || bullets[0];
    b.p.x = camera.position.x + fwd.x * 0.3; b.p.y = camera.position.y + fwd.y * 0.3; b.p.z = camera.position.z + fwd.z * 0.3;
    b.v.x = fwd.x * T.vMuzzle; b.v.y = fwd.y * T.vMuzzle; b.v.z = fwd.z * T.vMuzzle;
    copy(b.prev, b.p); b.active = true; b.scored = false; b.mesh.visible = true;
  };

  // --- scratch + state ---
  const _fwd = new THREE.Vector3(), _proj = new THREE.Vector3(), _acc = {}, _wind = v3();
  let simTime = 0, score = 0, streak = 0, done = false;
  audio.ambientProfile?.('shooting');
  hud.wind(0); hud.score(0); hud.combo(0);

  function ringVal(rE) {
    if (rE <= T.rBull) return [100, 'BULL', '#ff2fb0'];
    if (rE <= T.R * 0.4) return [50, '50', '#39ff88'];
    if (rE <= T.R * 0.7) return [25, '25', '#8fddc0'];
    if (rE <= T.R) return [10, '10', '#cfe8dd'];
    return null;
  }
  function toScreen(p) {
    _proj.set(p.x, p.y, p.z).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight };
  }
  function registerHit(plate, hit, rE) {
    const r = ringVal(rE); if (!r) return false;
    streak++; const gain = Math.round(r[0] * (1 + streak * 0.1)); score += gain;
    plate.alive = false; plate.grp.visible = false; plate.respawnAt = simTime + RESPAWN;
    const s = toScreen(hit); hud.pop(s.x, s.y, `${r[1]} +${gain}`, r[2]);
    audio.playSpatial('ping', hit, { freq: 700 + rE * 200 });
    hud.score(score); hud.combo(streak); att.react(r[0] >= 50 ? 'cheer' : 'nod');
    return true;
  }
  function miss(at) {
    streak = 0; hud.combo(0);
    const s = toScreen(at); hud.pop(s.x, s.y, 'MISS', '#ff4d4d');
    audio.playSpatial('thock', at); att.react('shake');
  }

  return {
    step(dt) {
      if (done) return;
      simTime += dt;
      if (simTime >= T.round) { end(); return; }
      _wind.x = windX(simTime);

      // aim
      camera.rotation.set(input.pitch, input.yaw, 0, 'YXZ');
      camera.getWorldDirection(_fwd);

      // plates motion + respawn
      for (const pl of plates) {
        if (!pl.alive && simTime >= pl.respawnAt) { pl.alive = true; pl.grp.visible = true; pl.phase = (pl.phase + 1.7) % (Math.PI * 2); }
        pl.x = pl.baseX + T.amp * Math.sin(T.omega * simTime + pl.phase);
        pl.grp.position.x = pl.x;
      }

      // fire
      while (input.fireQueue.length) { input.fireQueue.pop(); spawnBullet(_fwd); audio.playSpatial('crack', null); }

      // bullets
      for (const b of bullets) {
        if (!b.active) continue;
        copy(b.prev, b.p);
        add(G, windDrag(b.v, _wind, T.k, _acc), _acc); // a = g + wind drag
        integrate(b.p, b.v, _acc, dt);
        b.mesh.position.set(b.p.x, b.p.y, b.p.z);

        // crossing target plane (travelling -z)
        if (b.prev.z > TARGET_Z && b.p.z <= TARGET_Z) {
          const t = segCrossPlaneZ(b.prev, b.p, TARGET_Z), h = lerpSeg(b.prev, b.p, t);
          let best = null, bestRE = Infinity;
          for (const pl of plates) {
            if (!pl.alive) continue;
            const rE = Math.hypot(h.x - pl.x, h.y - pl.y);
            if (rE < bestRE) { bestRE = rE; best = pl; }
          }
          if (best && bestRE <= T.R) { if (registerHit(best, h, bestRE)) { b.active = false; b.mesh.visible = false; continue; } }
        }
        // reached back wall without scoring -> miss
        if (b.p.z <= WALL_Z) { b.active = false; b.mesh.visible = false; miss(b.p); }
      }

      hud.time(T.round - simTime); hud.wind(_wind.x);
    },
    render() {
      camera.getWorldDirection(_fwd);
      audio.listener(camera.position, _fwd);
      const b = bullets.find((x) => x.active); att.update(simTime, b ? b.p : null);
    },
    teardown() { done = true; att.teardown(); }
  };

  function end() {
    done = true; document.exitPointerLock?.();
    ctx.end('ROUND OVER', `TIER ${ctx.tier} · SCORE <b style="color:#39ff88">${score}</b>`);
  }
}
