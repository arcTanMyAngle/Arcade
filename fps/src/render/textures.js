// Procedural texture synthesis. NO binary assets (house rule) — every albedo,
// normal, roughness, AO and metalness channel in BREACHPOINT is generated here
// from seeded lattice noise. No Math.random, no image decode, no DOM.
//
// OWNED BY: materials/texture agent. `materials.js` is the registry that turns
// these byte buffers into THREE materials; this file is pure data synthesis and
// is therefore node-testable (no `document`, no `THREE`).
//
// ---------------------------------------------------------------------------
// Why the noise is re-implemented here
// ---------------------------------------------------------------------------
// `core/rng.js` exposes fbm2/ridge2/worley2 as *point* samplers. Evaluating them
// per texel costs 4 `hash2` calls per octave per pixel — 512² x 5 octaves is
// 5.2 M hashes for ONE field, and a material needs six. The field functions
// below are bit-identical (same `hash2`, same seed strides, same fade curve,
// same wrap) but tabulate the lattice and the fade weights once, which is ~15x
// faster. `hash2` remains the single source of entropy.

import { hash2 } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/mathx.js';

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const F = (n) => new Float32Array(n);

// Linear reflectance -> sRGB byte. Albedo is authored in LINEAR physical values
// (concrete ~0.26, asphalt ~0.09, steel F0 ~0.56) and encoded on write, so the
// numbers in each generator can be checked against a real albedo chart.
export const encodeSRGB = (l) =>
  l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;

// ---------------------------------------------------------------------------
// noise fields (tileable, anisotropic-capable)
// ---------------------------------------------------------------------------

// One value-noise octave accumulated into `dst`. px/py are lattice cells across
// the tile — separate axes give stretched grain (brushed metal, water streaks,
// wood) for free. Wraps on the lattice, so every field tiles seamlessly.
function octave(dst, size, px, py, seed, amp, ridged) {
  // Lattice dims MUST be integers: the grid is indexed `g[j*px + i]`, so a
  // fractional px yields non-integer indices — typed arrays silently drop those
  // writes and read back `undefined` -> NaN -> every albedo byte coerces to 0.
  // That failure is completely silent and renders the material pure black.
  px = Math.max(1, Math.round(px));
  py = Math.max(1, Math.round(py));
  const g = F(px * py);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) g[j * px + i] = hash2(i, j, seed);

  const ax0 = new Int32Array(size), ax1 = new Int32Array(size), aw = F(size);
  const ay0 = new Int32Array(size), ay1 = new Int32Array(size), bw = F(size);
  const axis = (p, i0, i1, w) => {
    const sc = p / size;
    for (let k = 0; k < size; k++) {
      const t = k * sc, c = Math.floor(t);
      i0[k] = ((c % p) + p) % p;
      i1[k] = (i0[k] + 1) % p;
      w[k] = fade(t - c);
    }
  };
  axis(px, ax0, ax1, aw);
  axis(py, ay0, ay1, bw);

  for (let y = 0; y < size; y++) {
    const r0 = ay0[y] * px, r1 = ay1[y] * px, wy = bw[y], row = y * size;
    for (let x = 0; x < size; x++) {
      const i0 = ax0[x], i1 = ax1[x], wx = aw[x];
      const a = g[r0 + i0], b = g[r0 + i1], c = g[r1 + i0], d = g[r1 + i1];
      const t = a + (b - a) * wx;
      let v = t + (c + (d - c) * wx - t) * wy;
      if (ridged) { v = 1 - Math.abs(v * 2 - 1); v *= v; }
      dst[row + x] += amp * v;
    }
  }
}

function stack(size, px, py, seed, oct, gain, ridged) {
  const dst = F(size * size);
  let amp = 1, norm = 0, a = Math.max(1, Math.round(px)), b = Math.max(1, Math.round(py));
  const stride = ridged ? 7919 : 1013;
  for (let i = 0; i < oct; i++) {
    if (a > size * 2 || b > size * 2) break;      // past Nyquist: pure aliasing
    octave(dst, size, a, b, seed + i * stride, amp, ridged);
    norm += amp; amp *= gain; a *= 2; b *= 2;
  }
  // If the Nyquist guard skipped every octave (a lattice authored for 1024 being
  // asked for at 64), norm is 0 and 1/norm is Infinity — which turns the whole
  // field into NaN and, downstream, a silently black material. Fall back to one
  // clamped octave so a small size degrades in quality, never into garbage.
  if (norm === 0) {
    octave(dst, size, Math.min(px, size), Math.min(py, size), seed, 1, ridged);
    norm = 1;
  }
  const inv = 1 / norm;
  for (let i = 0; i < dst.length; i++) dst[i] *= inv;
  return dst;
}

/** fBm field. `px`/`py` = lattice cells across the tile (px!=py -> stretched). */
export const fbm = (size, px, py, seed, oct = 5, gain = 0.5) => stack(size, px, py, seed, oct, gain, false);

/** Ridged fBm — cracks, scratches, wood grain, rust flake edges. */
export const ridge = (size, px, py, seed, oct = 4, gain = 0.5) => stack(size, px, py, seed, oct, gain, true);

