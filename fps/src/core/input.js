// Pointer-lock input. Mouse deltas ACCUMULATE on the DOM event stream and are
// CONSUMED once per sim tick as an immutable InputFrame.
//
// Invariant (mirrors carnival M11): sim code reads ONLY `frame`, never live DOM
// state. Guarantees identical results for identical frame sequences regardless of
// how many render frames or DOM events fell between ticks.

const KEYMAP = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ControlLeft: 'crouch', KeyC: 'crouch',
  KeyR: 'reload', KeyF: 'melee', KeyG: 'grenade', KeyQ: 'leanL', KeyE: 'leanR',
  KeyV: 'inspect', Digit1: 'slot1', Digit2: 'slot2', Tab: 'scores',
};

export function createInput(el, { sensitivity = 0.0022 } = {}) {
  const held = new Set();
  let dx = 0, dy = 0;                 // accumulated raw mouse counts since last tick
  let wheel = 0;
  let m1 = false, m2 = false;
  let locked = false;
  const edges = new Set();            // keys pressed since last tick (edge-triggered)

  const frame = {
    move: { x: 0, y: 0 },             // -1..1 normalized strafe/forward
    look: { x: 0, y: 0 },             // radians this tick
    fire: false, ads: false,
    jump: false, sprint: false, crouch: false,
    lean: 0,
    pressed: new Set(),               // edge events: 'reload','melee','slot1',...
    wheel: 0,
    locked: false,
  };

  const onKey = (e, down) => {
    const a = KEYMAP[e.code];
    if (!a) return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (down) { if (!held.has(a)) edges.add(a); held.add(a); }
    else held.delete(a);
  };
  const kd = (e) => onKey(e, true);
  const ku = (e) => onKey(e, false);
  const mm = (e) => { if (!locked) return; dx += e.movementX; dy += e.movementY; };
  const md = (e) => { if (e.button === 0) m1 = true; if (e.button === 2) m2 = true; };
  const mu = (e) => { if (e.button === 0) m1 = false; if (e.button === 2) m2 = false; };
  const wh = (e) => { wheel += Math.sign(e.deltaY); };
  const ctx = (e) => e.preventDefault();
  const lock = () => {
    locked = document.pointerLockElement === el;
    if (!locked) { held.clear(); m1 = m2 = false; }
  };
  const blur = () => { held.clear(); m1 = m2 = false; dx = dy = 0; };

  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  window.addEventListener('mousemove', mm);
  window.addEventListener('mousedown', md);
  window.addEventListener('mouseup', mu);
  window.addEventListener('wheel', wh, { passive: true });
  window.addEventListener('blur', blur);
  el.addEventListener('contextmenu', ctx);
  document.addEventListener('pointerlockchange', lock);

  const api = {
    frame,
    sensitivity,
    adsScale: 0.72,                   // CoD-style: ADS look slower than hipfire
    get locked() { return locked; },
    request() { el.requestPointerLock?.(); },

    // Called exactly once per sim tick, before sim reads `frame`.
    sample() {
      const f = frame;
      f.move.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      f.move.y = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
      // Normalize so diagonals aren't 1.41x faster (classic "strafe-jump" bug).
      const ml = Math.hypot(f.move.x, f.move.y);
      if (ml > 1) { f.move.x /= ml; f.move.y /= ml; }

      const s = api.sensitivity * (m2 ? api.adsScale : 1);
      f.look.x = dx * s; f.look.y = dy * s;
      dx = dy = 0;

      f.fire = m1; f.ads = m2;
      f.jump = held.has('jump'); f.sprint = held.has('sprint'); f.crouch = held.has('crouch');
      f.lean = (held.has('leanR') ? 1 : 0) - (held.has('leanL') ? 1 : 0);
      f.wheel = wheel; wheel = 0;
      f.locked = locked;

      f.pressed.clear();
      for (const a of edges) f.pressed.add(a);
      edges.clear();
      return f;
    },

    dispose() {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('wheel', wh);
      window.removeEventListener('blur', blur);
      el.removeEventListener('contextmenu', ctx);
      document.removeEventListener('pointerlockchange', lock);
    },
  };
  return api;
}

// Scripted input source for deterministic replay + headless capture.
// Same InputFrame shape, so sim cannot tell the difference.
export function createScriptedInput(script = []) {
  const frame = {
    move: { x: 0, y: 0 }, look: { x: 0, y: 0 },
    fire: false, ads: false, jump: false, sprint: false, crouch: false,
    lean: 0, pressed: new Set(), wheel: 0, locked: true,
  };
  let t = 0;
  return {
    frame, sensitivity: 1, adsScale: 1, locked: true, request() {}, dispose() {},
    sample() {
      const cur = script.find((s) => t >= s.from && t < s.to) || null;
      frame.move.x = cur?.move?.x ?? 0; frame.move.y = cur?.move?.y ?? 0;
      frame.look.x = cur?.look?.x ?? 0; frame.look.y = cur?.look?.y ?? 0;
      frame.fire = !!cur?.fire; frame.ads = !!cur?.ads;
      frame.jump = !!cur?.jump; frame.sprint = !!cur?.sprint; frame.crouch = !!cur?.crouch;
      frame.lean = cur?.lean ?? 0;
      frame.pressed.clear();
      for (const p of cur?.pressed ?? []) frame.pressed.add(p);
      t++;
      return frame;
    },
  };
}
