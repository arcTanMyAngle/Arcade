// physics.js — custom deterministic physics kernel.
// PURE: imports nothing (node-testable). Operates on plain {x,y,z}. No Math.random.

export const SUBSTEP = 1 / 60; // fixed timestep; every game steps at this rate
export const G = { x: 0, y: -9.81, z: 0 };

// --- vec3 on plain objects (allocation-light; pass out= to reuse) ---
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const set = (a, x, y, z) => { a.x = x; a.y = y; a.z = z; return a; };
export const copy = (a, b) => { a.x = b.x; a.y = b.y; a.z = b.z; return a; };
export const add = (a, b, o = {}) => set(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b, o = {}) => set(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s, o = {}) => set(o, a.x * s, a.y * s, a.z * s);
export const addScaled = (a, b, s, o = {}) => set(o, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b, o = {}) => set(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Semi-implicit Euler: v += a*dt; p += v*dt. Mutates p,v. `acc` in m/s^2.
export function integrate(p, v, acc, dt) {
  v.x += acc.x * dt; v.y += acc.y * dt; v.z += acc.z * dt;
  p.x += v.x * dt;   p.y += v.y * dt;   p.z += v.z * dt;
  return p;
}

// Quadratic wind drag accel: a = -k*(v-w)*|v-w|  (per unit mass). w = wind velocity.
export function windDrag(v, w, k, o = {}) {
  const rx = v.x - w.x, ry = v.y - w.y, rz = v.z - w.z;
  const s = Math.hypot(rx, ry, rz) * k;
  return set(o, -rx * s, -ry * s, -rz * s);
}

// Swept point vs static sphere over segment p0->p1. Returns hit fraction t in [0,1] or -1.
// Solves |p0 + t*d - c|^2 = r^2 for smallest valid t (min approach entering the sphere).
export function sweptPointSphere(p0, p1, c, r) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const ox = p0.x - c.x, oy = p0.y - c.y, oz = p0.z - c.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return (ox * ox + oy * oy + oz * oz <= r * r) ? 0 : -1;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t >= 0 && t <= 1) return t;
  // already inside at start?
  if (cc <= 0) return 0;
  return -1;
}

// Segment crossing of an axis-aligned plane z = zp (normal +/-z). Returns t in [0,1] or -1.
export function segCrossPlaneZ(p0, p1, zp) {
  const d = p1.z - p0.z;
  if (Math.abs(d) < 1e-12) return -1;
  const t = (zp - p0.z) / d;
  return t >= 0 && t <= 1 ? t : -1;
}

// Lerp a point along segment at fraction t (out plain obj).
export function lerpSeg(p0, p1, t, o = {}) {
  return set(o, p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, p0.z + (p1.z - p0.z) * t);
}

// Reflect+damp velocity about a plane normal n (unit): v' = v - (1+e)(v·n)n, tangent *= (1-μk).
export function bounce(v, n, e, muk) {
  const vn = dot(v, n);
  v.x -= (1 + e) * vn * n.x; v.y -= (1 + e) * vn * n.y; v.z -= (1 + e) * vn * n.z;
  const f = 1 - muk;
  v.x *= f; v.y *= f; v.z *= f; // crude tangential friction (per-contact)
  return v;
}

// --- High-striker rail model (Level 2) ------------------------------------
// Impulsive 1-D contact: mallet head (mass mH, speed sH) strikes a resting puck (mass mP)
// with pad restitution e. Momentum + restitution on a stationary target gives the puck's
// launch speed up the rail:  Δv = (1+e)·mH/(mH+mP)·sH.
export function railImpulse(sH, mH, mP, e) {
  return (1 + e) * (mH / (mH + mP)) * sH;
}

// Peak height of a body launched up a rail at v0 against gravity g plus Coulomb rail friction
// modeled as a constant opposing decel μ·g:  a = -(g + μg)  ->  H = v0² / (2·(g + μg)).
// Closed form of the semi-implicit rise integration (matched within a step in tests).
export function railApex(v0, g = -G.y, mu = 0) {
  return (v0 * v0) / (2 * (g + mu * g));
}