/** Worley F1 (or F2-F1 with `f2`) — aggregate, paint chips, pebbles, rust cells. */
export function worley(size, cx, cy, seed, f2 = false) {
  const n = cx * cy, fx = F(n), fy = F(n);
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const k = j * cx + i;
    fx[k] = i + hash2(i, j, seed);
    fy[k] = j + hash2(i, j, seed + 3301);
  }
  const out = F(size * size), sx = cx / size, sy = cy / size;
  for (let y = 0; y < size; y++) {
    const py = y * sy, gy = Math.floor(py), row = y * size;
    for (let x = 0; x < size; x++) {
      const pxf = x * sx, gx = Math.floor(pxf);
      let d1 = 1e9, d2 = 1e9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const ux = gx + i, uy = gy + j;
        const wx = ((ux % cx) + cx) % cx, wy = ((uy % cy) + cy) % cy;
        const dx = fx[wy * cx + wx] + (ux - wx) - pxf;
        const dy = fy[wy * cx + wx] + (uy - wy) - py;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      out[row + x] = f2 ? Math.min(1, Math.sqrt(d2) - Math.sqrt(d1)) : Math.min(1, Math.sqrt(d1));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// field ops
// ---------------------------------------------------------------------------

export function norm01(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  const o = F(a.length);
  for (let i = 0; i < a.length; i++) o[i] = (a[i] - lo) * k;
  return o;
}

export const fill = (size, v) => F(size * size).fill(v);

// Separable wrapping box blur (sliding window, O(n) in radius). Used for the AO
// bake and for softening masks.
export function blur(src, size, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = F(size * size), out = F(size * size), w = r * 2 + 1, inv = 1 / w;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + ((k % size) + size) % size];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum * inv;
      sum -= src[row + (((x - r) % size) + size) % size];
      sum += src[row + (((x + r + 1) % size) + size) % size];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[((((k % size) + size) % size) * size) + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum * inv;
      sum -= tmp[(((y - r) % size + size) % size) * size + x];
      sum += tmp[(((y + r + 1) % size + size) % size) * size + x];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// bakes
// ---------------------------------------------------------------------------

// Multi-scale cavity AO from the height field: a texel sitting below its local
// neighbourhood average is occluded by whatever is around it. Three radii cover
// pore-scale, crack-scale and macro-scale occlusion. This is the single biggest
// difference between "procedural noise" and "a surface" — without it, every
// normal-mapped bump lights identically from every direction and reads flat.
export function bakeAO(h, size, { radii = [1, 5, 16], w = [0.9, 1.35, 1.0], strength = 1, floorAO = 0.22 } = {}) {
  const ao = F(size * size).fill(1);
  for (let s = 0; s < radii.length; s++) {
    const b = blur(h, size, radii[s]), k = w[s] * strength;
    for (let i = 0; i < ao.length; i++) { const d = b[i] - h[i]; if (d > 0) ao[i] -= d * k; }
  }
  for (let i = 0; i < ao.length; i++) ao[i] = floorAO + (1 - floorAO) * clamp01(ao[i]);
  return ao;
}

// Height -> tangent-space normal, central difference. Sobel is smoother but
// central-diff keeps hard edges (panel seams, tile grout, brick mortar) crisp.
export function normalRGBA(h, size, strength = 2.4) {
  const d = new Uint8Array(size * size * 4);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1), p = (y * size + x) * 4;
      d[p] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[p + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[p + 2] = (1 / len) * 0.5 * 255 + 127.5;
      d[p + 3] = 255;
    }
  }
  return d;
}

// glTF-convention ORM: R=occlusion, G=roughness, B=metalness. Three's
// aoMap/roughnessMap/metalnessMap read exactly .r/.g/.b, so one 512² upload
// replaces three — a 3x cut in both texture memory and per-material gen time.
export function packORM(ao, rough, metal, size) {
  const d = new Uint8Array(size * size * 4);
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    d[p] = clamp01(ao ? ao[i] : 1) * 255;
    d[p + 1] = clamp01(rough ? rough[i] : 1) * 255;
    d[p + 2] = clamp01(metal ? metal[i] : 0) * 255;
    d[p + 3] = 255;
  }
  return d;
}

// `fn(i, x, y, out)` writes LINEAR rgb into out[0..2] and optional alpha out[3].
export function albedoRGBA(size, fn) {
  const d = new Uint8Array(size * size * 4), c = [0, 0, 0, 1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, p = i * 4;
      c[3] = 1; fn(i, x, y, c);
      d[p] = encodeSRGB(clamp01(c[0])) * 255;
      d[p + 1] = encodeSRGB(clamp01(c[1])) * 255;
      d[p + 2] = encodeSRGB(clamp01(c[2])) * 255;
      d[p + 3] = clamp01(c[3]) * 255;
    }
  }
  return d;
}

const pack = (size, h, ao, rough, metal, albedo, nStr) => ({
  size, albedo, normal: normalRGBA(h, size, nStr), orm: packORM(ao, rough, metal, size),
});

// ---------------------------------------------------------------------------
// shared micro-detail (generated once, referenced by every material)
// ---------------------------------------------------------------------------

// High-frequency tangent-space grain, tiled at ~25 cm in world space. This is
// what an FPS surface needs at 40 cm from the player's face: the base map runs
// out of texels long before the player runs out of curiosity.
export function detailNormal(seed, size = 256) {
  const a = fbm(size, size / 4, size / 4, seed, 3, 0.55);
  const b = worley(size, 40, 40, seed + 5, true);
  const h = F(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.7 + (1 - b[i]) * 0.3;
  return { size, data: normalRGBA(norm01(h), size, 1.5) };
}

// Very-low-frequency luminance/roughness breakup, tiled at ~14 m. Kills the
// "wallpaper" read of a repeating tile at distance — the one artefact that
// makes a tiled surface look procedural no matter how good the tile is.
//
// The shader consumes this as `(v * 2 - 1)`, a SIGNED multiplier on albedo and
// an offset on roughness, so the field must be exactly zero-mean: a map whose
// mean drifts off 0.5 uniformly darkens or brightens every surface it touches,
// which is indistinguishable from an exposure bug. Hence the explicit
// mean-centring here rather than a plain norm01 (norm01 pins min/max, not mean).
// Scaled by 2.4 sigma so the *typical* excursion uses most of the range and only
// the rare tail clamps — normalising by the max would leave it invisibly flat.
export function macroVariation(seed, size = 128) {
  const a = fbm(size, 3, 3, seed, 4, 0.55);
  const b = fbm(size, 9, 9, seed + 31, 3, 0.5);
  const N = size * size, f = F(N);
  for (let i = 0; i < N; i++) f[i] = a[i] * 0.72 + b[i] * 0.28;

  let mean = 0;
  for (let i = 0; i < N; i++) mean += f[i];
  mean /= N;
  let vr = 0;
  for (let i = 0; i < N; i++) { const e = f[i] - mean; vr += e * e; }
  const sd = Math.sqrt(vr / N);
  const k = sd > 1e-6 ? 0.5 / (2.4 * sd) : 0;

  const d = new Uint8Array(N * 4);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const v = clamp01(0.5 + (f[i] - mean) * k);
    d[p] = d[p + 1] = d[p + 2] = Math.round(v * 255); d[p + 3] = 255;
  }
  return { size, data: d };
}

// ---------------------------------------------------------------------------
// grime helpers reused across materials
// ---------------------------------------------------------------------------

// Dirt that collects in cavities + a large-scale patchiness mask. Roughness that
// tracks grime (rather than being uniform) is the #1 fix for the "CG plastic"
// look: real surfaces are a patchwork of clean, dusty, greasy and wet.
const grime = (size, seed, sc = 3) => fbm(size, sc, sc, seed, 4, 0.55);

// Downward water staining — anisotropic fBm, strong under ledges.
const streaks = (size, seed, sc = 6) => fbm(size, sc, sc * 10, seed, 4, 0.5);

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

