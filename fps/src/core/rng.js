// Seeded RNG + value noise. Zero imports — node-testable.
// House rule: no Math.random anywhere in sim/scoring/asset-gen paths.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic hash -> [0,1). Used by texture gen where a stateful stream is awkward.
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// Value noise, tileable on `period` so textures wrap seamlessly.
export function valueNoise2(x, y, seed = 0, period = 256) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (n) => ((n % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const u = fade(xf), v = fade(yf);
  return lerp(
    lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), u),
    lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), u),
    v
  );
}

// fBm — the workhorse for every procedural surface in this project.
export function fbm2(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, period = 256 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013, period * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Ridged fBm — for cracks, scratches, rock. 1 - |signed| sharpens creases into lines.
export function ridge2(x, y, opts = {}) {
  const { octaves = 5, lacunarity = 2, gain = 0.5, seed = 0, period = 256 } = opts;
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 7919, period * freq) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Worley/cellular F1 — concrete aggregate, chipped paint, hex camo cells.
export function worley2(x, y, seed = 0, period = 16) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period, wy = ((cy % period) + period) % period;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 3301);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}
