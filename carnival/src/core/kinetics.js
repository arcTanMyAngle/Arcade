// kinetics.js — PURE gesture/input math. Imports nothing → node-testable with synthetic streams.
// Owns: key bitmask, flick estimator (windowed mean), drag FSM, and the per-substep InputFrame
// snapshot (kinSnap) that folds all buffered events into plain floats. Determinism model: wall-clock
// (e.timeStamp) lives only in the capture buffers; kinSnap bakes flick velocity into floats BEFORE the
// sim reads it, so a frame log replays identically. See plan.md §3.1.

export const K = { A: 1, D: 2, W: 4, S: 8, SPACE: 16, F: 32, SHIFT: 64, R: 128 };
export const KEYMAP = { KeyA: 1, KeyD: 2, KeyW: 4, KeyS: 8, Space: 16, KeyF: 32, ShiftLeft: 64, KeyR: 128 };
export const DPHASE = { IDLE: 0, PRESS: 1, DRAG: 2, RELEASE: 3 };

const RING = 32;         // flick sample ring size
export const SWALLOW = 8; // substeps of edge suppression after a lock/mode change
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// InputFrame factory — plain object of numbers (double-buffered by input.js). packFrame → 24 floats.
export function makeFrame() {
  return {
    n: 0, mode: 0, yaw: 0, pitch: 0, cx: 0, cy: 0, dx: 0, dy: 0,
    lmb: 0, rmb: 0, press: 0, release: 0, rmbPress: 0, rmbRelease: 0,
    dphase: 0, dragX0: 0, dragY0: 0, dragDX: 0, dragDY: 0, dragT: 0,
    flickVX: 0, flickVY: 0, keys: 0, keyPress: 0
  };
}

export function makeKin(cfg = {}) {
  return {
    dead: cfg.dead ?? 0.012, win: cfg.win ?? 100,
    n: 0, mode: 0,
    cx: 0, cy: 0, dx: 0, dy: 0,             // cursor NDC + summed delta this substep
    lmb: 0, rmb: 0,
    press: 0, release: 0, rmbPress: 0, rmbRelease: 0,
    dphase: DPHASE.IDLE, dragX0: 0, dragY0: 0, dragDX: 0, dragDY: 0, dragT: 0,
    flickVX: 0, flickVY: 0,
    buf: new Float64Array(RING * 3), head: -1, cnt: 0,  // flick ring: [dx,dy,t]*32
    keys: 0, keyPress: 0,
    swallow: 0
  };
}

// mode/lock change: drop the drag machine + edge counters, arm SWALLOW window, clear flick buffer.
export function kinReset(kin) {
  kin.press = kin.release = kin.rmbPress = kin.rmbRelease = kin.keyPress = 0;
  kin.dphase = DPHASE.IDLE; kin.dragDX = kin.dragDY = kin.dragT = 0;
  kin.flickVX = kin.flickVY = 0;
  kin.head = -1; kin.cnt = 0;
  kin.swallow = SWALLOW;
}

// one move sample: sum delta, push flick ring, advance PRESS→DRAG past the dead-zone.
export function kinPointer(kin, nx, ny, dnx, dny, t) {
  kin.cx = nx; kin.cy = ny; kin.dx += dnx; kin.dy += dny;
  kin.head = (kin.head + 1) % RING;
  kin.buf[kin.head * 3] = dnx; kin.buf[kin.head * 3 + 1] = dny; kin.buf[kin.head * 3 + 2] = t;
  if (kin.cnt < RING) kin.cnt++;
  if (kin.dphase === DPHASE.PRESS || kin.dphase === DPHASE.DRAG) {
    kin.dragDX = nx - kin.dragX0; kin.dragDY = ny - kin.dragY0;
    if (kin.dphase === DPHASE.PRESS && Math.hypot(kin.dragDX, kin.dragDY) > kin.dead) kin.dphase = DPHASE.DRAG;
  }
}

// btn: 0=LMB 2=RMB. LMB-up on a DRAG computes the flick and opens a one-frame RELEASE.
export function kinButton(kin, btn, down, nx, ny, t) {
  if (btn === 0) {
    if (down) {
      kin.lmb = 1;
      if (kin.swallow <= 0) {
        kin.press++;
        kin.dphase = DPHASE.PRESS; kin.dragX0 = nx; kin.dragY0 = ny;
        kin.dragDX = kin.dragDY = kin.dragT = 0;
        kin.head = -1; kin.cnt = 0;         // flick window is per-drag
      }
    } else {
      kin.lmb = 0;
      if (kin.swallow <= 0) {
        kin.release++;
        if (kin.dphase === DPHASE.DRAG) {
          const o = { vx: 0, vy: 0 };
          flickFromSamples(kin.buf, kin.head, kin.cnt, t, kin.win, o);
          kin.flickVX = o.vx; kin.flickVY = o.vy; kin.dphase = DPHASE.RELEASE;
        } else kin.dphase = DPHASE.IDLE;     // sub-dead click: edges only, no RELEASE
      }
    }
  } else if (btn === 2) {
    if (down) {
      kin.rmb = 1;
      if (kin.swallow <= 0) { kin.rmbPress++; if (kin.dphase !== DPHASE.IDLE) kin.dphase = DPHASE.IDLE; } // cancels a drag
    } else { kin.rmb = 0; if (kin.swallow <= 0) kin.rmbRelease++; }
  }
}