// ---- poured concrete slab (floor) -----------------------------------------
// TILE = 2.4 m. Every feature below is sized in metres against that.
export function concreteFloor(seed, size = 512) {
  const N = size * size;
  const grain = fbm(size, 10, 10, seed, 6);
  const fine = fbm(size, 160, 160, seed + 7, 3);   // ~1.5 cm pores
  const agg = worley(size, 64, 64, seed + 11);     // ~3.7 cm aggregate
  const crack = ridge(size, 6, 6, seed + 5, 4);
  const st = grime(size, seed + 77, 2.5);
  const wet = grime(size, seed + 91, 1.5);
  const traffic = fbm(size, 2, 5, seed + 123, 4, 0.6);   // burnished walking paths
  const h = F(N), rough = F(N);

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    // Saw-cut control joint on the tile boundary: 2.4 m spacing, ~1.5 cm wide.
    // It was every HALF tile at ~11 cm wide, which is a trench, not a saw cut.
    const jx = Math.abs(((x / size) % 1) - 0.5), jy = Math.abs(((y / size) % 1) - 0.5);
    const joint = smoothstep(0.4937, 0.5, Math.max(jx, jy));
    const pit = smoothstep(0.74, 0.96, fine[i]);
    const ck = smoothstep(0.58, 0.9, crack[i]) * smoothstep(0.35, 0.6, grain[i]);
    h[i] = grain[i] * 0.5 + (1 - agg[i]) * 0.22 - pit * 0.42 - ck * 0.55 - joint * 0.75;
    // Roughness is a patchwork, not a constant: burnished traffic lanes are near
    // semi-gloss, standing water smooths, dust and pitting roughen. A floor with
    // one specular response over its whole area is the "CG plastic" tell.
    const polish = smoothstep(0.50, 0.88, traffic[i]);
    const dusty = smoothstep(0.52, 0.92, st[i]);
    rough[i] = 0.88 + fine[i] * 0.09 + pit * 0.06 + dusty * 0.11
      - polish * 0.40 - smoothstep(0.55, 0.85, wet[i]) * 0.26 - joint * 0.03;
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 18], w: [1.0, 1.5, 1.1] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const n = hn[i];
    // pale grey-warm cement, physically ~0.26 linear, aggregate slightly lighter
    let b = lerp(0.185, 0.325, n) * lerp(0.80, 1.10, st[i]);
    b *= lerp(1.0, 0.62, smoothstep(0.55, 0.9, wet[i]));   // water darkens
    b *= lerp(1.0, 0.55, 1 - ao[i]);                        // dirt packs into cavities
    o[0] = b * 1.02; o[1] = b * 1.0; o[2] = b * 0.94;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.6);
}

// ---- board-formed concrete (wall) -----------------------------------------
// TILE = 3.0 m, and this material covers 44 m walls — every scale error here is
// multiplied by ~15 repeats, so it is the least forgiving surface in the level.
export function concreteWall(seed, size = 1024) {
  const N = size * size;
  const grain = fbm(size, 12, 12, seed, 6);
  const fine = fbm(size, 200, 200, seed + 3, 3);   // ~1.5 cm pores
  const agg = worley(size, 72, 72, seed + 11);     // ~4 cm aggregate ghosting
  const crack = ridge(size, 5, 5, seed + 5, 5);
  const run = streaks(size, seed + 41, 5);
  const st = grime(size, seed + 77, 2);
  const sealN = fbm(size, 3, 3, seed + 121, 4, 0.6);   // washed / sealed patches
  const h = F(N), rough = F(N), tieA = F(N);

  const BOARDS = 11;   // form-board planks, horizontal — 27 cm at TILE 3.0 m
  // Snap ties sit on their OWN grid: 5 x 3 over a 3 m tile = 0.60 m across by
  // 1.00 m up, which is what a real wall form uses.
  //
  // The previous version had three compounding errors that turned these into
  // wallpaper polka dots: the U period came from `x*4` (0.75 m) while the V
  // period was reused from the plank fraction (0.27 m), so the holes were
  // ELLIPTICAL; the radius worked out to ~17 cm; and the depth (0.9) was more
  // than twice the whole grain term (0.38), so the ties dominated the height
  // field and therefore the baked AO. Ties are now round in world space, 2 cm,
  // shallow, and — via a per-tie hash — sometimes absent or patched flush, so
  // the grid never reads as a perfect lattice.
  const TU = 5, TV = 3;
  const RT = 0.020 / 3.0;    // 2 cm hole radius, expressed in tile units
  const RP = 0.055 / 3.0;    // 5.5 cm grout-plug / stain halo
  for (let y = 0; y < size; y++) {
    const bv = (y / size) * BOARDS;
    const bi = Math.floor(bv), bf = bv - bi;
    // each plank sits proud/recessed a hair and the seam is a hard line
    const plank = (hash2(0, bi, seed + 61) - 0.5) * 0.10;
    const seam = smoothstep(0.045, 0.0, Math.min(bf, 1 - bf));
    const tvv = (y / size) * TV, tj = Math.floor(tvv);
    const dv = (tvv - tj - 0.5) / TV;                  // tile units => isotropic
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tuu = (x / size) * TU, ti = Math.floor(tuu);
      const du = (tuu - ti - 0.5) / TU;
      const d = Math.hypot(du, dv);                    // round in WORLD space
      const s = hash2(ti, tj, seed + 83);              // per-tie state, seeded
      const open = s > 0.64 ? 1 : 0;                   // ~36% left open
      const plug = s > 0.26 && s <= 0.64 ? 1 : 0;      // ~38% patched flush
      const core = smoothstep(RT, RT * 0.45, d);
      const halo = smoothstep(RP, RP * 0.30, d);
      // subtle: a 2 cm dimple must not out-shout 27 cm plank seams (0.55)
      const tie = core * (open * 0.20 + plug * 0.05);
      tieA[i] = halo * (open * 0.85 + plug * 0.55);    // albedo ring only
      const pit = smoothstep(0.72, 0.95, fine[i]);
      const ck = smoothstep(0.62, 0.92, crack[i]);
      h[i] = grain[i] * 0.38 + (1 - agg[i]) * 0.16 + plank - seam * 0.55
        - pit * 0.35 - ck * 0.5 - tie;
      // Wide, physically-motivated roughness spread: rain-washed bands and
      // sealer patches go semi-matte, airborne dust and pitting go fully matte.
      const drip = smoothstep(0.42, 0.86, run[i]);
      const dust = smoothstep(0.50, 0.92, st[i]);
      const sealed = smoothstep(0.55, 0.90, sealN[i]);
      rough[i] = 0.86 + fine[i] * 0.10 + pit * 0.07 + dust * 0.12
        - drip * 0.22 - sealed * 0.26 - seam * 0.04;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 6, 22], w: [1.0, 1.5, 1.2] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const n = hn[i];
    let b = lerp(0.20, 0.34, n) * lerp(0.84, 1.08, st[i]);
    const drip = smoothstep(0.5, 0.9, run[i]) * smoothstep(0.0, 0.35, 1 - y / size);
    b *= lerp(1.0, 0.52, drip);                            // rain streak
    b *= lerp(1.0, 0.58, 1 - ao[i]);
    // patched ties read as a slightly paler, slightly warmer grout disc
    b = lerp(b, b * 1.16 + 0.020, tieA[i] * 0.55);
    o[0] = b * 1.03; o[1] = b * 1.0; o[2] = b * 0.93;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.2);
}

