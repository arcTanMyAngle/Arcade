// Navigation — coarse walkable-cell graph DERIVED FROM `level.brushes` at runtime.
//
// Nothing here is hardcoded to the current blockout: bounds, floor heights and
// clearance all fall out of the brush list, and the graph rebuilds itself when the
// level agent swaps the brushes underneath us (see `poll()`).
//
// Layering: one XZ cell can produce several nodes (ground + a walkway above it),
// so multi-storey geometry works without a real navmesh. Every candidate node is
// validated with `level.collide()` — if the capsule gets pushed, the node is
// rejected, which is what guarantees agents never path into geometry.

const AGENT_R = 0.36;      // must match the agent capsule used in index.js
const AGENT_H = 1.78;
const STEP_UP = 0.62;      // max height an agent will step/scramble up between cells
const HEADROOM = 1.84;     // vertical space required above a walkable surface
const MAX_NODES = 9000;    // hard cap; cell size grows until the graph fits

// ---------------------------------------------------------------------------
// binary heap (indices + float keys, zero alloc after construction)
function createHeap(cap) {
  const idx = new Int32Array(cap), key = new Float32Array(cap);
  let n = 0;
  const swap = (a, b) => {
    const ti = idx[a], tk = key[a];
    idx[a] = idx[b]; key[a] = key[b]; idx[b] = ti; key[b] = tk;
  };
  return {
    get size() { return n; },
    clear() { n = 0; },
    push(i, k) {
      if (n >= cap) return;                       // overflow guard: drop worst-case dupes
      let c = n++; idx[c] = i; key[c] = k;
      while (c > 0) { const p = (c - 1) >> 1; if (key[p] <= key[c]) break; swap(p, c); c = p; }
    },
    pop() {
      const top = idx[0];
      if (--n > 0) {
        idx[0] = idx[n]; key[0] = key[n];
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < n && key[l] < key[m]) m = l;
          if (r < n && key[r] < key[m]) m = r;
          if (m === c) break;
          swap(m, c); c = m;
        }
      }
      return top;
    },
  };
}