export function kinKey(kin, bit, down) {
  if (down) { if (!(kin.keys & bit)) kin.keyPress |= bit; kin.keys |= bit; }
  else kin.keys &= ~bit;
}

// fold buffered events → immutable frame, then clear per-substep accumulators + advance timers.
export function kinSnap(kin, f) {
  f.n = kin.n++; f.mode = kin.mode;
  f.cx = kin.cx; f.cy = kin.cy; f.dx = kin.dx; f.dy = kin.dy;
  f.lmb = kin.lmb; f.rmb = kin.rmb;
  f.press = kin.press; f.release = kin.release; f.rmbPress = kin.rmbPress; f.rmbRelease = kin.rmbRelease;
  f.dphase = kin.dphase; f.dragX0 = kin.dragX0; f.dragY0 = kin.dragY0;
  f.dragDX = kin.dragDX; f.dragDY = kin.dragDY; f.dragT = kin.dragT;
  f.flickVX = kin.dphase === DPHASE.RELEASE ? kin.flickVX : 0;
  f.flickVY = kin.dphase === DPHASE.RELEASE ? kin.flickVY : 0;
  f.keys = kin.keys; f.keyPress = kin.keyPress;
  // yaw/pitch (lock-mode absolute aim) are written by input.js after this call.
  kin.dx = kin.dy = 0;
  kin.press = kin.release = kin.rmbPress = kin.rmbRelease = kin.keyPress = 0;
  if (kin.swallow > 0) kin.swallow--;
  if (kin.dphase === DPHASE.DRAG) kin.dragT++;
  if (kin.dphase === DPHASE.RELEASE) { kin.dphase = DPHASE.IDLE; kin.flickVX = kin.flickVY = 0; }
  return f;
}

// Windowed-mean flick estimator over the trailing winMs of ring samples (NDC units → units/s).
// Reproducible + robust to event coalescing (beats an EMA). Verbatim per plan.md §3.1.
export function flickFromSamples(buf, head, n, tRel, winMs, out) {
  let sx = 0, sy = 0, tOld = tRel;
  for (let i = 0; i < n; i++) {
    const j = ((head - i) % 32 + 32) % 32, t = buf[j * 3 + 2];
    if (tRel - t > winMs) break;
    sx += buf[j * 3]; sy += buf[j * 3 + 1]; tOld = t;
  }
  const span = Math.max(tRel - tOld, 8);      // ms clamp: kills div-blowup on 1-sample flicks
  out.vx = sx / span * 1000; out.vy = sy / span * 1000; return out;
}

// D=(dx,dy) NDC(+y up); pulling down => dy<0. Three independent hand dimensions (plan.md §6.1).
export function dragToShot(dx, dy, cfg, out) {
  const pull = Math.min(Math.hypot(dx, dy), cfg.pullMax);            // LENGTH  -> power
  out.v0 = cfg.vMin + (cfg.vMax - cfg.vMin) * (pull / cfg.pullMax);
  const steep = Math.atan2(Math.max(-dy, 1e-6), Math.abs(dx));       // STEEPNESS -> arc
  out.th = clamp(steep, cfg.thMin, cfg.thMax);
  out.az = clamp(-dx * cfg.azK, -cfg.azMax, cfg.azMax);              // X -> lateral (mirrored slingshot)
  out.pull = pull; return out;
}

// flick velocity → launch speed + azimuth (ringtoss/skeeball, plan.md §4). Monotone + clamped.
export function flickToLaunch(vx, vy, cfg, out) {
  const mag = Math.hypot(vx, vy);
  out.v0 = clamp(cfg.k * mag, cfg.vMin, cfg.vMax);
  out.az = clamp(vx * cfg.azK, -cfg.azMax, cfg.azMax);
  out.mag = mag; return out;
}

// timing-accuracy kernel: 1 at zero error, linearly to 0 at the window edge, 0 beyond.
export const wristQ = (err, win) => (err > win ? 0 : 1 - err / (win + 1));
export const beatAcc = wristQ;                // same shape, named per use

// --- pack/hash: 24 floats/frame, fixed order (determinism gates) ---
const FIELDS = [
  'n', 'mode', 'yaw', 'pitch', 'cx', 'cy', 'dx', 'dy', 'lmb', 'rmb', 'press', 'release',
  'rmbPress', 'rmbRelease', 'dphase', 'dragX0', 'dragY0', 'dragDX', 'dragDY', 'dragT',
  'flickVX', 'flickVY', 'keys', 'keyPress'
];
export const FRAME_FLOATS = FIELDS.length; // 24

export function packFrame(f, f64, i) { for (let k = 0; k < 24; k++) f64[i + k] = f[FIELDS[k]]; return i + 24; }
export function unpackFrame(f64, i, f) { for (let k = 0; k < 24; k++) f[FIELDS[k]] = f64[i + k]; return f; }

// FNV-1a over the packed bytes → uint32.
export function hashFrames(f64, n) {
  const b = new Uint8Array(f64.buffer, f64.byteOffset, n * 24 * 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