// ---- asphalt ---------------------------------------------------------------
// TILE = 4.0 m and this is the 240 m ground plane (60 repeats), so aggregate
// scale matters more here than anywhere. Was 7 cm / 18 cm "pebbles" — that is
// cobblestone, not asphalt; graded bitumen aggregate is 1-3 cm.
export function asphalt(seed, size = 512, lanePaint = 0) {
  const N = size * size;
  const agg = worley(size, 128, 128, seed);          // ~3 cm
  const agg2 = worley(size, 64, 64, seed + 17);      // ~6 cm, the coarse fraction
  const fine = fbm(size, 190, 190, seed + 4, 3);
  const crack = ridge(size, 4, 4, seed + 9, 5);
  const patch = grime(size, seed + 33, 2);
  const wear = fbm(size, 3, 14, seed + 51, 4);       // tyre-polished wheel paths
  const h = F(N), rough = F(N);

  for (let i = 0; i < N; i++) {
    const pebble = (1 - agg[i]) * 0.55 + (1 - agg2[i]) * 0.2;
    const ck = smoothstep(0.68, 0.95, crack[i]);
    h[i] = pebble + fine[i] * 0.22 - ck * 0.8;
    // tyres burnish bitumen to a genuine sheen; fresh patches stay matte
    rough[i] = 0.93 + fine[i] * 0.05 - smoothstep(0.6, 0.95, patch[i]) * 0.18
      - smoothstep(0.48, 0.90, wear[i]) * 0.30;
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 4, 14], w: [1.2, 1.5, 0.9] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const n = hn[i];
    // asphalt is genuinely dark: 0.06-0.11 linear. Aggregate tips catch light.
    let b = lerp(0.045, 0.115, n) * lerp(0.86, 1.20, patch[i]);
    b *= lerp(1.0, 0.62, 1 - ao[i]);
    o[0] = b; o[1] = b * 1.01; o[2] = b * 1.06;
    if (lanePaint) {
      // Worn lane stripe down the middle of the tile; paint sits ON the
      // aggregate so it survives on the peaks and abrades out of the hollows.
      // 12 cm stripe at TILE 4.0 m (was 56 cm — a runway marking, not a lane line)
      const u = Math.abs((x / size) - 0.5);
      const band = smoothstep(0.0165, 0.0110, u);
      const abrade = clamp01(smoothstep(0.30, 0.62, wear[i]) + n * 0.55);
      const m = band * abrade;
      if (m > 0.01) {
        const p = lanePaint === 2 ? [0.55, 0.40, 0.05] : [0.62, 0.60, 0.55];
        o[0] = lerp(o[0], p[0], m); o[1] = lerp(o[1], p[1], m); o[2] = lerp(o[2], p[2], m);
        rough[i] = lerp(rough[i], 0.55, m);                 // paint is smoother
        h[i] = h[i];                                        // paint film is ~0 thick
      }
    }
  });
  return pack(size, hn, ao, rough, null, albedo, 2.0);
}

// ---- scuffed painted steel panel ------------------------------------------
// TILE = 2.0 m. The previous chip model read as leopard print for three
// reasons, all fixed here:
//   1. worley(26) = 7.7 cm cells and an F2-F1 mask thresholded at 0.66..0.80
//      selected the whole *border network* between cells — i.e. fat connected
//      blobs, the exact topology of animal-print camouflage.
//   2. Chips were placed by noise alone. Paint does not fail at random; it
//      fails where it is mechanically abused — panel edges, fasteners, scratch
//      lines, damp corners.
//   3. Albedo jumped 0.03 (enamel) -> 0.55 (steel), an ~18x step. Real exposed
//      weathered steel is 0.20-0.28 linear with high metalness, and paint never
//      goes straight to bare metal: there is always a primer/oxide stage.
export function paintedMetal(seed, size = 512) {
  const N = size * size;
  const brush = fbm(size, 6, 220, seed, 3, 0.6);          // anisotropic brushing
  const scratch = ridge(size, 8, 200, seed + 13, 3);
  const chipF = worley(size, 56, 56, seed + 3);           // F1, ~3.6 cm cells
  const failN = fbm(size, 4, 4, seed + 63, 4, 0.6);       // coating-failure zones
  const dent = fbm(size, 7, 7, seed + 21, 3);
  const gr = grime(size, seed + 44, 2.5);
  const run = streaks(size, seed + 55, 4);
  const h = F(N), rough = F(N), metal = F(N), chipM = F(N), primM = F(N);

  const PANEL = 3;                                        // 67 cm panels
  for (let y = 0; y < size; y++) {
    const v = (y / size) * PANEL, vf = Math.abs((v % 1) - 0.5);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * PANEL, uf = Math.abs((u % 1) - 0.5);
      const seam = smoothstep(0.472, 0.5, Math.max(uf, vf));
      const edge = smoothstep(0.40, 0.5, Math.max(uf, vf));  // wear concentrates here
      // rivets on a line just inside each panel edge
      const rr = Math.hypot(Math.min(Math.abs(uf - 0.44), 0.5) * 2.2, ((v * 8) % 1) - 0.5);
      const rivet = smoothstep(0.10, 0.03, rr) * (uf > 0.40 ? 1 : 0);
      const sc = smoothstep(0.72, 1.0, scratch[i]);
      // where the coating is under mechanical attack at all
      const abuse = clamp01(edge * 1.05 + rivet * 0.85 + sc * 0.95
        + smoothstep(0.66, 0.96, failN[i]) * 0.50 - 0.24);
      const wf = smoothstep(0.16, 0.62, abuse);
      // Small ROUND flecks centred on worley feature points: r ~0.18 cell
      // = ~6 mm. F1 (not F2-F1) is what gives spots instead of a border network.
      const chip = smoothstep(0.18, 0.05, chipF[i]) * wf;
      // primer/oxide collar — paint lifts progressively outward from a chip
      const prim = clamp01(smoothstep(0.36, 0.15, chipF[i]) * wf - chip);
      chipM[i] = chip; primM[i] = prim;
      h[i] = -seam * 0.9 + rivet * 0.55 + brush[i] * 0.05 + dent[i] * 0.10
        - chip * 0.06 - prim * 0.02 - sc * 0.06;
      rough[i] = lerp(0.28, 0.46, brush[i]) + chip * 0.28 + prim * 0.22 + seam * 0.10
        + gr[i] * 0.16 - sc * 0.16 + smoothstep(0.5, 0.9, run[i]) * 0.12
        - smoothstep(0.60, 0.94, dent[i]) * 0.10;
      metal[i] = 0.02 + chip * 0.96 + prim * 0.22 + sc * 0.30 * clamp01(1 - chip - prim);
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 4, 14], w: [1.1, 1.4, 1.0] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const t = brush[i], c = chipM[i], p = primM[i];
    // mid blue-grey industrial enamel (~0.10 linear), not near-black
    let r = lerp(0.070, 0.102, t), g = lerp(0.080, 0.116, t), b = lerp(0.092, 0.134, t);
    // red-oxide primer showing through first
    r = lerp(r, 0.108, p); g = lerp(g, 0.054, p); b = lerp(b, 0.038, p);
    // then weathered bare steel: 0.21-0.28 linear WITH metalness ~1
    const s = lerp(0.205, 0.275, t);
    r = lerp(r, s, c); g = lerp(g, s * 0.99, c); b = lerp(b, s * 1.02, c);
    const dirt = lerp(1.0, 0.62, smoothstep(0.5, 0.95, gr[i]) * 0.8 + (1 - ao[i]) * 0.5);
    o[0] = r * dirt; o[1] = g * dirt; o[2] = b * dirt;
  });
  return pack(size, hn, ao, rough, metal, albedo, 2.8);
}

