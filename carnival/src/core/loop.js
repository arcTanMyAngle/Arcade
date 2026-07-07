// loop.js — deterministic fixed-timestep accumulator.
// Physics advances in fixed SUBSTEP chunks; render gets an interpolation alpha.
import { SUBSTEP } from './physics.js';

export function makeLoop(step, render) {
  let acc = 0, last = 0, raf = 0, running = false;
  const MAX_FRAME = 0.25; // clamp huge dt (tab-switch) so we never spiral

  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    acc += dt;
    // advance physics in fixed chunks — identical regardless of framerate
    let guard = 0;
    while (acc >= SUBSTEP && guard++ < 300) { step(SUBSTEP); acc -= SUBSTEP; }
    render(acc / SUBSTEP); // alpha for visual interpolation
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { if (running) return; running = true; last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); }
  };
}