// --- Ring Toss rigid-torus solver (Level 4) -------------------------------
// Quaternion {x,y,z,w}. Rotate a vector by q:  v' = v + 2·q_w·(q×v) + 2·q×(q×v).
export function qapply(q, v, o = {}) {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return set(o, v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx));
}
// Integrate orientation from world angular velocity w:  q += 0.5·(0,w)⊗q·dt, renormalized.
export function qIntegrate(q, w, dt) {
  const dw = 0.5 * (-w.x * q.x - w.y * q.y - w.z * q.z) * dt;
  const dx = 0.5 * (w.x * q.w + w.y * q.z - w.z * q.y) * dt;
  const dy = 0.5 * (-w.x * q.z + w.y * q.w + w.z * q.x) * dt;
  const dz = 0.5 * (w.x * q.y - w.y * q.x + w.z * q.w) * dt;
  q.w += dw; q.x += dx; q.y += dy; q.z += dz;
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; q.x /= l; q.y /= l; q.z /= l; q.w /= l; return q;
}
const TAU = Math.PI * 2, _YP = { x: 0, y: 1, z: 0 };
const _conj = (q, o = {}) => set4(o, -q.x, -q.y, -q.z, q.w);
const set4 = (a, x, y, z, w) => { a.x = x; a.y = y; a.z = z; a.w = w; return a; };
function ortho(a, o = {}) { // any unit vector orthogonal to unit a
  const ax = Math.abs(a.x), ay = Math.abs(a.y), az = Math.abs(a.z);
  const r = ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  cross(a, r, o); const l = len(o) || 1; return set(o, o.x / l, o.y / l, o.z / l);
}

// Node (sphere r) vs vertical peg cylinder (shaft band + top rim circle). Returns {pen,n} or null.
function pegContact(nx, ny, nz, peg, r, o) {
  const hx = nx - peg.bx, hz = nz - peg.bz, hd = Math.hypot(hx, hz), top = peg.by + peg.pH;
  if (ny >= peg.by - r && ny <= top && hd > 1e-6) {              // shaft: outward radial normal
    const pen = (peg.pR + r) - hd; if (pen > 0) return { pen, n: set(o, hx / hd, 0, hz / hd) };
  }
  if (ny > top && hd > 1e-6) {                                   // top rim: node vs rim circle
    const rx = peg.bx + hx / hd * peg.pR, rz = peg.bz + hz / hd * peg.pR;
    const dx = nx - rx, dy = ny - top, dz = nz - rz, dl = Math.hypot(dx, dy, dz);
    const pen = r - dl; if (pen > 0 && dl > 1e-6) return { pen, n: set(o, dx / dl, dy / dl, dz / dl) };
  }
  return null;
}
// Node vs board plane (unit normal n through point o0). Returns {pen,n} or null.
function planeContact(nx, ny, nz, bd, r, o) {
  const sd = (nx - bd.ox) * bd.nx + (ny - bd.oy) * bd.ny + (nz - bd.oz) * bd.nz;
  const pen = r - sd; return pen > 0 ? { pen, n: set(o, bd.nx, bd.ny, bd.nz) } : null;
}

