// Procedural FX imagery — particle sprites and surface-typed impact decals.
// Pure data synthesis: no THREE, no DOM, therefore node-testable. Mirrors the
// contract of render/textures.js (which this reuses for its noise fields).
//
// COLOR SPACE — two different rules in this file, and mixing them up is the bug
// that crushed an earlier build to black:
//   * Particle sprites are MASKS consumed by our own unlit ShaderMaterial. They
//     are tagged LinearSRGB and must NOT be sRGB-encoded. RGB is flat white; all
//     the shape lives in alpha, and the colour comes from the per-instance tint.
//   * Decal albedo IS an albedo, sampled by MeshStandardMaterial through an
//     sRGB-tagged texture. Authored in LINEAR reflectance, encoded on write with
//     encodeSRGB — same as every material in render/textures.js.

import { fbm, worley, norm01, blur, encodeSRGB } from '../render/textures.js';
import { clamp01, smoothstep } from '../core/mathx.js';

const RGBA = (n) => new Uint8Array(n * n * 4);
const sat = clamp01;

// fn(i, u, v, r) -> alpha in 0..1. u/v in 0..1, r = normalized radius from center.
function mask(size, fn) {
  const d = RGBA(size), inv = 1 / (size - 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, p = i * 4;
      const u = x * inv, v = y * inv;
      const dx = u * 2 - 1, dy = v * 2 - 1;
      const a = sat(fn(i, u, v, Math.sqrt(dx * dx + dy * dy)));
      d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = a * 255;
    }
  }
  return { size, data: d };
}

// ---------------------------------------------------------------------------
// particle sprites
// ---------------------------------------------------------------------------

/** Hot point with a tight core and a wide halo — sparks, embers, flash core. */
export function sparkSprite(size = 32) {
  return mask(size, (i, u, v, r) => {
    const core = Math.exp(-r * r * 26);
    const halo = Math.exp(-r * r * 5.5) * 0.45;
    return (core + halo) * smoothstep(1.0, 0.72, r);   // hard cutoff kills the quad edge
  });
}

/** Turbulent soft puff. Buoyant smoke, muzzle smoke, dust clouds. */
export function puffSprite(seed, size = 64, grain = 6, contrast = 0.72) {
  const n = norm01(blur(fbm(size, grain, grain, seed, 4, 0.55), size, 1));
  return mask(size, (i, u, v, r) => {
    const disc = smoothstep(1.0, 0.08, r);
    const t = 1 - contrast + contrast * n[i];
    return disc * disc * t;
  });
}

/** Speckled irregular blob — blood mist, wet spatter. */
export function spatterSprite(seed, size = 48) {
  const w = worley(size, 6, 6, seed, true);
  const n = norm01(fbm(size, 5, 5, seed + 11, 3, 0.6));
  return mask(size, (i, u, v, r) => {
    const disc = smoothstep(1.0, 0.1, r * (0.78 + 0.44 * n[i]));
    return disc * (0.45 + 0.55 * (1 - w[i]));
  });
}

/** Longitudinal capsule: hot along v, falls off sharply across u. For tracers. */
export function tracerSprite(size = 32) {
  return mask(size, (i, u, v) => {
    const across = Math.exp(-Math.pow((u - 0.5) * 2, 2) * 7);
    const along = Math.pow(Math.sin(Math.PI * v), 0.55);
    return across * along;
  });
}

/** Four-point star + core. The classic muzzle-flash card. */
export function flashSprite(size = 64) {
  return mask(size, (i, u, v, r) => {
    const th = Math.atan2(v - 0.5, u - 0.5);
    const star = Math.pow(Math.abs(Math.cos(th * 2)), 5) * 0.9 + 0.1;
    const core = Math.exp(-r * r * 30);
    return sat(core + Math.exp(-r * r * 4.0) * star) * smoothstep(1.0, 0.78, r);
  });
}

// ---------------------------------------------------------------------------
// impact decals
// ---------------------------------------------------------------------------
//
// One generator, four surface programs. A hole in concrete is a dark crater in a
// pale spall halo with radial hairline cracks; in sheet metal it is a small dark
// punch with a bright torn lip; in glass it is a white spiderweb around a milky
// pulverised core; in wood it is a dark bore with splinters lifted along grain.

const DECAL = {
  concrete: {
    rCore: 0.13, rRing: 0.50, edge: 0.40,
    core: [0.014, 0.013, 0.012], ring: [0.52, 0.51, 0.485],
    crackAmt: 0.85, crackPow: 7, crackCol: [0.05, 0.048, 0.045],
    ringAlpha: 0.72, spokes: 0, lip: 0,
  },
  metal: {
    rCore: 0.16, rRing: 0.30, edge: 0.16,
    core: [0.010, 0.010, 0.011], ring: [0.30, 0.29, 0.28],
    crackAmt: 0.30, crackPow: 9, crackCol: [0.42, 0.40, 0.37],
    ringAlpha: 0.85, spokes: 11, lip: 0.92,
  },
  glass: {
    rCore: 0.10, rRing: 0.62, edge: 0.28,
    core: [0.30, 0.33, 0.35], ring: [0.62, 0.68, 0.72],
    crackAmt: 1.0, crackPow: 5, crackCol: [0.78, 0.84, 0.88],
    ringAlpha: 0.22, spokes: 9, lip: 0.0,
  },
  wood: {
    rCore: 0.14, rRing: 0.42, edge: 0.46,
    core: [0.012, 0.009, 0.006], ring: [0.16, 0.105, 0.055],
    crackAmt: 0.6, crackPow: 6, crackCol: [0.20, 0.135, 0.07],
    ringAlpha: 0.62, spokes: 6, lip: 0.0,
  },
};