// ---- corrugated steel sheeting --------------------------------------------
export function corrugated(seed, size = 512) {
  const N = size * size;
  const rust = worley(size, 14, 14, seed + 7, true);
  const gr = grime(size, seed + 12, 2);
  const run = streaks(size, seed + 19, 3);
  const fineN = fbm(size, 100, 100, seed + 23, 3);
  const dent = fbm(size, 9, 9, seed + 31, 3);
  const h = F(N), rough = F(N), metal = F(N), rustM = F(N);

  const RIBS = 16;    // 11 cm rib pitch at TILE 1.8 m (was 20 cm — no profile
                      // that coarse is sold; industrial sheeting is 76-115 mm)
  for (let y = 0; y < size; y++) {
    // bolt rows every 1/3 tile vertically
    const br = Math.abs(((y / size * 3) % 1) - 0.5);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const rib = Math.cos((x / size) * RIBS * Math.PI * 2);
      const bolt = smoothstep(0.06, 0.015, Math.hypot(((x / size * RIBS) % 1) - 0.5, (br - 0.5) * 1.1) * 0.6)
        * smoothstep(0.44, 0.5, br);
      // rust wins in the troughs and low on the sheet where water sits
      const wet = smoothstep(0.45, 0.9, run[i]) * 0.6 + (1 - (rib * 0.5 + 0.5)) * 0.5;
      const r = clamp01(smoothstep(0.62, 0.30, rust[i]) * (0.35 + wet));
      rustM[i] = r;
      h[i] = rib * 0.5 + dent[i] * 0.06 + bolt * 0.35 + fineN[i] * 0.04 - r * 0.06;
      rough[i] = lerp(0.30, 0.92, r) + gr[i] * 0.10 + fineN[i] * 0.05;
      metal[i] = lerp(0.98, 0.10, r);
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 6, 20], w: [0.9, 1.3, 1.0] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const r = rustM[i], t = fineN[i];
    const gz = lerp(0.44, 0.58, t);                        // galvanised steel F0
    const rr = lerp(0.115, 0.175, t), rg = lerp(0.045, 0.072, t), rb = lerp(0.018, 0.030, t);
    let R = lerp(gz, rr, r), G = lerp(gz * 1.0, rg, r), B = lerp(gz * 1.03, rb, r);
    const d = lerp(1.0, 0.65, smoothstep(0.5, 0.95, gr[i]) * 0.7 + (1 - ao[i]) * 0.4);
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, metal, albedo, 3.0);
}

// ---- heavily rusted steel plate -------------------------------------------
export function rustedSteel(seed, size = 512) {
  const N = size * size;
  const cell = worley(size, 18, 18, seed);              // 11 cm rust patches
  const flake = worley(size, 66, 66, seed + 5, true);   // 3 cm scale flakes
  const scale = fbm(size, 26, 26, seed + 9, 4);
  const pit = fbm(size, 200, 200, seed + 15, 3);        // 1 cm pitting
  const patch = grime(size, seed + 27, 2);
  const h = F(N), rough = F(N), metal = F(N), rustM = F(N);

  for (let i = 0; i < N; i++) {
    // flakes lift, exposing pitted metal under them
    const lift = smoothstep(0.55, 0.20, flake[i]);
    const r = clamp01(smoothstep(0.25, 0.75, patch[i] * 0.6 + scale[i] * 0.6) + lift * 0.25);
    rustM[i] = r;
    h[i] = scale[i] * 0.35 + (1 - cell[i]) * 0.20 - lift * 0.45 - smoothstep(0.78, 1.0, pit[i]) * 0.35;
    rough[i] = lerp(0.42, 0.97, r) + pit[i] * 0.05;
    metal[i] = lerp(1.0, 0.05, r);
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 18], w: [1.2, 1.6, 1.1] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const r = rustM[i], t = scale[i], n = hn[i];
    const st = lerp(0.44, 0.60, n);
    const rr = lerp(0.090, 0.195, t), rg = lerp(0.032, 0.078, t), rb = lerp(0.014, 0.032, t);
    let R = lerp(st, rr, r), G = lerp(st, rg, r), B = lerp(st * 1.02, rb, r);
    const d = lerp(1.0, 0.6, 1 - ao[i]);
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, metal, albedo, 3.2);
}

// ---- brick (running bond) --------------------------------------------------
// TILE = 2.4 m. A standard brick is 215 x 65 mm on a 10 mm joint, so a 2.4 m
// tile holds ~11 across and ~32 up. It was authored at 9 x 4.5 — 53 x 27 cm
// "bricks", i.e. 2.4x too long and 3.6x too tall, which reads as concrete block.
export function brick(seed, size = 1024) {
  const N = size * size;
  const face = fbm(size, 150, 150, seed + 2, 4);
  const pore = fbm(size, 300, 300, seed + 6, 3);
  const mortarN = fbm(size, 120, 120, seed + 8, 4);
  const eff = grime(size, seed + 14, 3);                   // efflorescence / salt
  const run = streaks(size, seed + 22, 4);
  const chipN = worley(size, 140, 140, seed + 26, true);
  const h = F(N), rough = F(N), brickId = new Int32Array(N), mortarM = F(N);

  const ROWS = 32, COLS = 11;                              // 7.5 cm x 21.8 cm
  for (let y = 0; y < size; y++) {
    const rv = (y / size) * ROWS, ri = Math.floor(rv), rf = rv - ri;
    const off = (ri & 1) ? 0.5 : 0;                        // running bond
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cv = (x / size) * COLS + off, ci = Math.floor(cv), cf = cv - ci;
      brickId[i] = ((ri * 131) ^ (ci * 977)) & 0x7fffffff;
      const MW = 0.046, MH = 0.135;                        // ~1 cm joints both ways
      const mx = smoothstep(MW, MW * 0.35, Math.min(cf, 1 - cf));
      const my = smoothstep(MH, MH * 0.35, Math.min(rf, 1 - rf));
      const m = clamp01(Math.max(mx, my));
      mortarM[i] = m;
      // brick faces bow out slightly; corners chip
      const bow = (1 - Math.hypot(cf - 0.5, rf - 0.5) * 1.2) * 0.10;
      const chip = smoothstep(0.35, 0.06, chipN[i]) * smoothstep(0.28, 0.42, Math.hypot(cf - 0.5, (rf - 0.5) * 1.6));
      h[i] = lerp(bow + face[i] * 0.12 + pore[i] * 0.05 - chip * 0.30,
        -0.42 + mortarN[i] * 0.10, m);
      // per-brick firing variance: some faces come out semi-vitrified and
      // noticeably slicker than their neighbours. A wall of identically-rough
      // bricks is as much of a tell as a wall of identically-coloured ones.
      const fired = hash2(ci, ri, seed + 143);
      rough[i] = lerp(lerp(0.58, 0.86, fired) + pore[i] * 0.10
        - smoothstep(0.6, 0.95, run[i]) * 0.12,
        0.95 + mortarN[i] * 0.04, m);
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 20], w: [1.0, 1.6, 1.2] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const m = mortarM[i], t = face[i];
    // per-brick colour jitter — a wall of identical bricks is an instant tell
    const j = hash2(brickId[i] & 0xffff, brickId[i] >>> 16, seed + 99);
    const j2 = hash2(brickId[i] >>> 8, brickId[i] & 0xff, seed + 111);
    const dark = 0.55 + j * 0.75;
    let R = lerp(0.085, 0.150, t) * dark * lerp(0.9, 1.12, j2);
    let G = lerp(0.030, 0.058, t) * dark * lerp(0.95, 1.05, j2);
    let B = lerp(0.021, 0.040, t) * dark;
    const mo = lerp(0.135, 0.190, mortarN[i]);             // grey lime mortar
    R = lerp(R, mo, m); G = lerp(G, mo * 0.99, m); B = lerp(B, mo * 0.95, m);
    const salt = smoothstep(0.62, 0.92, eff[i]) * (1 - m) * 0.45;
    R = lerp(R, 0.30, salt); G = lerp(G, 0.30, salt); B = lerp(B, 0.29, salt);
    const d = lerp(1.0, 0.55, 1 - ao[i]) * lerp(1.0, 0.70, smoothstep(0.55, 0.92, run[i]));
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.4);
}

