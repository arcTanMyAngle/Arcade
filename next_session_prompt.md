# Next-session kickoff prompt — wii_kart (paste this to start)

Act as the continuing **Lead Game Designer and Principal Engine Architect** for the
`wii_kart` Rust project — a 100% procedural 3D combat racer on macroquad 0.4.14
(`features = ["audio"]`). You have absolute authority over detailed design, aesthetic,
and technical decisions — invent the mechanics and write the code. Lead.

Goal of this arc: take it from "great combat racer" to a polished, deep, replayable
game — drafting depth, game-feel juice, spatial awareness, configurability, and finally
race-your-own-ghost replay. One shippable milestone at a time. (No moonshots — finish
the planned arc; split-screen / anti-grav / online stay out of scope.)

## Current state (all done, tested, benchmarked)
- M1–M4 Combat Grand Prix pivot, M5 kart-to-kart collision, M6 game-flow state machine
  (Menu→ClassSelect→TrackSelect→Race→Results + pause), M7 procedural audio
  (`src/audio.rs`), M8 track variety + boost pads (3 circuits, 6 pads/lap).
- **39 tests pass, 0 warnings**, debug + `--release` clean. Sim substep **~134 µs** @ 8
  karts (≤1% of the 16,667 µs frame; gate is < 500 µs).

## First, load full context (do not skip)
- `handoff.md` — project state, architecture map, one-frame data flow, the five core
  invariants, the **Performance budget** (baseline 141 µs; M8 re-run 134 µs), the
  non-obvious decisions (esp. the audio + boost-pad + track-switch notes), and the
  tech-debt / pending-smoke-test watch-list.
- `plan.md` — the **next FIVE milestones** with measurable DoD + per-milestone benchmark
  gates: **M5.1** (draft) → **M9** (juice/recovery + OOB respawn) → **M10** (minimap +
  rubber-band AI) → **M11** (settings + race options) → **M12** (best-lap ghost replay).
- your memory: `combat-grand-prix-roadmap.md` (milestone history + locked decisions).
- the source: `src/main.rs`, `src/game.rs`, `src/physics.rs`, `src/track_3d.rs`,
  `src/mesh_gen.rs`, `src/race.rs`, `src/combat.rs`, `src/shaders.rs`, `src/audio.rs`.

## This session's task: M5.1 — Slipstream / draft
Implement per `plan.md`'s M5.1 scope and DoD: a speed bonus when tucked **4–14 m** and
within **±12°** directly behind a leading kart; **+10–15 %** top speed via a per-kart
draft factor that **ramps/decays in < 0.5 s**; reuse the collision grid + a parallel
`f32` array (**zero new alloc**); feed it into `physics` as an overspeed allowance.
Pairs naturally with the M8 boost pads (chain a draft into a pad). If you judge a
different milestone is the better next step, say so with reasoning first. After M5.1,
continue **M9 → M10 → M11 → M12** in order if scope allows, one milestone at a time.

## Non-negotiable invariants (preserve in every change)
1. 60 Hz fixed timestep is sacred; rendering interpolates.
2. Zero allocation in the gameplay loop / per frame (reuse pre-sized buffers).
3. Rayon for data-parallel passes; never mutate shared kart state from a `par_iter`
   (write events/draft only in single-threaded phases or each entity's own slot).
4. `KartState` stays lean and `Copy`; new per-entity data goes in parallel arrays.
5. 100% procedural assets (no `.obj`/`.png`/audio files — generate in-memory).

## Done gate (measurable, per plan.md)
- Each milestone adds ≥1 headless test; `cargo test` green, **0 warnings**.
- Perf: re-run `cargo test --release -- --ignored --nocapture bench_sim_substep`; keep
  substep **< 500 µs** @ 8 karts and meet the per-milestone delta budget (M5.1 < +20,
  M9 < +15, M10 < +10, M11 ≈ +0, M12 < +10 µs); record the measured delta. **0 new
  per-tick allocations.** `cargo build` and `cargo build --release` clean.

## Deliver, in order
1. A short design note (mechanic + math, data flow, where it hooks in, tunables).
2. The implementation, integrated and matching the surrounding code's style.
3. Headless test(s) + re-run the benchmark and record the substep delta.
4. A brief summary; update `handoff.md` + `plan.md` (mark the milestone done, refresh the
   benchmark line and recommended-next) and the memory roadmap + `MEMORY.md`.

## Workflow
Start in **PLAN MODE** — read the files above, then present a plan for the milestone and
wait for approval. Once approved, switch to auto-accept and implement end-to-end
autonomously (code, tests, bench, docs) without pausing for routine confirmations.

## Dev-env constraint + pending human smoke tests
I can't run a GPU window or audio device here, so verify headlessly and explicitly call
out what needs a human `cargo run --release` pass. These are **already pending my pass on
a real machine** — remind me and fold any new feel/audio checks into the same session:
- **M8** track/pad feel (3 circuits drive well + don't self-clip; track-select overhead
  preview reads clearly; pads visible/catchable; drift→pad chain feels good),
- **M7** audio mix (engine crossfade, per-class fire timbres, AI-fire busyness, `[`/`]`
  volume; the `audio` feature opens a device at startup — may warn/fail on no-audio machines),
- **M6** front-end feel (full menu loop, spinning class preview + stat bars, pause overlay,
  per-state cameras), and **M5** collision feel (bump strength, start-line pile-up,
  side-by-side on a banked turn).

Keep changes clean, well-commented, reviewable; Codex reviews afterward.
