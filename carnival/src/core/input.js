// input.js — thin DOM adapter over kinetics.js (M11). Registers listeners, normalizes coords to NDC,
// forwards events into a kin instance, and once per substep folds them into an immutable input.frame
// via snap(). Also carries the LEGACY SHIM (fireQueue/pressQueue/releaseQueue/lmb/scope/yaw/pitch/keys)
// so the 6 pre-kinetic booths run untouched — the shim is DOM-driven in live play and frame-driven on
// replay, so a recorded frame log reconstructs the old game identically. Deleted at M15. See plan.md §3.1.
import {
  makeKin, makeFrame, kinPointer, kinButton, kinKey, kinReset, kinSnap,
  packFrame, unpackFrame, KEYMAP
} from './kinetics.js';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyF', 'KeyR']);

export function makeInput(canvas) {
  const kin = makeKin();
  const frames = [makeFrame(), makeFrame()];   // double-buffered: last frame stays valid while next builds
  let fi = 0;
  let replay = null;                            // { f64, n, i } when replaying a recorded log
  let rec = null;                               // { f64, n, cap } while recording
  let rect = canvas.getBoundingClientRect();
  const PITCH_LIM = Math.PI / 2 - 0.02;

  const st = {
    kin, frame: frames[0], mode: 'lock', hudActive: false,
    // --- legacy shim (unchanged semantics) ---
    yaw: 0, pitch: 0, sens: 0.0022, scope: false, locked: false,
    fireQueue: [], pressQueue: [], releaseQueue: [], lmb: false, keys: new Set()
  };

  const refreshRect = () => { rect = canvas.getBoundingClientRect(); };
  const ndx = (px) => (px - rect.left) / rect.width * 2 - 1;
  const ndy = (py) => -((py - rect.top) / rect.height * 2 - 1);
  const clearEdges = () => { st.fireQueue.length = 0; st.pressQueue.length = 0; st.releaseQueue.length = 0; };
  const syncKeys = (bits) => { st.keys.clear(); for (const code in KEYMAP) if (bits & KEYMAP[code]) st.keys.add(code); };

  addEventListener('resize', refreshRect);

  canvas.addEventListener('click', () => { if (st.mode === 'lock' && !st.locked) canvas.requestPointerLock(); });
  document.addEventListener('pointerlockchange', () => {
    st.locked = document.pointerLockElement === canvas;
    kinReset(kin); clearEdges();               // SWALLOW window + drag reset kills phantom edges on transition
  });

  addEventListener('mousemove', (e) => {
    if (replay) return;
    const dnx = e.movementX / rect.width * 2, dny = -e.movementY / rect.height * 2; // NDC-unit deltas
    if (st.mode === 'lock') {
      if (!st.locked) return;
      const s = st.sens * (st.scope ? 0.4 : 1); // scope steadies aim
      st.yaw -= e.movementX * s; st.pitch -= e.movementY * s;
      if (st.pitch > PITCH_LIM) st.pitch = PITCH_LIM;
      if (st.pitch < -PITCH_LIM) st.pitch = -PITCH_LIM;
      kinPointer(kin, 0, 0, dnx, dny, e.timeStamp);
    } else {
      kinPointer(kin, ndx(e.clientX), ndy(e.clientY), dnx, dny, e.timeStamp);
    }
  });

  addEventListener('mousedown', (e) => {
    if (replay) return;
    if (st.mode === 'lock') {
      if (!st.locked) return;                  // legacy: the lock-acquiring click never fires
      if (e.button === 0) { st.fireQueue.push(1); st.pressQueue.push(1); st.lmb = true; kinButton(kin, 0, true, 0, 0, e.timeStamp); }
      else if (e.button === 2) { st.scope = true; kinButton(kin, 2, true, 0, 0, e.timeStamp); }
    } else {
      const nx = ndx(e.clientX), ny = ndy(e.clientY);
      if (e.button === 0) { st.lmb = true; kinButton(kin, 0, true, nx, ny, e.timeStamp); }
      else if (e.button === 2) { st.scope = true; kinButton(kin, 2, true, nx, ny, e.timeStamp); }
    }
  });
  addEventListener('mouseup', (e) => {
    if (replay) return;
    const nx = st.mode === 'cursor' ? ndx(e.clientX) : 0, ny = st.mode === 'cursor' ? ndy(e.clientY) : 0;
    if (e.button === 0) { st.lmb = false; st.releaseQueue.push(1); kinButton(kin, 0, false, nx, ny, e.timeStamp); }
    else if (e.button === 2) { st.scope = false; kinButton(kin, 2, false, nx, ny, e.timeStamp); }
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    if (replay) return;
    st.keys.add(e.code);
    const bit = KEYMAP[e.code]; if (bit) kinKey(kin, bit, true);
    if (st.hudActive && PREVENT.has(e.code)) e.preventDefault(); // no page-scroll on Space/arrows in a booth
  });
  addEventListener('keyup', (e) => {
    if (replay) return;
    st.keys.delete(e.code);
    const bit = KEYMAP[e.code]; if (bit) kinKey(kin, bit, false);
  });

  // reconstruct the legacy shim from a frame (replay path) so unmigrated games replay identically.
  function driveShim(f) {
    st.yaw = f.yaw; st.pitch = f.pitch; st.lmb = !!f.lmb; st.scope = !!f.rmb;
    for (let i = 0; i < f.press; i++) { st.fireQueue.push(1); st.pressQueue.push(1); }
    for (let i = 0; i < f.release; i++) st.releaseQueue.push(1);
    syncKeys(f.keys);
  }

  st.snap = function () {
    const f = frames[fi]; fi ^= 1;
    if (replay) {
      if (replay.i < replay.n) { unpackFrame(replay.f64, replay.i * 24, f); replay.i++; }
      else { const nn = f.n; for (const k in f) f[k] = 0; f.n = nn + 1; } // exhausted → idle
      driveShim(f);
    } else {
      kinSnap(kin, f);
      f.yaw = st.yaw; f.pitch = st.pitch; f.rmb = st.scope ? 1 : 0; // mirror lock-mode accumulator into the frame
      if (rec && rec.n < rec.cap) packFrame(f, rec.f64, rec.n++ * 24);
    }
    st.frame = f;
    return f;
  };

  st.setMode = function (m) {
    st.mode = m; kin.mode = m === 'cursor' ? 1 : 0; kinReset(kin); clearEdges(); refreshRect();
    if (m === 'cursor') { if (st.locked) document.exitPointerLock?.(); document.body.style.cursor = 'crosshair'; }
  };
  st.setHudActive = (on) => { st.hudActive = on; };

  // --- dev record/replay harness (main.js, ?dev=1) ---
  st.record = function (on) { if (on) { rec = { f64: new Float64Array(24 * 8192), n: 0, cap: 8192 }; return null; } const r = rec; rec = null; return r; };
  st.startReplay = function (f64, n) { replay = { f64, n, i: 0 }; clearEdges(); };
  st.stopReplay = function () { replay = null; };
  st.replaying = () => !!replay;

  return st;
}