// ---- plaster with blown patches exposing the brick behind ------------------
export function plaster(seed, size = 512) {
  const N = size * size;
  const trowel = fbm(size, 5, 5, seed, 4, 0.6);
  const fineP = fbm(size, 130, 130, seed + 4, 3);
  const blow = fbm(size, 3, 3, seed + 8, 4, 0.6);          // where render fell off
  const edge = fbm(size, 22, 22, seed + 12, 3);
  const run = streaks(size, seed + 16, 5);
  const gr = grime(size, seed + 20, 2);
  // reuse the brick synthesiser's geometry at the same scale for the exposed core
  const bmortarN = fbm(size, 110, 110, seed + 8, 4);
  const bface = fbm(size, 140, 140, seed + 2, 4);
  const h = F(N), rough = F(N), expose = F(N), mortarM = F(N);

  // matched to brick(): real brick courses, sized for TILE 2.6 m
  const ROWS = 34, COLS = 12;
  for (let y = 0; y < size; y++) {
    const rv = (y / size) * ROWS, ri = Math.floor(rv), rf = rv - ri;
    const off = (ri & 1) ? 0.5 : 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cv = (x / size) * COLS + off, cf = cv - Math.floor(cv);
      const m = clamp01(Math.max(
        smoothstep(0.046, 0.016, Math.min(cf, 1 - cf)),
        smoothstep(0.135, 0.047, Math.min(rf, 1 - rf))));
      mortarM[i] = m;
      // ragged boundary: threshold a low-freq field perturbed by a mid-freq one
      const e = clamp01(smoothstep(0.50, 0.60, blow[i] + (edge[i] - 0.5) * 0.16));
      expose[i] = e;
      const brickH = lerp(bface[i] * 0.14, -0.42 + bmortarN[i] * 0.10, m);
      const plasterH = 0.30 + trowel[i] * 0.16 + fineP[i] * 0.05;
      h[i] = lerp(plasterH, brickH, e);
      rough[i] = lerp(0.72 + fineP[i] * 0.12 - smoothstep(0.6, 0.95, run[i]) * 0.14,
        lerp(0.84, 0.96, m), e) + gr[i] * 0.06;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 6, 22], w: [1.1, 1.7, 1.2] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const e = expose[i], m = mortarM[i];
    // sun-bleached ochre render, linear ~0.42
    let R = lerp(0.36, 0.50, trowel[i]), G = lerp(0.31, 0.44, trowel[i]), B = lerp(0.25, 0.35, trowel[i]);
    const br = lerp(0.075, 0.135, bface[i]), bg = lerp(0.028, 0.050, bface[i]), bb = lerp(0.020, 0.035, bface[i]);
    const mo = lerp(0.120, 0.170, bmortarN[i]);
    const cr = lerp(br, mo, m), cg = lerp(bg, mo * 0.99, m), cb = lerp(bb, mo * 0.95, m);
    R = lerp(R, cr, e); G = lerp(G, cg, e); B = lerp(B, cb, e);
    const d = lerp(1.0, 0.52, 1 - ao[i]) * lerp(1.0, 0.66, smoothstep(0.5, 0.9, run[i]))
      * lerp(1.0, 0.80, smoothstep(0.55, 0.95, gr[i]));
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.6);
}

// ---- sandbag / heavy canvas ------------------------------------------------
export function canvas(seed, size = 512) {
  const N = size * size;
  const fibre = fbm(size, 200, 60, seed, 3, 0.6);
  const fibre2 = fbm(size, 60, 200, seed + 3, 3, 0.6);
  const dirt = grime(size, seed + 9, 2.5);
  const wearN = fbm(size, 16, 16, seed + 13, 4);
  const h = F(N), rough = F(N);

  // 96 threads at TILE 1.4 m = ~1.5 cm pitch. Real hessian is ~2 mm, but at
  // 512 px that is 0.7 px/thread — pure aliasing. This is the finest weave the
  // texel budget actually supports; it was 46 (3 cm), which read as netting.
  const THREADS = 96;
  for (let y = 0; y < size; y++) {
    const tv = (y / size) * THREADS, vf = tv - Math.floor(tv), vi = Math.floor(tv);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tu = (x / size) * THREADS, uf = tu - Math.floor(tu), ui = Math.floor(tu);
      // plain weave: warp over weft on alternating cells
      const over = ((ui + vi) & 1) === 0;
      const warp = Math.sin(uf * Math.PI), weft = Math.sin(vf * Math.PI);
      const cross = over ? warp * 0.9 + weft * 0.25 : weft * 0.9 + warp * 0.25;
      h[i] = cross * 0.5 + fibre[i] * 0.10 + fibre2[i] * 0.10 - 0.25;
      // dry hessian is fully matte; handled/greasy areas and dried mud crusts
      // pick up a low sheen — without that the whole bag is one flat value
      rough[i] = 0.94 + fibre[i] * 0.06 + dirt[i] * 0.05
        - smoothstep(0.50, 0.90, wearN[i]) * 0.26;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 4, 12], w: [1.3, 1.5, 0.8] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const t = fibre[i] * 0.5 + fibre2[i] * 0.5;
    // sun-faded hessian, linear ~0.22, mud-stained toward the ground
    let R = lerp(0.175, 0.275, t), G = lerp(0.145, 0.225, t), B = lerp(0.098, 0.150, t);
    const mud = smoothstep(0.45, 0.9, dirt[i]) * lerp(0.35, 0.9, 1 - wearN[i]);
    R = lerp(R, 0.062, mud); G = lerp(G, 0.048, mud); B = lerp(B, 0.034, mud);
    const d = lerp(1.0, 0.55, 1 - ao[i]);
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 3.4);
}

