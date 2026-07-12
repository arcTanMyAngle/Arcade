# claude.md — Self-Instructions (Uncanny Carnival)

## Scope
Applies to `Arcade/carnival/` only. Root `Arcade/` is a separate Rust kart project — never edit root `plan.md`/`handoff.md`/`src/*.rs`.

## Token discipline
- No filler, no restating instructions, no re-explaining done work. Output = code + dense docs.
- Short vars (`v`,`p`,`dt`,`e`,`μ`,`n`), but clear function names. Comment **only** non-obvious math (quaternions, swept tests, friction/backspin, spatial-audio matrices).
- Modular, reusable utils; never copy-paste physics/audio between games.
- Update `handoff.md` at the end of each work chunk.

## Determinism (hard rule)
- Fixed 60Hz substep. No `Math.random`, no wall-clock, no frame-rate coupling in physics/scoring.
- All variation via `mulberry32(seed)`; log seed. Same inputs ⇒ same result.
- True skill > rigged: never fudge hitboxes/scores to help or punish. Difficulty = honest physics constants only.

## Aesthetic rules — Weaponized Uncanny Valley
- Hyper-real PBR (procedural canvas textures: fine noise, worn specular) on **slightly wrong**
  geometry — subtle scale skew / asymmetry (`uncannySkew`, ~3–8%), never cartoonish.
- Lighting: stark clinical fluorescent white key + **off-color neon** rims (sickly green/magenta),
  near-zero ambient, hard shadows. Unsettling, not cozy.
- Optional post: faint chromatic aberration + vignette behind a flag. Restraint = uncanny.

## Audio rules — Auditory Tunnel Vision
- Ambient carnival bed: heavy lowpass (~400Hz), low gain — drowned, distant, wrong.
- Critical SFX (wind, breath, impact, mallet, glass): dry, crisp, full-band, spatially absolute (`PannerNode` at emitter). They must cut cleanly through the muffled bed.
- 100% synthesized — no audio files.

## Code conventions
- ES modules. `physics.js` imports nothing (node-testable). `three` only where rendering.
- Games export `create(ctx)` → `{ step(dt), render(alpha), teardown() }`. `ctx` = shared core handles.
- Pool projectiles; instance repeated props; reuse scratch vectors; dispose on teardown.
- Perf budget: 60fps, no per-frame heap growth.

## Workflow
- Docs before code (done → await approval). After Level 1, pause for playtest before Levels 2–6.
- Each level: implement → determinism check → perf check → update handoff.
- Model intent: render/physics = Sonnet-class; aesthetic/docs = Opus-class; boilerplate = Haiku-class (current gen).