// Advance a rigid ring one step against a peg + board, with adaptive micro-substeps so a
// fast thin ring can't tunnel the shaft. Sampled-node torus model: contacts resolved by
// sequential impulses (restitution + Coulomb friction) at each node, torque via arm r×J.
// ring:{p,v,q,w,R,r,m,rest,slp}  peg:{bx,by,bz,pR,pH}  board:{nx,ny,nz,ox,oy,oz}
// P:{g,nodes,pegE,pegMuk,boardE,boardMuk,sleepLin,sleepAng,sleepN}. Returns event {clack,slide,ground}.
const _a = {}, _u = {}, _wv = {}, _n = {}, _rA = {}, _vc = {}, _t = {}, _tmpv = {};
const _CB = Array.from({ length: 32 }, () => ({ cx: 0, cy: 0, cz: 0, nx: 0, ny: 0, nz: 0, pen: 0, e: 0, muk: 0, isPeg: 0 }));
export function stepRing(ring, peg, board, P, dt) {
  const ev = { clack: 0, slide: 0, ground: 0, cp: { x: 0, y: 0, z: 0 } };
  if (ring.rest) return ev;
  const R = ring.R, rr = ring.r, m = ring.m, N = P.nodes;
  const IaxInv = 1 / (m * (R * R + 0.75 * rr * rr));           // torus principal moments (axis=local +y)
  const IdiInv = 1 / (m * (0.5 * R * R + 0.625 * rr * rr));
  const Ii = { x: IdiInv, y: IaxInv, z: IdiInv };
  const micro = Math.min(8, Math.max(1, Math.ceil(len(ring.v) * dt / Math.max(rr, 1e-3))));
  const h = dt / micro;
  const cq = {};
  // world inverse-inertia applied to a vector: R · (Ii ⊙ (Rᵀ·vec))
  const Iinv = (vec, out) => { _conj(ring.q, cq); qapply(cq, vec, out); out.x *= Ii.x; out.y *= Ii.y; out.z *= Ii.z; return qapply(ring.q, out, out); };

  for (let s = 0; s < micro; s++) {
    ring.v.y += P.g * h;                                        // gravity (P.g = -9.81)
    ring.p.x += ring.v.x * h; ring.p.y += ring.v.y * h; ring.p.z += ring.v.z * h;
    qIntegrate(ring.q, ring.w, h);
    qapply(ring.q, _YP, _a); ortho(_a, _u); cross(_a, _u, _wv); // ring plane basis {u,wv}⟂axis a

    // gather node contacts once (positions fixed for this micro-step)
    let nc = 0;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU, cx = Math.cos(th), sn = Math.sin(th);
      const nx = ring.p.x + R * (cx * _u.x + sn * _wv.x);
      const ny = ring.p.y + R * (cx * _u.y + sn * _wv.y);
      const nz = ring.p.z + R * (cx * _u.z + sn * _wv.z);
      let hit = pegContact(nx, ny, nz, peg, rr, _n), isPeg = 1;
      if (!hit) { hit = planeContact(nx, ny, nz, board, rr, _n); isPeg = 0; }
      if (!hit || nc >= _CB.length) continue;
      const b = _CB[nc++];                              // contact point on node surface
      b.cx = nx - _n.x * rr; b.cy = ny - _n.y * rr; b.cz = nz - _n.z * rr;
      b.nx = _n.x; b.ny = _n.y; b.nz = _n.z; b.pen = hit.pen; b.isPeg = isPeg;
      b.e = isPeg ? P.pegE : P.boardE; b.muk = isPeg ? P.pegMuk : P.boardMuk;
    }
    // sequential-impulse velocity solve (positions fixed)
    for (let it = 0; it < 3; it++) {
      for (let k = 0; k < nc; k++) {
        const b = _CB[k]; set(_n, b.nx, b.ny, b.nz);
        _rA.x = b.cx - ring.p.x; _rA.y = b.cy - ring.p.y; _rA.z = b.cz - ring.p.z;
        cross(ring.w, _rA, _vc); _vc.x += ring.v.x; _vc.y += ring.v.y; _vc.z += ring.v.z;
        const vn = dot(_vc, _n); if (vn >= 0) continue;
        const eN = -vn < 0.25 ? 0 : b.e; // restitution slop: no micro-bounce at rest
        cross(_rA, _n, _tmpv); Iinv(_tmpv, _tmpv); cross(_tmpv, _rA, _tmpv);
        const jn = -(1 + eN) * vn / (1 / m + dot(_n, _tmpv));
        ring.v.x += _n.x * jn / m; ring.v.y += _n.y * jn / m; ring.v.z += _n.z * jn / m;
        cross(_rA, _n, _tmpv); _tmpv.x *= jn; _tmpv.y *= jn; _tmpv.z *= jn; Iinv(_tmpv, _tmpv);
        ring.w.x += _tmpv.x; ring.w.y += _tmpv.y; ring.w.z += _tmpv.z;
        // friction along tangent, clamped to μk·jn (jn>0)
        cross(ring.w, _rA, _vc); _vc.x += ring.v.x; _vc.y += ring.v.y; _vc.z += ring.v.z;
        const vnt = dot(_vc, _n);
        set(_t, _vc.x - vnt * _n.x, _vc.y - vnt * _n.y, _vc.z - vnt * _n.z);
        const tl = len(_t);
        if (tl > 1e-5) {
          _t.x /= tl; _t.y /= tl; _t.z /= tl;
          cross(_rA, _t, _tmpv); Iinv(_tmpv, _tmpv); cross(_tmpv, _rA, _tmpv);
          let jt = -dot(_vc, _t) / (1 / m + dot(_t, _tmpv));
          const lim = b.muk * jn; if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
          ring.v.x += _t.x * jt / m; ring.v.y += _t.y * jt / m; ring.v.z += _t.z * jt / m;
          cross(_rA, _t, _tmpv); _tmpv.x *= jt; _tmpv.y *= jt; _tmpv.z *= jt; Iinv(_tmpv, _tmpv);
          ring.w.x += _tmpv.x; ring.w.y += _tmpv.y; ring.w.z += _tmpv.z;
          if (b.isPeg) ev.slide = Math.max(ev.slide, tl);
        }
        if (it === 0) { const mag = Math.abs(jn); if (mag > ev.clack) { ev.clack = mag; set(ev.cp, b.cx, b.cy, b.cz); } if (!b.isPeg) ev.ground = Math.max(ev.ground, mag); }
      }
    }
    // single averaged positional correction (no per-node accumulation blow-up)
    if (nc) {
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < nc; k++) { const b = _CB[k]; sx += b.nx * b.pen; sy += b.ny * b.pen; sz += b.nz * b.pen; }
      ring.p.x += sx / nc * 0.8; ring.p.y += sy / nc * 0.8; ring.p.z += sz / nc * 0.8;
    }
    // settle damping: a ring lying flat on a surface (most nodes touching) bleeds its wobble
    // hard; a slow ring in light contact bleeds gently. Low inertia => clamp spurious spin.
    if (nc >= (N >> 1) && len(ring.v) < 0.4) { scale(ring.v, 0.6, ring.v); scale(ring.w, 0.5, ring.w); }
    else if (len(ring.v) < 0.5 && len(ring.w) < 1.5) { scale(ring.v, 0.9, ring.v); scale(ring.w, 0.9, ring.w); }
  }
  // sleep latch
  if (len(ring.v) < P.sleepLin && len(ring.w) < P.sleepAng) { ring.slp = (ring.slp || 0) + 1; if (ring.slp > P.sleepN) ring.rest = true; }
  else ring.slp = 0;
  return ev;
}