// ---- wood planking ---------------------------------------------------------
export function wood(seed, size = 512) {
  const N = size * size;
  const ringN = fbm(size, 6, 40, seed, 4, 0.55);
  const fibreN = fbm(size, 14, 300, seed + 4, 3, 0.6);
  const knotN = worley(size, 10, 14, seed + 8);
  const gr = grime(size, seed + 12, 2.5);
  const scuff = fbm(size, 40, 12, seed + 16, 3);
  const h = F(N), rough = F(N), grainV = F(N), knotM = F(N);

  const PLANKS = 10;   // 20 cm boards at TILE 2.0 m (was 40 cm — that is a beam)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const pv = (x / size) * PLANKS, pi = Math.floor(pv), pf = pv - pi;
      const gap = smoothstep(0.035, 0.006, Math.min(pf, 1 - pf));
      // per-plank offset so growth rings never line up across a joint
      const jitter = hash2(pi, 0, seed + 21);
      const rings = Math.abs(Math.sin((ringN[i] * 7.0 + jitter * 6.2 + pf * 1.3) * Math.PI * 2));
      const knot = smoothstep(0.16, 0.02, knotN[i]);
      knotM[i] = knot;
      grainV[i] = rings;
      const board = (hash2(pi, 3, seed + 31) - 0.5) * 0.08;
      h[i] = board + rings * 0.16 + fibreN[i] * 0.10 - gap * 0.9 + knot * 0.12
        - smoothstep(0.7, 1.0, scuff[i]) * 0.05;
      // foot traffic burnishes softwood to a real sheen along the walking line;
      // knots are denser resinous wood and slicker than the surrounding grain
      rough[i] = 0.76 + rings * 0.10 + fibreN[i] * 0.08 + gr[i] * 0.08 - knot * 0.16
        - smoothstep(0.50, 0.88, scuff[i]) * 0.30;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 18], w: [1.1, 1.5, 1.0] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const r = grainV[i], k = knotM[i];
    // weathered pine: light 0.14 linear, dark late-wood bands ~0.06
    const t = lerp(1.0, 0.45, r);
    let R = 0.145 * t, G = 0.104 * t, B = 0.064 * t;
    R = lerp(R, 0.030, k); G = lerp(G, 0.020, k); B = lerp(B, 0.013, k);
    const grey = smoothstep(0.4, 0.9, gr[i]) * 0.5;         // UV-greyed surface
    R = lerp(R, 0.105, grey); G = lerp(G, 0.100, grey); B = lerp(B, 0.092, grey);
    const d = lerp(1.0, 0.5, 1 - ao[i]);
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.4);
}

// ---- chain-link fence (alpha tested) ---------------------------------------
// Alpha in the albedo's A channel; the material runs alphaTest, not blending, so
// it writes depth and stays sortable.
export function chainlink(seed, size = 512) {
  const N = size * size;
  const gr = grime(size, seed + 3, 3);
  const pitN = fbm(size, 160, 160, seed + 7, 3);
  const h = F(N), rough = F(N), metal = F(N), alpha = F(N), wireV = F(N);

  const CELLS = 6;                                          // diamonds per tile
  const R = 0.085;                                          // wire radius in cell units
  for (let y = 0; y < size; y++) {
    const v = (y / size) * CELLS;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * CELLS;
      // two crossing diagonal wire families -> diamond mesh
      const a = Math.abs(((u + v) % 1) - 0.5), b = Math.abs(((u - v + 1) % 1) - 0.5);
      const da = 0.5 - a, db = 0.5 - b;                     // distance to each wire
      const d = Math.min(da, db);
      const cover = smoothstep(R, R * 0.55, d);
      alpha[i] = cover;
      // round the wire cross-section so it catches a highlight along its length
      const prof = Math.sqrt(Math.max(0, 1 - Math.pow(clamp01(d / R), 2)));
      wireV[i] = prof;
      h[i] = prof * 0.6 + (da < db ? 0.12 : 0) - pitN[i] * 0.05;
      rough[i] = 0.32 + gr[i] * 0.30 + pitN[i] * 0.12;
      metal[i] = 0.95;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 4, 10], w: [0.8, 1.0, 0.6] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const t = pitN[i];
    const gz = lerp(0.42, 0.56, t) * lerp(1.0, 0.62, smoothstep(0.45, 0.9, gr[i]));
    o[0] = gz; o[1] = gz; o[2] = gz * 1.03;
    o[3] = alpha[i];
  });
  return pack(size, hn, ao, rough, metal, albedo, 3.0);
}

// ---- dirty glass -----------------------------------------------------------
export function glass(seed, size = 512) {
  const N = size * size;
  const smear = fbm(size, 4, 4, seed, 4, 0.6);
  const dust = fbm(size, 60, 60, seed + 5, 3);
  const run = streaks(size, seed + 9, 5);
  const wave = fbm(size, 6, 6, seed + 13, 3, 0.6);
  const h = F(N), rough = F(N);

  for (let i = 0; i < N; i++) {
    h[i] = wave[i] * 0.5 + smear[i] * 0.12;                 // float-glass waviness
    const grime2 = smoothstep(0.45, 0.9, smear[i]) * 0.55
      + smoothstep(0.5, 0.9, run[i]) * 0.35 + dust[i] * 0.10;
    rough[i] = clamp(0.02 + grime2 * 0.55, 0.02, 0.65);
  }
  const hn = norm01(h);
  const ao = fill(size, 1);
  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const g = smoothstep(0.5, 0.95, smear[i]) * 0.5 + smoothstep(0.55, 0.95, run[i]) * 0.3;
    const c = lerp(0.86, 0.42, g);
    o[0] = c * 0.94; o[1] = c; o[2] = c * 0.99;
    o[3] = clamp01(0.16 + g * 0.55);                        // grime makes it opaque
  });
  return pack(size, hn, ao, rough, null, albedo, 0.5);
}

// ---- rubber matting --------------------------------------------------------
export function rubber(seed, size = 512) {
  const N = size * size;
  const fineR = fbm(size, 170, 170, seed, 3);
  const gr = grime(size, seed + 6, 2.5);
  const wearN = fbm(size, 12, 12, seed + 11, 4);
  const h = F(N), rough = F(N);

  const STUDS = 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * STUDS, v = (y / size) * STUDS;
      const uf = (u % 1) - 0.5, vf = (v % 1) - 0.5;
      const stud = smoothstep(0.34, 0.20, Math.hypot(uf, vf));
      const worn = smoothstep(0.45, 0.85, wearN[i]);
      h[i] = stud * (0.6 - worn * 0.35) + fineR[i] * 0.10;
      rough[i] = 0.94 + fineR[i] * 0.05 - worn * 0.22 - stud * 0.06;
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 14], w: [1.0, 1.4, 0.9] });
  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const c = lerp(0.020, 0.036, fineR[i]) * lerp(1.0, 1.5, smoothstep(0.5, 0.9, wearN[i]))
      * lerp(1.0, 0.7, 1 - ao[i]) * lerp(1.0, 1.25, gr[i]);
    o[0] = c; o[1] = c * 1.0; o[2] = c * 1.02;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.8);
}

