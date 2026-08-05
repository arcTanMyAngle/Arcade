// Fixed-timestep accumulator with render interpolation.
// Sim runs at TICK_HZ regardless of display rate; render lerps by `alpha`.
// Zero imports — node-testable.

export const TICK_HZ = 128;              // esports-standard sim rate; crisp for hitreg + recoil
export const TICK_DT = 1 / TICK_HZ;
const MAX_STEPS = 8;                     // spiral-of-death clamp: drop sim time, never stall

export function createLoop({ step, render, now = () => performance.now() }) {
  let acc = 0, last = now(), running = false, raf = 0;
  let tick = 0;
  const stats = { fps: 0, frameMs: 0, simMs: 0, steps: 0, _acc: 0, _n: 0 };

  function frame() {
    if (!running) return;
    const t = now();
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 0.25) dt = 0.25;            // tab-restore guard
    acc += dt;

    const s0 = now();
    let steps = 0;
    while (acc >= TICK_DT && steps < MAX_STEPS) {
      step(TICK_DT, tick++);
      acc -= TICK_DT;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0;
    stats.simMs = now() - s0;
    stats.steps = steps;

    render(acc / TICK_DT, dt);

    stats.frameMs = now() - t;
    stats._acc += dt; stats._n++;
    if (stats._acc >= 0.5) { stats.fps = stats._n / stats._acc; stats._acc = 0; stats._n = 0; }

    raf = requestAnimationFrame(frame);
  }

  return {
    stats,
    get tick() { return tick; },
    start() { if (running) return; running = true; last = now(); acc = 0; raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); },
  };
}