export function createNav(level) {
  let G = null;            // current graph
  let sig = '';            // brush-list signature; changes => rebuild

  // -------------------------------------------------------------------------
  function signature(brushes) {
    let h = brushes.length * 2654435761;
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      h = (h ^ Math.round((b.min.x + b.max.y * 7.3 + b.max.z * 13.1) * 64)) * 16777619 | 0;
    }
    return `${brushes.length}:${h}`;
  }

  function build() {
    const brushes = level.brushes;
    const t0 = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

    // Bounds come from OBSTACLE brushes only — the ground slab is 240 m wide and
    // would otherwise produce 57 k cells of empty asphalt.
    for (const b of brushes) {
      if (b.max.y <= 0.3 || b.max.y - b.min.y <= 0.5) continue;
      if (b.min.x < t0.minX) t0.minX = b.min.x;
      if (b.max.x > t0.maxX) t0.maxX = b.max.x;
      if (b.min.z < t0.minZ) t0.minZ = b.min.z;
      if (b.max.z > t0.maxZ) t0.maxZ = b.max.z;
    }
    if (!isFinite(t0.minX)) {                       // degenerate level: small default pad
      t0.minX = t0.minZ = -20; t0.maxX = t0.maxZ = 20;
    }
    const pad = 3.5;
    let x0 = t0.minX - pad, x1 = t0.maxX + pad, z0 = t0.minZ - pad, z1 = t0.maxZ + pad;

    let cell = 1.0;
    let gw, gd;
    for (;;) {
      gw = Math.max(2, Math.ceil((x1 - x0) / cell));
      gd = Math.max(2, Math.ceil((z1 - z0) / cell));
      if (gw * gd <= MAX_NODES) break;
      cell *= 1.3;
    }

    // ---- candidate surfaces per cell ---------------------------------------
    const px = [], py = [], pz = [], pcell = [];
    const surf = [];
    const tmp = { x: 0, y: 0, z: 0 };

    for (let gz = 0; gz < gd; gz++) {
      for (let gx = 0; gx < gw; gx++) {
        const x = x0 + (gx + 0.5) * cell, z = z0 + (gz + 0.5) * cell;
        surf.length = 0;
        for (const b of brushes) {
          if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
          const y = b.max.y;
          let dup = false;
          for (let i = 0; i < surf.length; i++) if (Math.abs(surf[i] - y) < 0.3) { dup = true; break; }
          if (!dup) surf.push(y);
        }
        for (const y of surf) {
          // headroom: any brush overlapping (y, y+HEADROOM) over this cell kills it
          let blocked = false;
          for (const b of brushes) {
            if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
            if (b.max.y > y + 0.06 && b.min.y < y + HEADROOM) { blocked = true; break; }
          }
          if (blocked) continue;
          // capsule clearance — the authoritative test. Feet sit slightly ABOVE the
          // support surface so the supporting brush is skipped by level.collide().
          tmp.x = x; tmp.y = y + 0.05; tmp.z = z;
          const r = level.collide(tmp, AGENT_R, AGENT_H);
          if (Math.abs(r.pos.x - x) > 0.05 || Math.abs(r.pos.z - z) > 0.05) continue;
          if (Math.abs(r.pos.y - tmp.y) > 0.06) continue;
          px.push(x); py.push(y); pz.push(z); pcell.push(gz * gw + gx);
        }
      }
    }

    const n = px.length;
    const nx = new Float32Array(px), ny = new Float32Array(py), nz = new Float32Array(pz);

    // ---- cell -> node buckets (counting sort, no Maps) ----------------------
    const cellStart = new Int32Array(gw * gd + 1);
    for (let i = 0; i < n; i++) cellStart[pcell[i] + 1]++;
    for (let i = 0; i < gw * gd; i++) cellStart[i + 1] += cellStart[i];
    const cellNodes = new Int32Array(n);
    const cur = cellStart.slice(0, gw * gd);
    for (let i = 0; i < n; i++) cellNodes[cur[pcell[i]]++] = i;

    // ---- edges -------------------------------------------------------------
    const adjTmp = [];
    for (let i = 0; i < n; i++) adjTmp.push([]);
    const OFF = [[1, 0], [0, 1], [1, 1], [1, -1]];   // half the ring; edges are symmetric
    for (let i = 0; i < n; i++) {
      const c = pcell[i], gx = c % gw, gz = (c / gw) | 0;
      for (const [ox, oz] of OFF) {
        const bx = gx + ox, bz = gz + oz;
        if (bx < 0 || bz < 0 || bx >= gw || bz >= gd) continue;
        const cb = bz * gw + bx;
        for (let k = cellStart[cb]; k < cellStart[cb + 1]; k++) {
          const j = cellNodes[k];
          if (Math.abs(ny[j] - ny[i]) > STEP_UP) continue;
          if (!clearSeg(nx[i], ny[i], nz[i], nx[j], ny[j], nz[j])) continue;
          // Diagonals additionally require both orthogonal cells to exist, or agents
          // clip wall corners.
          if (ox !== 0 && oz !== 0 && !(cellHas(gx + ox, gz, ny[i]) && cellHas(gx, gz + oz, ny[i]))) continue;
          const d = Math.hypot(nx[j] - nx[i], nz[j] - nz[i]) + Math.abs(ny[j] - ny[i]) * 1.6;
          adjTmp[i].push(j, d); adjTmp[j].push(i, d);
        }
      }
    }

    function cellHas(gx, gz, nearY) {
      if (gx < 0 || gz < 0 || gx >= gw || gz >= gd) return false;
      const c = gz * gw + gx;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) if (Math.abs(ny[cellNodes[k]] - nearY) <= STEP_UP) return true;
      return false;
    }

    function clearSeg(ax, ay, az, bx, by, bz) {
      for (let s = 1; s <= 2; s++) {
        const t = s / 3;
        tmp.x = ax + (bx - ax) * t; tmp.z = az + (bz - az) * t;
        tmp.y = Math.max(ay, by) + 0.05;
        const r = level.collide(tmp, AGENT_R, AGENT_H);
        if (Math.abs(r.pos.x - tmp.x) > 0.06 || Math.abs(r.pos.z - tmp.z) > 0.06) return false;
      }
      return true;
    }

    const adjStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + (adjTmp[i].length >> 1);
    const adj = new Int32Array(adjStart[n]);
    const adjW = new Float32Array(adjStart[n]);
    for (let i = 0, o = 0; i < n; i++) {
      for (let k = 0; k < adjTmp[i].length; k += 2) { adj[o] = adjTmp[i][k]; adjW[o] = adjTmp[i][k + 1]; o++; }
    }

    // ---- cover affinity ----------------------------------------------------
    // A node is "cover-ish" when it sits beside something solid: fewer than 8 walkable
    // neighbours at similar height means a wall/crate edge is adjacent. Shrinks the
    // cover search from every node to a few hundred.
    const nearWall = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (adjStart[i + 1] - adjStart[i] < 8) nearWall[i] = 1;

    return {
      n, nx, ny, nz, adj, adjW, adjStart, nearWall,
      cell, x0, z0, gw, gd, cellStart, cellNodes,
      // A* scratch, version-stamped so we never clear big arrays
      g: new Float32Array(n), from: new Int32Array(n), seen: new Uint32Array(n),
      closed: new Uint32Array(n), token: 0,
      heap: createHeap(Math.max(64, n * 3)),
    };
  }

  // -------------------------------------------------------------------------
  function cellOf(x, z) {
    const gx = Math.floor((x - G.x0) / G.cell), gz = Math.floor((z - G.z0) / G.cell);
    if (gx < 0 || gz < 0 || gx >= G.gw || gz >= G.gd) return -1;
    return gz * G.gw + gx;
  }

  // Nearest node to a world point. Searches an expanding ring so an agent standing
  // fractionally inside a wall still finds a legal node.
  function find(x, y, z, maxRing = 3) {
    if (!G || G.n === 0) return -1;
    const gx0 = Math.floor((x - G.x0) / G.cell), gz0 = Math.floor((z - G.z0) / G.cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const gx = gx0 + dx, gz = gz0 + dz;
          if (gx < 0 || gz < 0 || gx >= G.gw || gz >= G.gd) continue;
          const c = gz * G.gw + gx;
          for (let k = G.cellStart[c]; k < G.cellStart[c + 1]; k++) {
            const i = G.cellNodes[k];
            const d = (G.nx[i] - x) ** 2 + (G.nz[i] - z) ** 2 + ((G.ny[i] - y) * 2.2) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  // A* — returns node count written into `out`, or 0 if unreachable.
  function path(a, b, out) {
    out.length = 0;
    if (!G || a < 0 || b < 0 || a >= G.n || b >= G.n) return 0;
    if (a === b) { out.push(a); return 1; }
    const t = ++G.token;
    const { g, from, seen, closed, heap, nx, ny, nz, adj, adjW, adjStart } = G;
    heap.clear();
    g[a] = 0; from[a] = -1; seen[a] = t;
    const h = (i) => Math.hypot(nx[i] - nx[b], nz[i] - nz[b]) + Math.abs(ny[i] - ny[b]);
    heap.push(a, h(a));
    let iter = 0;
    while (heap.size > 0 && iter++ < 6000) {
      const c = heap.pop();
      if (closed[c] === t) continue;
      closed[c] = t;
      if (c === b) {
        for (let i = b; i >= 0; i = from[i]) out.push(i);
        out.reverse();
        return out.length;
      }
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (closed[j] === t) continue;
        const ng = g[c] + adjW[k];
        if (seen[j] === t && ng >= g[j]) continue;
        seen[j] = t; g[j] = ng; from[j] = c;
        heap.push(j, ng + h(j));
      }
    }
    return 0;
  }

  // Fill `out` with node indices inside a radius. Bounded by `cap`.
  function near(x, z, radius, out, cap = 256) {
    out.length = 0;
    if (!G) return 0;
    const r2 = radius * radius;
    const g0x = Math.floor((x - radius - G.x0) / G.cell), g1x = Math.floor((x + radius - G.x0) / G.cell);
    const g0z = Math.floor((z - radius - G.z0) / G.cell), g1z = Math.floor((z + radius - G.z0) / G.cell);
    for (let gz = Math.max(0, g0z); gz <= Math.min(G.gd - 1, g1z); gz++) {
      for (let gx = Math.max(0, g0x); gx <= Math.min(G.gw - 1, g1x); gx++) {
        const c = gz * G.gw + gx;
        for (let k = G.cellStart[c]; k < G.cellStart[c + 1]; k++) {
          const i = G.cellNodes[k];
          if ((G.nx[i] - x) ** 2 + (G.nz[i] - z) ** 2 > r2) continue;
          out.push(i);
          if (out.length >= cap) return out.length;
        }
      }
    }
    return out.length;
  }

  function rebuild() { G = build(); sig = signature(level.brushes); return G; }

  return {
    get graph() { return G; },
    get count() { return G ? G.n : 0; },
    get cellSize() { return G ? G.cell : 1; },
    nodeX: (i) => G.nx[i], nodeY: (i) => G.ny[i], nodeZ: (i) => G.nz[i],
    isCover: (i) => !!G.nearWall[i],
    find, path, near, cellOf, rebuild,
    // Cheap dirty check — the level agent may swap brushes at any time.
    poll() {
      const s = signature(level.brushes);
      if (s !== sig) { rebuild(); return true; }
      return false;
    },
  };
}