// ---- dirt / gravel ---------------------------------------------------------
export function gravel(seed, size = 512) {
  const N = size * size;
  const big = worley(size, 16, 16, seed);
  const mid = worley(size, 34, 34, seed + 4);
  const small = worley(size, 72, 72, seed + 8);
  const soil = fbm(size, 26, 26, seed + 12, 4);
  const fineG = fbm(size, 150, 150, seed + 16, 3);
  const damp = grime(size, seed + 20, 2);
  const h = F(N), rough = F(N), stone = F(N);

  for (let i = 0; i < N; i++) {
    const a = 1 - big[i], b = 1 - mid[i], c = 1 - small[i];
    const s = clamp01(a * 0.75 + b * 0.5 + c * 0.3 - 0.28);
    stone[i] = smoothstep(0.16, 0.55, s);
    h[i] = s * 0.9 + soil[i] * 0.18 + fineG[i] * 0.06;
    rough[i] = 0.94 + fineG[i] * 0.05 - smoothstep(0.6, 0.95, damp[i]) * 0.22 - stone[i] * 0.06;
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 5, 16], w: [1.3, 1.7, 1.1] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const st = stone[i], t = fineG[i], j = soil[i];
    // dry stone chips over brown soil
    const sr = lerp(0.16, 0.27, t) * lerp(0.8, 1.15, j);
    let R = lerp(0.085, sr, st), G = lerp(0.062, sr * 0.97, st), B = lerp(0.042, sr * 0.92, st);
    const wet = smoothstep(0.6, 0.95, damp[i]);
    R = lerp(R, R * 0.55, wet); G = lerp(G, G * 0.55, wet); B = lerp(B, B * 0.58, wet);
    const d = lerp(1.0, 0.45, 1 - ao[i]);
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 3.2);
}

// ---- ceramic floor tile ----------------------------------------------------
export function tile(seed, size = 512) {
  const N = size * size;
  const glaze = fbm(size, 90, 90, seed, 3);
  const groutN = fbm(size, 55, 55, seed + 4, 4);
  const gr = grime(size, seed + 8, 2.5);
  const crackN = ridge(size, 7, 7, seed + 12, 4);
  const chipN = worley(size, 70, 70, seed + 16, true);
  const h = F(N), rough = F(N), groutM = F(N), tid = new Int32Array(N);

  const T = 5;                                              // tiles across the map
  for (let y = 0; y < size; y++) {
    const v = (y / size) * T, vi = Math.floor(v), vf = v - vi;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * T, ui = Math.floor(u), uf = u - ui;
      tid[i] = (ui * 71) ^ (vi * 349);
      const g = clamp01(Math.max(
        smoothstep(0.055, 0.020, Math.min(uf, 1 - uf)),
        smoothstep(0.055, 0.020, Math.min(vf, 1 - vf))));
      groutM[i] = g;
      const bow = (1 - Math.hypot(uf - 0.5, vf - 0.5) * 1.1) * 0.05;
      const chip = smoothstep(0.30, 0.05, chipN[i])
        * smoothstep(0.30, 0.45, Math.max(Math.abs(uf - 0.5), Math.abs(vf - 0.5)));
      const ck = smoothstep(0.80, 0.98, crackN[i]) * (1 - g);
      h[i] = lerp(bow + glaze[i] * 0.03 - chip * 0.35 - ck * 0.25, -0.55 + groutN[i] * 0.12, g);
      rough[i] = lerp(0.13 + glaze[i] * 0.07 + gr[i] * 0.30 + chip * 0.5 + ck * 0.3,
        0.92 + groutN[i] * 0.05, g);
    }
  }
  const hn = norm01(h);
  const ao = bakeAO(hn, size, { radii: [1, 4, 16], w: [1.0, 1.6, 1.1] });

  const albedo = albedoRGBA(size, (i, x, y, o) => {
    const g = groutM[i];
    const j = hash2(tid[i] & 0xffff, tid[i] >>> 16, seed + 55);
    // pale institutional tile with per-tile batch variation
    const base = lerp(0.34, 0.44, glaze[i]) * lerp(0.92, 1.06, j);
    let R = base * 0.98, G = base, B = base * 0.95;
    const mo = lerp(0.115, 0.165, groutN[i]);
    R = lerp(R, mo, g); G = lerp(G, mo * 0.98, g); B = lerp(B, mo * 0.94, g);
    const d = lerp(1.0, 0.42, 1 - ao[i]) * lerp(1.0, 0.78, smoothstep(0.5, 0.95, gr[i]));
    o[0] = R * d; o[1] = G * d; o[2] = B * d;
  });
  return pack(size, hn, ao, rough, null, albedo, 2.6);
}

// ---------------------------------------------------------------------------
// sky -> IBL source
// ---------------------------------------------------------------------------

// EXACT JS port of render/sky.js's fragment shader, sampled into an equirect
// float buffer for PMREM. Sky and ambient specular MUST agree — a mismatch is
// the fastest way to make a render look fake, because every reflective surface
// then disagrees with the visible background.
//
// Colours arrive here as LINEAR triplets (three converts the sRGB hex uniforms
// to working space on assignment, so the shader also sees linear).
// The only deliberate divergence: the sun disc is widened from ~0.16 deg to
// ~2.4 deg with matched total energy. A one-texel disc in a 512x256 equirect
// aliases into PMREM as a blocky square; a pre-broadened disc integrates to the
// same irradiance and gives a clean specular highlight.
export function skyEquirect(sunDir, {
  size = 512,
  zenith = [0.0234, 0.0742, 0.2051],      // 0x2a4a7a
  horizon = [0.4179, 0.5029, 0.5776],     // 0xa8b8c8
  ground = [0.0091, 0.0075, 0.0055],      // 0x1a1712
  sun = [1.0, 0.8879, 0.7011],            // 0xfff2d8
  turbidity = 2.6,
  exposure = 1.0,
} = {}) {
  const w = size, hgt = size >> 1;
  const data = new Float32Array(w * hgt * 4);
  const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
  const sl = Math.hypot(sx, sy, sz) || 1;
  const ux = sx / sl, uy = sy / sl, uz = sz / sl;

  for (let j = 0; j < hgt; j++) {
    const theta = (j + 0.5) / hgt * Math.PI;               // 0 = +Y
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i < w; i++) {
      const phi = (i + 0.5) / w * Math.PI * 2 - Math.PI;
      // three's equirect convention: u wraps around Y, v from top
      const dx = st * Math.sin(phi), dy = ct, dz = st * Math.cos(phi);
      const el = dy;

      const hz = Math.pow(clamp01(1 - Math.abs(el)), turbidity);
      let r = lerp(zenith[0], horizon[0], hz);
      let g = lerp(zenith[1], horizon[1], hz);
      let b = lerp(zenith[2], horizon[2], hz);

      const gm = smoothstep(0.02, -0.06, el);
      r = lerp(r, ground[0], gm); g = lerp(g, ground[1], gm); b = lerp(b, ground[2], gm);

      const cosT = Math.max(dx * ux + dy * uy + dz * uz, 0);
      // glow term identical to the shader; disc term broadened, energy matched
      const glow = Math.pow(cosT, 26) * 0.55;
      const disc = smoothstep(0.9990, 0.99935, cosT) * 0.0 + Math.pow(cosT, 4200) * 0 +
        smoothstep(0.99905, 0.99915, cosT) * 0;
      const wide = smoothstep(0.9985, 0.99925, cosT);      // ~2.4 deg cap
      const above = smoothstep(-0.08, 0.06, el);
      const e = (glow + Math.pow(cosT, 900) * 6 + wide * 3.6) * above;
      r += sun[0] * e; g += sun[1] * e; b += sun[2] * e;

      const p = (j * w + i) * 4;
      data[p] = r * exposure; data[p + 1] = g * exposure; data[p + 2] = b * exposure; data[p + 3] = 1;
    }
  }
  return { data, width: w, height: hgt };
}