// --- Basketball solvers (Level 5) -----------------------------------------
// Sphere (center b, radius bR) vs horizontal torus rim {cx,cy,cz,Rr,Tr} (axis +y).
// Closest point on the rim centerline circle -> contact normal. Null if clear, or over the
// axis (ball through the hole). Returns {pen, n} (n = shared scratch, use immediately).
const _stn = {};
export function sphereTorus(b, bR, T) {
  const dx = b.x - T.cx, dz = b.z - T.cz, hd = Math.hypot(dx, dz);
  if (hd < 1e-6) return null;                                  // over the hole: no tube contact
  const cxp = T.cx + dx / hd * T.Rr, czp = T.cz + dz / hd * T.Rr; // nearest rim-circle point
  const tx = b.x - cxp, ty = b.y - T.cy, tz = b.z - czp, tl = Math.hypot(tx, ty, tz);
  const pen = (bR + T.Tr) - tl;
  if (pen <= 0 || tl < 1e-9) return null;
  _stn.x = tx / tl; _stn.y = ty / tl; _stn.z = tz / tl;
  return { pen, n: _stn };
}

// Resolve a spinning solid ball {p,v,w,r,m} against one contact (unit normal n toward the ball,
// penetration pen): positional push-out + restitution e + Coulomb friction μ. Friction uses the
// surface velocity v+ω×rA, so backspin redirects a rim clip toward center — the "shooter's roll".
// Returns |normal impulse| (for audio). Solid-sphere inertia I = 2/5·m·r².
export function resolveBallContact(ball, n, pen, e, mu) {
  ball.p.x += n.x * pen; ball.p.y += n.y * pen; ball.p.z += n.z * pen;
  const r = ball.r, m = ball.m, Ii = 1 / (0.4 * m * r * r);
  const rax = -n.x * r, ray = -n.y * r, raz = -n.z * r;        // arm center->contact = -n·r
  const w = ball.w, v = ball.v;
  let vcx = v.x + (w.y * raz - w.z * ray), vcy = v.y + (w.z * rax - w.x * raz), vcz = v.z + (w.x * ray - w.y * rax);
  const vn = vcx * n.x + vcy * n.y + vcz * n.z;
  if (vn >= 0) return 0;
  const eN = -vn < 0.4 ? 0 : e;                                // restitution slop near rest
  const cxn = ray * n.z - raz * n.y, cyn = raz * n.x - rax * n.z, czn = rax * n.y - ray * n.x; // rA×n
  const jn = -(1 + eN) * vn / (1 / m + Ii * (cxn * cxn + cyn * cyn + czn * czn));
  v.x += n.x * jn / m; v.y += n.y * jn / m; v.z += n.z * jn / m;
  w.x += Ii * (ray * (jn * n.z) - raz * (jn * n.y)); w.y += Ii * (raz * (jn * n.x) - rax * (jn * n.z)); w.z += Ii * (rax * (jn * n.y) - ray * (jn * n.x));
  // friction along the tangent of the (recomputed) surface velocity, clamped to μ·jn
  vcx = v.x + (w.y * raz - w.z * ray); vcy = v.y + (w.z * rax - w.x * raz); vcz = v.z + (w.x * ray - w.y * rax);
  const vn2 = vcx * n.x + vcy * n.y + vcz * n.z;
  let tx = vcx - vn2 * n.x, ty = vcy - vn2 * n.y, tz = vcz - vn2 * n.z;
  const tl = Math.hypot(tx, ty, tz);
  if (tl > 1e-5) {
    tx /= tl; ty /= tl; tz /= tl;
    const cxt = ray * tz - raz * ty, cyt = raz * tx - rax * tz, czt = rax * ty - ray * tx;
    let jt = -(vcx * tx + vcy * ty + vcz * tz) / (1 / m + Ii * (cxt * cxt + cyt * cyt + czt * czt));
    const lim = mu * jn; if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
    v.x += tx * jt / m; v.y += ty * jt / m; v.z += tz * jt / m;
    w.x += Ii * (ray * (jt * tz) - raz * (jt * ty)); w.y += Ii * (raz * (jt * tx) - rax * (jt * tz)); w.z += Ii * (rax * (jt * ty) - ray * (jt * tx));
  }
  return Math.abs(jn);
}

// mulberry32 seeded PRNG -> deterministic [0,1). Use for ALL variation. Never Math.random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-material contact constants (explicit — no engine defaults).
export const MAT = {
  wood:   { e: 0.30, mus: 0.7, muk: 0.5 },
  metal:  { e: 0.55, mus: 0.4, muk: 0.3 },
  rubber: { e: 0.75, mus: 0.9, muk: 0.7 },
  felt:   { e: 0.15, mus: 0.95, muk: 0.8 }
};
