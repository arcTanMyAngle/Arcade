// Static-world collision. OWNED BY: level/environment agent.
//
// Vertical capsule vs axis-aligned brushes + ray vs brushes. Brushes are emitted
// by the same builder call that emits render geometry (level.js `box()`/`cyl()`/
// `ramp()`/...), so visual and collision geometry can never desync.
//
// Both queries run through a uniform XZ grid broadphase. The map ships ~2.5k
// brushes; collide() runs 4 resolution passes every 128 Hz tick and raycast() is
// hit by every bullet, every AI line-of-sight probe, and three player probes per
// tick (floor / ceiling / mantle). Brute force over 2.5k AABBs is ~10k pointer
// chases per tick; the grid makes it ~40. Rays use a 2D DDA so a 200 m tracer
// only touches the cells it actually crosses.
//
// RESOLUTION SEMANTICS ARE DELIBERATELY UNCHANGED from level.js's original
// inline collide(): axis-of-least-penetration, with "stand on top" preferred
// only when the vertical overlap is the shallower fix and the feet are already
// inside the STEP_UP window. player/controller.js is written against exactly
// that contract — it does its own step-up sweep (STEP.max = 0.35) and its
// canStand() treats ANY vertical lift out of collide() as "blocked". A collider
// that auto-steps the player onto every ledge (as the previous draft of this
// file did) silently breaks uncrouch and mantle headroom.
//
// Zero DOM/render deps on purpose — this file is unit-testable under plain node.

import * as THREE from 'three';

// Feet must already be within this much of a brush top for "stand on top" to win
// over horizontal depenetration. NOT a step-up allowance — see the note above.
export const STEP_UP = 0.55;

const CELL = 4;                 // broadphase cell size, metres
const BIG_AREA = 400;           // brushes with a bigger XZ footprint skip the grid