export const DECAL_KINDS = Object.keys(DECAL);

/** RGBA, sRGB-encoded albedo in rgb, coverage in a. */
export function decalRGBA(kind, seed, size = 128) {
  const K = DECAL[kind] ?? DECAL.concrete;
  const warp = norm01(fbm(size, 5, 5, seed, 4, 0.6));            // irregular outline
  const grit = norm01(fbm(size, 14, 14, seed + 37, 3, 0.5));     // aggregate breakup
  const d = RGBA(size), inv = 1 / (size - 1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x, p = i * 4;
      const dx = x * inv * 2 - 1, dy = y * inv * 2 - 1;
      const r0 = Math.sqrt(dx * dx + dy * dy);
      const th = Math.atan2(dy, dx);
      // Warping the radius, not the alpha, keeps the crater outline organic
      // without softening the crisp core edge.
      const r = r0 * (1 - K.edge * 0.5 + K.edge * warp[i]);

      const core = 1 - smoothstep(K.rCore * 0.55, K.rCore, r);
      const ring = (1 - smoothstep(K.rCore, K.rRing, r)) * (0.55 + 0.45 * grit[i]);

      // Radial hairline cracks: angular ridges that only exist outside the core.
      let crack = 0;
      if (K.crackAmt > 0) {
        const ang = Math.abs(Math.sin(th * (3 + K.spokes * 0.5) + warp[i] * 6.0));
        const rad = Math.pow(Math.max(0, 1 - r / (K.rRing * 2.1)), 1.4);
        crack = Math.pow(ang, K.crackPow) * rad * K.crackAmt;
      }
      // Torn lip: a bright annulus right at the punch edge (sheet metal).
      const lip = K.lip > 0
        ? K.lip * Math.exp(-Math.pow((r - K.rCore) / (K.rCore * 0.45), 2))
        : 0;

      const a = sat(core + ring * K.ringAlpha + crack + lip * 0.8) *
                smoothstep(1.0, 0.86, r0);   // guarantee alpha 0 at the quad border

      // Layer LINEAR reflectance back to front.
      let cr = K.ring[0], cg = K.ring[1], cb = K.ring[2];
      cr = cr * (0.75 + 0.5 * grit[i]); cg = cg * (0.75 + 0.5 * grit[i]); cb = cb * (0.75 + 0.5 * grit[i]);
      const kC = sat(crack * 1.6);
      cr += (K.crackCol[0] - cr) * kC; cg += (K.crackCol[1] - cg) * kC; cb += (K.crackCol[2] - cb) * kC;
      const kL = sat(lip);
      cr += (0.58 - cr) * kL; cg += (0.56 - cg) * kL; cb += (0.52 - cb) * kL;
      const kK = sat(core);
      cr += (K.core[0] - cr) * kK; cg += (K.core[1] - cg) * kK; cb += (K.core[2] - cb) * kK;

      d[p] = encodeSRGB(sat(cr)) * 255;
      d[p + 1] = encodeSRGB(sat(cg)) * 255;
      d[p + 2] = encodeSRGB(sat(cb)) * 255;
      d[p + 3] = a * 255;
    }
  }
  return { size, data: d };
}

// ---------------------------------------------------------------------------
// material-name -> impact behaviour
// ---------------------------------------------------------------------------

// `mat` on weapon:impact is a material-library name. Unknown or absent names
// fall back to concrete, per the pinned event contract.
const MAT_KIND = {
  concrete: 'concrete', concreteWall: 'concrete', concreteFloor: 'concrete',
  plaster: 'concrete', brick: 'concrete', tile: 'concrete',
  asphalt: 'concrete', asphaltLane: 'concrete', gravel: 'concrete',
  metal: 'metal', paintedMetal: 'metal', corrugated: 'metal',
  rustedSteel: 'metal', chainlink: 'metal',
  glass: 'glass',
  wood: 'wood', canvas: 'wood', rubber: 'wood',
};

export const kindOf = (mat) => MAT_KIND[mat] ?? 'concrete';

// Fallback dust tints (LINEAR) when the material library can't be sampled.
export const KIND_DUST = {
  concrete: [0.46, 0.45, 0.43],
  metal: [0.20, 0.20, 0.21],
  glass: [0.55, 0.60, 0.63],
  wood: [0.17, 0.11, 0.06],
};

// Per-kind impact energy budget: how much of each system a single round spends.
export const KIND_FX = {
  concrete: { sparks: 5, spark: 0.55, dust: 12, smoke: 2, dustSpd: 2.2 },
  metal:    { sparks: 22, spark: 1.0, dust: 3, smoke: 1, dustSpd: 1.4 },
  glass:    { sparks: 16, spark: 0.7, dust: 5, smoke: 0, dustSpd: 2.6 },
  wood:     { sparks: 3, spark: 0.35, dust: 10, smoke: 2, dustSpd: 1.8 },
};
