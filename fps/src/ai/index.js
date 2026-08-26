// Deterministic cover-combat AI wired to the orphaned nav/FSM/body modules.

import * as THREE from 'three';
import { createNav } from './nav.js';
import { createAgentBody, disposeSharedBodyAssets } from './body.js';
import { AGENT_R, AGENT_H, CFG, createAgentState, stepFSM, isExposed, rayVsVerticalCapsule, zoneForT, ZONE_MULT, aimSpreadRad, OUTGOING_DMG } from './logic.js';
import { angleDelta, clamp } from '../core/mathx.js';

export function createAI({ scene, level, bus, rng, player }) {
  const root = new THREE.Group(); root.name = 'ai'; scene.add(root);
  const nav = createNav(level); nav.rebuild();
  const src = level.aiSpawns?.length ? level.aiSpawns : level.spawns;
  const agents = src.slice(0, 5).map((p, id) => {
    const a = createAgentState(id, rng);
    a.pos = p.clone(); a.yaw = Math.PI; a.body = createAgentBody(root);
    a.path = []; a.pathAt = 0; a.cover = -1; a.losCd = id * 0.018; a.hasLOS = false;
    a.justHit = false; a.justSuppressed = false; a.body.update(0, a.pos, a.yaw, false, a.leanSign, false, 0, a.fallSeed);
    return a;
  });
  const near = [], path = [], offs = [];
  const o = new THREE.Vector3(), d = new THREE.Vector3(), p = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();

  function chooseCover(a) {
    nav.near(a.pos.x, a.pos.z, CFG.coverSearchR, near, 180);
    let best = -1, bs = Infinity;
    for (const i of near) {
      if (!nav.isCover(i)) continue;
      const dx = nav.nodeX(i) - player.position.x, dz = nav.nodeZ(i) - player.position.z;
      const da = Math.hypot(nav.nodeX(i) - a.pos.x, nav.nodeZ(i) - a.pos.z);
      const dp = Math.hypot(dx, dz);
      if (dp < 5 || dp > 34) continue;
      // Prefer lateral cover at useful engagement distance, with a small stable id tie-break.
      const s = da + Math.abs(dp - 16) * 0.32 + i * 1e-5;
      if (s < bs) { bs = s; best = i; }
    }
    if (best < 0) best = nav.find(a.pos.x, a.pos.y, a.pos.z);
    a.cover = best; a.wantRepick = false;
    const from = nav.find(a.pos.x, a.pos.y, a.pos.z);
    nav.path(from, best, a.path); a.pathAt = Math.min(1, a.path.length - 1);
  }

  function updateLOS(a) {
    o.set(a.pos.x, a.pos.y + 1.45, a.pos.z);
    d.set(player.position.x - o.x, player.position.y + 1.25 - o.y, player.position.z - o.z);
    const dist = d.length(); if (dist < 1e-5) { a.hasLOS = true; return 0; }
    d.multiplyScalar(1 / dist);
    const h = level.raycast(o, d, dist);
    a.hasLOS = !h || h.dist >= dist - 0.15;
    return dist;
  }

  function move(a, dt) {
    if (a.state !== 'seek' && a.state !== 'suppressed') return;
    if (a.wantRepick || a.cover < 0) chooseCover(a);
    if (!a.path.length || a.pathAt >= a.path.length) return;
    const ni = a.path[a.pathAt], tx = nav.nodeX(ni), ty = nav.nodeY(ni), tz = nav.nodeZ(ni);
    const dx = tx - a.pos.x, dz = tz - a.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.24) { a.pos.y = ty; a.pathAt++; return; }
    const s = Math.min(l, CFG.moveSpeed * dt);
    p.set(a.pos.x + dx / l * s, a.pos.y, a.pos.z + dz / l * s);
    const c = level.collide(p, AGENT_R, AGENT_H); a.pos.copy(c.pos);
  }

  function fire(a, dist) {
    o.set(a.pos.x, a.pos.y + 1.38, a.pos.z);
    d.set(player.position.x - o.x, player.position.y + 1.25 - o.y, player.position.z - o.z).normalize();
    right.crossVectors(d, up.set(0, 1, 0)).normalize(); up.crossVectors(right, d).normalize();
    const cone = aimSpreadRad(rng, dist, CFG.engageRange), ang = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * Math.tan(cone);
    d.addScaledVector(right, Math.cos(ang) * rr).addScaledVector(up, Math.sin(ang) * rr).normalize();
    const wh = level.raycast(o, d, dist + 3); const max = wh?.dist ?? dist + 3;
    const ph = rayVsVerticalCapsule(o.x, o.y, o.z, d.x, d.y, d.z, player.position.x, player.position.y, player.position.z, 1.78, 0.36, max);
    bus.emit('ai:fire', { id: a.id, pos: o.clone(), dir: d.clone(), maxDist: Math.min(max, dist + 3) });
    if (ph) player.damage(OUTGOING_DMG.base + ((rng() * OUTGOING_DMG.jitter * 2 - OUTGOING_DMG.jitter) | 0), 'rifle', o.clone());
  }

  offs.push(bus.on('weapon:fire', (e) => {
    if (!e.pos || !e.dir) return;
    let target = null, hit = null;
    const max = e.maxDist ?? 260;
    for (const a of agents) {
      if (!a.alive) continue;
      const h = rayVsVerticalCapsule(e.pos.x, e.pos.y, e.pos.z, e.dir.x, e.dir.y, e.dir.z, a.pos.x, a.pos.y, a.pos.z, AGENT_H, AGENT_R, max);
      if (h && (!hit || h.dist < hit.dist)) { target = a; hit = h; }
    }
    if (!target) return;
    const zone = zoneForT((hit.y - target.pos.y) / AGENT_H);
    const dmg = (e.damage ?? 30) * ZONE_MULT[zone];
    target.health = Math.max(0, target.health - dmg); target.justHit = true; target.body.flinch();
    const hp = new THREE.Vector3(e.pos.x + e.dir.x * hit.dist, e.pos.y + e.dir.y * hit.dist, e.pos.z + e.dir.z * hit.dist);
    bus.emit('ai:hit', { id: target.id, damage: dmg, health: target.health, zone, point: hp });
    if (target.health <= 0) {
      target.alive = false; target.state = 'dead'; target.deathT = 0;
      bus.emit('ai:death', { id: target.id, zone, point: hp });
    }
  }));

  offs.push(bus.on('weapon:impact', (e) => {
    const p0 = e.point ?? e.pos; if (!p0) return;
    for (const a of agents) if (a.alive && a.pos.distanceToSquared(p0) < 6.25) a.justSuppressed = true;
  }));

  return {
    agents,
    step(dt) {
      for (const a of agents) {
        if (!a.alive) {
          a.deathT += dt; a.body.update(dt, a.pos, a.yaw, false, a.leanSign, true, a.deathT, a.fallSeed); continue;
        }
        a.losCd -= dt;
        let dist = Math.hypot(player.position.x - a.pos.x, player.position.z - a.pos.z);
        if (a.losCd <= 0) { dist = updateLOS(a); a.losCd += CFG.losCheckInterval; }
        if (a.wantRepick && (a.state === 'seek' || a.state === 'suppressed')) chooseCover(a);
        const atCover = a.cover >= 0 && Math.hypot(nav.nodeX(a.cover) - a.pos.x, nav.nodeZ(a.cover) - a.pos.z) < 0.65;
        stepFSM(a, { hasLOS: a.hasLOS, dist, atCover, justHit: a.justHit, justSuppressed: a.justSuppressed, justDied: false }, dt, rng);
        a.justHit = a.justSuppressed = false;
        move(a, dt);
        const wantYaw = Math.atan2(-(player.position.x - a.pos.x), -(player.position.z - a.pos.z));
        a.yaw += clamp(angleDelta(a.yaw, wantYaw), -CFG.turnRate * dt, CFG.turnRate * dt);
        if (a.wantFire) fire(a, dist);
        a.body.update(dt, a.pos, a.yaw, isExposed(a), a.leanSign, false, 0, a.fallSeed);
      }
    },
    dispose() {
      for (const off of offs) off(); for (const a of agents) a.body.dispose();
      disposeSharedBodyAssets(); scene.remove(root);
    },
  };
}