const clampf = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createCollider(brushes, { floor = -2.4 } = {}) {
  const n = brushes.length;

  // ---- broadphase build --------------------------------------------------
  const isBig = new Uint8Array(n);
  const big = [];
  let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = brushes[i];
    if ((b.max.x - b.min.x) * (b.max.z - b.min.z) > BIG_AREA) { isBig[i] = 1; big.push(i); continue; }
    if (b.min.x < mnx) mnx = b.min.x;
    if (b.min.z < mnz) mnz = b.min.z;
    if (b.max.x > mxx) mxx = b.max.x;
    if (b.max.z > mxz) mxz = b.max.z;
  }
  const has = mnx <= mxx;
  const ox = has ? mnx - CELL : 0, oz = has ? mnz - CELL : 0;
  const nx = has ? Math.ceil((mxx - ox) / CELL) + 2 : 1;
  const nz = has ? Math.ceil((mxz - oz) / CELL) + 2 : 1;
  const cells = new Array(nx * nz);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const ci = (x) => clampf(Math.floor((x - ox) / CELL), 0, nx - 1);
  const cj = (z) => clampf(Math.floor((z - oz) / CELL), 0, nz - 1);

  for (let i = 0; i < n; i++) {
    if (isBig[i]) continue;
    const b = brushes[i];
    const x0 = ci(b.min.x), x1 = ci(b.max.x), z0 = cj(b.min.z), z1 = cj(b.max.z);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells[z * nx + x].push(i);
  }

  // Dedupe stamp — avoids a Set allocation per query. Two independent stamps so
  // an in-flight collide() candidate list can never be clobbered by a raycast.
  const cstamp = new Int32Array(n), rstamp = new Int32Array(n);
  let ctok = 0, rtok = 0;
  const cand = [];

  function gather(x0, z0, x1, z1) {
    cand.length = 0; ctok++;
    for (let k = 0; k < big.length; k++) { cstamp[big[k]] = ctok; cand.push(big[k]); }
    const a = ci(x0), b2 = ci(x1), c = cj(z0), d = cj(z1);
    for (let z = c; z <= d; z++) {
      const row = z * nx;
      for (let x = a; x <= b2; x++) {
        const list = cells[row + x];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (cstamp[i] !== ctok) { cstamp[i] = ctok; cand.push(i); }
        }
      }
    }
    return cand;
  }

  // ---- capsule vs brushes ------------------------------------------------
  const _p = new THREE.Vector3();

  function collide(pos, radius, height) {
    _p.copy(pos);
    let grounded = false;
    // Query is padded by 1 m so the candidate list stays valid while resolution
    // pushes the position around.
    gather(_p.x - radius - 1, _p.z - radius - 1, _p.x + radius + 1, _p.z + radius + 1);

    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (let k = 0; k < cand.length; k++) {
        const b = brushes[cand[k]];
        const feet = _p.y, head = _p.y + height;
        if (head < b.min.y || feet > b.max.y) continue;

        const cx = clampf(_p.x, b.min.x, b.max.x), cz = clampf(_p.z, b.min.z, b.max.z);
        const dx = _p.x - cx, dz = _p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;

        // Exact contact with a support plane has zero overlap, so it must be
        // recognized before depenetration. Without this, a player standing at
        // y=0 alternates grounded/airborne every other 128 Hz tick.
        if (Math.abs(feet - b.max.y) <= 1e-5 && head > b.max.y) { grounded = true; continue; }

        const overlapY = Math.min(head, b.max.y) - Math.max(feet, b.min.y);
        const d = Math.sqrt(d2);
        const pushXZ = radius - d;

        if (overlapY < pushXZ && feet < b.max.y && feet > b.max.y - STEP_UP) {
          if (Math.abs(b.max.y - _p.y) > 1e-6) moved = true;
          _p.y = b.max.y; grounded = true;
        } else if (d2 > 1e-9) {
          _p.x += (dx / d) * pushXZ;
          _p.z += (dz / d) * pushXZ;
          moved = true;
        } else {
          // Dead centre in XZ: leave along the SHALLOWEST face. The original
          // inline version always pushed +x here, which could teleport the
          // player through a thin brush.
          const ex = Math.min(_p.x - b.min.x, b.max.x - _p.x);
          const ez = Math.min(_p.z - b.min.z, b.max.z - _p.z);
          if (ex <= ez) _p.x += (_p.x >= (b.min.x + b.max.x) * 0.5 ? 1 : -1) * (ex + radius);
          else _p.z += (_p.z >= (b.min.z + b.max.z) * 0.5 ? 1 : -1) * (ez + radius);
          moved = true;
        }
      }
      if (!moved) break;
    }

    // World backstop. The level tiles the whole play area with ground brushes, so
    // this only fires if something teleports the player into the void.
    if (_p.y <= floor + 1e-6) { _p.y = floor; grounded = true; }
    return { pos: _p, grounded };
  }

  // ---- ray vs brushes ----------------------------------------------------
  // Slab test per brush, driven by a 2D DDA over the same grid.
  // Returns { dist, normal, mat, point } — dist/normal are bit-identical to the
  // original inline implementation; `mat` is the brush's material-name string,
  // used by weapons/fx/audio for surface-typed impacts.
  function raycast(origin, dir, maxDist = 200) {
    let best = maxDist, nx_ = 0, ny_ = 0, nz_ = 0, hit = false, hm = null;

    const testBrush = (i) => {
      const b = brushes[i];
      let t0 = 0, t1 = best, ax = 0, s = 0;
      let inv = 1 / (dir.x || 1e-9);
      let ta = (b.min.x - origin.x) * inv, tb = (b.max.x - origin.x) * inv, sg = -Math.sign(dir.x || 1e-9);
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) { t0 = ta; ax = 1; s = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;
      inv = 1 / (dir.y || 1e-9);
      ta = (b.min.y - origin.y) * inv; tb = (b.max.y - origin.y) * inv; sg = -Math.sign(dir.y || 1e-9);
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) { t0 = ta; ax = 2; s = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;
      inv = 1 / (dir.z || 1e-9);
      ta = (b.min.z - origin.z) * inv; tb = (b.max.z - origin.z) * inv; sg = -Math.sign(dir.z || 1e-9);
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) { t0 = ta; ax = 3; s = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;

      if (t0 < best && t0 > 1e-3) {
        best = t0; hit = true; hm = b.mat ?? null;
        nx_ = ax === 1 ? s : 0; ny_ = ax === 2 ? s : 0; nz_ = ax === 3 ? s : 0;
      }
    };

    rtok++;
    for (let k = 0; k < big.length; k++) { rstamp[big[k]] = rtok; testBrush(big[k]); }
    const done = () => (hit ? mk(best, nx_, ny_, nz_, hm, origin, dir) : null);
    if (!has) return done();

    // Clip the ray to the grid footprint in XZ before stepping.
    let t0 = 0, t1 = best;
    for (let a = 0; a < 2; a++) {
      const o = a ? origin.z : origin.x, dd = a ? dir.z : dir.x;
      const lo = a ? oz : ox, hi = (a ? oz + nz * CELL : ox + nx * CELL);
      if (Math.abs(dd) < 1e-9) { if (o < lo || o > hi) return done(); continue; }
      let ta = (lo - o) / dd, tb = (hi - o) / dd;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1) return done();

    let cx = ci(origin.x + dir.x * (t0 + 1e-4));
    let cz = cj(origin.z + dir.z * (t0 + 1e-4));
    const sx = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const sz = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const dtx = sx ? CELL / Math.abs(dir.x) : Infinity;
    const dtz = sz ? CELL / Math.abs(dir.z) : Infinity;
    let tmx = sx ? ((ox + (cx + (sx > 0 ? 1 : 0)) * CELL) - origin.x) / dir.x : Infinity;
    let tmz = sz ? ((oz + (cz + (sz > 0 ? 1 : 0)) * CELL) - origin.z) / dir.z : Infinity;

    let enter = t0, guard = 0;
    for (;;) {
      if (enter > best || enter > t1 || ++guard > 4096) break;
      const list = cells[cz * nx + cx];
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (rstamp[i] !== rtok) { rstamp[i] = rtok; testBrush(i); }
      }
      if (tmx === Infinity && tmz === Infinity) break;
      if (tmx < tmz) { enter = tmx; cx += sx; tmx += dtx; } else { enter = tmz; cz += sz; tmz += dtz; }
      if (cx < 0 || cx >= nx || cz < 0 || cz >= nz) break;
    }
    return done();
  }

  function mk(dist, x, y, z, mat, o, d) {
    return {
      dist, mat,
      normal: new THREE.Vector3(x, y, z),
      point: new THREE.Vector3(o.x + d.x * dist, o.y + d.y * dist, o.z + d.z * dist),
    };
  }

  // Cheap diagnostic for tests / tuning.
  function stats() {
    let occupied = 0, max = 0, total = 0;
    for (const c of cells) { if (c.length) { occupied++; total += c.length; max = Math.max(max, c.length); } }
    return { brushes: n, cells: cells.length, occupied, avgPerCell: occupied ? total / occupied : 0, maxPerCell: max, big: big.length };
  }

  return { collide, raycast, stats, cellSize: CELL, bigCount: big.length };
}
