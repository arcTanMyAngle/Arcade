// input.js — pointer-lock aim + edge-triggered fire queue.
// Aim updates continuously (event-driven); fires are queued and drained by the game's step,
// so multi-substep frames never double-apply. No physics state lives here.
export function makeInput(canvas) {
  const st = {
    yaw: 0, pitch: 0,       // radians; yaw around +y, pitch around local x
    sens: 0.0022,
    scope: false,           // RMB held
    locked: false,
    fireQueue: [],          // LMB edge-fire queue (Level 1), drained per step()
    lmb: false,             // live LMB state (for hold/charge — Level 2)
    pressQueue: [],         // LMB down edges (charge start), drained per step()
    releaseQueue: [],       // LMB up edges (charge release), drained per step()
    keys: new Set()
  };
  const PITCH_LIM = Math.PI / 2 - 0.02;

  canvas.addEventListener('click', () => { if (!st.locked) canvas.requestPointerLock(); });
  document.addEventListener('pointerlockchange', () => { st.locked = document.pointerLockElement === canvas; });

  addEventListener('mousemove', (e) => {
    if (!st.locked) return;
    const s = st.sens * (st.scope ? 0.4 : 1); // scope steadies aim
    st.yaw -= e.movementX * s;
    st.pitch -= e.movementY * s;
    if (st.pitch > PITCH_LIM) st.pitch = PITCH_LIM;
    if (st.pitch < -PITCH_LIM) st.pitch = -PITCH_LIM;
  });

  addEventListener('mousedown', (e) => {
    if (!st.locked) return;
    if (e.button === 0) { st.fireQueue.push(1); st.lmb = true; st.pressQueue.push(1); }
    if (e.button === 2) st.scope = true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) { st.lmb = false; st.releaseQueue.push(1); }
    if (e.button === 2) st.scope = false;
  });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => st.keys.add(e.code));
  addEventListener('keyup', (e) => st.keys.delete(e.code));

  return st;
}
