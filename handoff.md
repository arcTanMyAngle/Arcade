# wii_kart — Project Handoff

**What it is:** a procedurally-generated, 3D arcade **combat racer** (Mario-Kart-Wii feel)
built in Rust on `macroquad` 0.4.14. Originally a driving prototype; evolved through a
4-milestone "Combat Grand Prix" pivot into a full race + combat game.

**Status:** ✅ Playable. Builds clean, **47 tests pass (+1 ignored bench), zero
warnings**. Custom GLSL shaders confirmed compiling and running on the target Intel
Arc iGPU. Karts physically collide (M5); the whole thing is wrapped in a game-flow
state machine — Menu → ClassSelect → TrackSelect → Race → Results — with in-race
pause (M6); it has a **voice: 100% procedural audio** (M7, `src/audio.rs`); it has
**3 selectable circuits + boost pads** (M8); and it now has a **HUD minimap + rubber-band
catch-up AI** (M10).

---

## Build / run / test

```sh
cargo run --release      # play it (release profile is fat-LTO; first build is slow)
cargo test               # 45 tests + 1 ignored bench, all headless (no window/GPU/audio device)
cargo build              # debug build (deps still optimized; see Cargo.toml profiles)
cargo test --release -- --ignored --nocapture bench_sim_substep   # perf baseline
```

Toolchain: Rust 1.82+ (repo built on 1.96). Deps: `macroquad = "0.4"` (locked 0.4.14,
**`features = ["audio"]`** as of M7 → pulls quad-snd/audrey/hound), `rayon = "1.10"`.
No external asset files — everything (meshes, shaders, **and audio PCM**) is procedural.

### Controls
| Input | Action |
|---|---|
| `W`/`Up`, `S`/`Down` | throttle / brake |
| `A`/`Left`, `D`/`Right` | steer |
| `Space` / `LeftShift` | drift (hold) → mini-turbo; same key arms a trick while airborne |
| `LeftCtrl` / `F` | fire cannon (held; per-class reload gates cadence) |
| `R` | restart race (in Race / Results) |
| `Esc` | context: quit (Menu) · back (ClassSelect / TrackSelect) · pause↔resume (Race) |
| `Enter` | confirm: to class-select (Menu) · class→track (ClassSelect) · start (TrackSelect) · to-menu (Results / pause) |
| `←` / `→` | move the cursor (ClassSelect / TrackSelect) |
| `[` / `]` | master volume down / up (M7) |

---

## Architecture map

Single binary crate. `main.rs` is the crate root and carries `#![allow(dead_code)]`
(crate-wide — some toolkit APIs are intentionally unused). Modules:

| File | Responsibility | Key public types |
|---|---|---|
| [src/main.rs](src/main.rs) | Window, GPU shell: samples keys → `FrameInput`, drives `Game`, chase/menu/preview/track cameras (+ **M9 shake offset**), render passes (material-bracketed) per `GameState`, boost-pad pass, all HUD + front-end screens (+ **M9 SPUN-OUT pulse / position ▲▼ / FINAL-LAP flash**, **M10 `Minimap` radar**); rebuilds road meshes + minimap on `track_dirty` | `Minimap` |
| [src/game.rs](src/game.rs) | **Top-level game flow (M6):** `GameState` machine (now incl. `TrackSelect`, M8), owns all sim + CPU-mesh state (incl. the **M10 `gaps` array**), holds the 60 Hz fixed-step loop, class-select → kart-0 commit, track commit, pause, **M9 hit-stop + screen-shake + respawn prev-snap**; emits audio events. Headless (no GPU) | `Game`, `GameState`, `Flow`, `FrameInput`, `CLASS_ORDER`, `TRACK_ORDER`, `TRACK_NAMES`, `NUM_KARTS` |
| [src/physics.rs](src/physics.rs) | 60 Hz arcade kart sim: driving, drift/trick/boost state machines, gravity/ground, **OOB respawn** (M9), **rubber-band factor** (M10, `rubber_band`), rayon-parallel AI + particles | `KartState`, `Input`, `ParticleSystem`, `RenderPose`, `SparkStage`, `rubber_band` |
| [src/track_3d.rs](src/track_3d.rs) | Closed cubic-Bézier circuits (3 layouts, M8; **`LAP_SCALE` longer laps**, M9), arc-length LUT, banked frames, O(1) ground queries, procedural road mesh, **boost pads** (`boost_at` reuses `track_u`) | `TrackSpline`, `Frame`, `GroundInfo`, `BoostPad` |
| [src/mesh_gen.rs](src/mesh_gen.rs) | All procedural meshes (kart + class cannon, wheel, ammo crate, projectiles, **boost pad**), pixel font, HUD icons. `MeshBuilder` stores **normals + unlit albedo** for the GPU to light | `MeshBuilder`, `build_*`, `KART_PALETTE`, spark colors |
| [src/race.rs](src/race.rs) | Race Director: countdown, anti-cheat checkpoint laps, live standings, finish board, **per-kart gap-to-leader** (`gaps_into`, M10) | `RaceDirector`, `Phase`, `RaceProgress`, `TOTAL_LAPS` |
| [src/combat.rs](src/combat.rs) | Cannons/classes, ammo, projectile pool, **lock-free spatial hash**, hit/spinout, combat AI (lead/dodge/standing, **rubber-band `effective_aggression`** M10), **kart-vs-kart collision** (per-class `mass`), **slipstream/draft factor** (M5.1, `compute_draft` → `Combat.draft`), **screen-shake trauma** (M9, `Combat.trauma`); pushes combat `Sfx` into the event sink | `Combat`, `ChassisClass`, `Projectile`, `ProjKind`, `SpatialGrid`, `KartCombat`, `AmmoCrate` |
| [src/audio.rs](src/audio.rs) | **Procedural audio (M7):** pure `synth` submodule (DSP + WAV encoder + per-sound recipes + engine/drift loop generators) is headless-testable; device-side `AudioBank` decodes the in-memory WAVs and drives playback (one-shots, speed-crossfaded engine bands, gated drift loop). `Sfx`/`SfxQueue` are the zero-alloc event wire | `AudioBank`, `Sfx`, `SfxQueue`, `synth::*` |
| [src/shaders.rs](src/shaders.rs) | Three custom GLSL ES materials (toon / road-noise / crate-pulse) with graceful fallback | `Shaders`, `LIGHT_DIR` |

Module dependency note: `mesh_gen` imports `combat::ChassisClass` (to mount the
class-specific cannon on the kart mesh). `physics` imports `mesh_gen` (spark colors).
This forms an intra-crate `use` cycle, which Rust permits — **not** a bug.

---

## One frame of the game loop

Classic fixed-timestep accumulator. Sim runs at a rigid 60 Hz; rendering interpolates.

**Top level (`main.rs`)**: each frame samples keys into a `game::FrameInput`, calls
`Game::update`, then renders by `GameState` (Menu/ClassSelect draw a backdrop + 2D UI;
Race/Results draw the world + HUD). `Game::update` runs the fixed-step loop **only** in
`Race` while unpaused — pausing simply runs **zero** substeps and holds the accumulator
at 0, so the sim is frozen and resume never fast-forwards. The front-end now runs
Menu → ClassSelect → **TrackSelect** → Race; `start_race` (fired from TrackSelect)
commits `classes[0]`, **builds the chosen `TrackSpline`** (`TRACK_ORDER[track_cursor]`,
with its boost pads), rebuilds `Combat` (grid + crates are track-sized) and kart-0's
mesh, respawns the grid, and sets `track_dirty` so `main` regenerates the GPU road
meshes once.

**Audio (M7):** `Game` records one-shot cues into a fixed-size, zero-alloc
`SfxQueue` (`game.events`, cleared at the top of every `update`) — flow transitions
push directly; `combat.step` pushes fire/explosion/pickup/bump via a `&mut SfxQueue`
sink (mirroring `&mut ParticleSystem`); `run_substeps` diffs race state for the
boost/countdown/lap cues. After `update`, `main` drains `game.events` into the
`AudioBank` and updates the continuous voices (engine pitch crossfaded from
`speed_ratio()`, drift screech gated on `is_drifting()`). The sim itself never
touches the audio device.

**Per fixed substep (`Game::run_substeps`, `while accumulator >= FIXED_DT`):** the loop
drains `FIXED_DT` first, then **if `hitstop > 0`** decrements it and `continue`s — a whole-sim
freeze that still advances the clock (M9 hit-stop), so the rest runs only on live substeps:
1. `compute_ai_inputs` — rayon-parallel spline-follower produces driving inputs for all karts.
2. Stamp player input on slot 0; clear edge-triggered actions after the first substep.
3. `combat.plan_ai` (Racing only) — post-processes **AI** driving inputs: dodge fire, aim-bias, trailing-kart drift. Player untouched.
4. Freeze gates: zero all inputs during countdown/finish (`race.inputs_locked()`); zero a stunned kart's input (`combat.stunned(i)`).
5. `step_all` — rayon-parallel physics integration (each kart also self-applies a **boost-pad boost** when its own ground query lands on a pad — M8; reads its **slipstream factor** from `&combat.draft` as an overspeed allowance — M5.1; and **respawns onto the nearest frame** if it has left the circuit — M9, riding the ground query). After it, a single-threaded **prev-snap** guard copies `karts[i]→prev_karts[i]` for any teleport (>30 m one-tick jump) so a respawn doesn't streak the interpolated render.
6. `race.update` — checkpoint/lap/standings bookkeeping.
7. `combat.step` — fire cannons, rebuild spatial hash, parallel projectile integrate+detect, single-threaded hit apply, crate pickups, single-threaded **kart-vs-kart collision resolve** (reuses the same grid), single-threaded **draft pass** (M5.1, for next tick's `step_all`), and accumulates **screen-shake trauma** (M9: nearby detonations / hard player bumps → `combat.trauma`, read after the call).
8. Emit + integrate particles. Then the post-combat **juice** pass: a fresh player spin-out edge sets `hitstop`/kicks `shake`; `shake` folds in `combat.trauma` and decays (bounded, →0 in <0.4 s).

**Per render frame:** interpolate poses (`alpha`), update chase cam (FOV widens with
speed/boost; a `game.shake²` random offset jitters eye+target — M9, render-side only),
then draw groups each bracketed by their material: ground (default) → track (`use_road`)
→ crates (`use_crate`) → projectiles+karts+wheels (`use_toon`) → particles (default) → 2D
HUD (incl. M9 "SPUN OUT" pulse, position-change ▲/▼, and the "FINAL LAP" flash).

---

## Core invariants (do not break these)

These were explicit design directives and are upheld throughout — preserve them in any change:

1. **60 Hz fixed timestep is sacred.** Gameplay logic runs only inside the `FIXED_DT` loop; rendering interpolates between the previous and current sim states.
2. **Zero allocation in the gameplay loop.** All buffers are pre-sized and reused: caller-owned `inputs`/`places`, the particle ring pool, the projectile ring pool, and the spatial grid (cells `clear()`ed, never freed). Confirm no `Vec` growth / `Box` / `format!` in hot paths.
3. **Rayon parallelism** for the data-parallel passes (`compute_ai_inputs`, `step_all`, particle integration, projectile integrate+detect).
4. **`KartState` stays lean and `Copy`.** New per-entity data goes in **parallel arrays** owned by `main` or a manager (`RaceDirector::progress`, `Combat::karts`), never bolted onto `KartState`. (Visual-only interpolation fields are the one established exception already living in `KartState`.)
5. **100% procedural assets.** No `.obj`/`.png`/audio files. Meshes from primitives; textures generated in-memory; shaders are inline GLSL strings.

---

## Non-obvious design decisions (read before editing)

- **Anti-cheat laps** (`race.rs`): the loop is `NUM_CHECKPOINTS = 24` ordered sectors; `RaceProgress.next_cp` is a **ratchet** advancing by exactly one. A lap counts only when sector 0 is collected in order, so reversing across the line or skipping a sector cannot fake a lap. The grid spawns **behind** the start/finish line (`GRID_START_BACK` in physics.rs) so every kart's first crossing legitimately opens lap 1.
- **Lock-free collision** (`combat.rs`): karts are inserted into `SpatialGrid` single-threaded once per tick; the 256-projectile pool then queries it **read-only** via `par_iter_mut`. Each projectile writes only its own slot + a deferred hit flag; effects (spinouts/AoE) are applied in a cheap single-threaded pass. No locks in the parallel phase. (With only 8 karts the grid is partly future-proofing; the real parallel win is over projectiles.)
- **Getting hit = spinout, not HP.** A hit scrubs speed and starts a stun timer (`KartCombat.spin`). `main` zeroes a stunned kart's `Input`; the renderer whirls it via `combat.spin_yaw(i)`. Physics stays ignorant of combat.
- **Slipstream/draft is a combat-computed factor fed into physics** (M5.1, `compute_draft` + `DRAFT_SPEED_MULT`). A kart drafts when it's tucked directly behind a leader: **4–14 m**, inside a **±12° rear-wake cone** (`dir·forward[leader] ≥ cos 12°`, where `dir` points me→leader), and headings agreeing within ~60°. A per-kart `Combat.draft: Vec<f32>` (parallel array — `KartState` stays lean) eases toward 1 while drafting and 0 otherwise, each in **0.4 s (< 0.5 s)**. Physics consumes it in `grounded_step` as an **overspeed allowance**: the base ceiling becomes `MAX_SPEED·(1 + DRAFT_SPEED_MULT·draft)` (+13 % at full draft), with boost still multiplying on top, so the existing `OVERSPEED_DECAY` bleeds the extra off smoothly when the tuck breaks. **Two key subtleties:** (1) the draft pass runs at the **end** of `combat.step` (after the collision resolve), so it sees this tick's authoritative positions and feeds **next** tick's `step_all` — a deliberate one-substep latency, exactly like `places`, that avoids a second broadphase. (2) Broadphase **reuses the M5 grid** via a new `SpatialGrid::for_each_within(x,z,radius,…)` (a `(2r+1)²` window, `r = ceil(radius/cell_size)`) because the 14 m draft reach exceeds one 10 m cell — same grid, same rebuild, just a wider read window; `for_each_near` (collision/projectiles) is untouched. Gated on `active` so it stays 0 through the countdown. Zero new per-tick allocation; measured substep delta **≈ +1.5 µs** (min-of-8 A/B). No HUD cue yet — the camera FOV juice already responds (it keys off `speed_ratio()`); an explicit "DRAFT" pop is **M9**.
- **Juice = hit-stop + trauma-shake, both off existing edges** (M9). **Hit-stop:** the `run_substeps` loop drains `FIXED_DT` *first*, then skips the substep while `hitstop > 0` — time passes, the sim holds, so the fixed clock catches up with **no drift** (the same "freeze without banking time" trick as pause). Triggered only by a **fresh player spin-out** (`!was_stunned && combat.stunned(0)` edge) so it's rare and punchy; `HITSTOP_SUBSTEPS = 3`. **Screen shake:** `combat.trauma` (a `pub f32` zeroed each `step`) accumulates **player-relative** rumble — nearby detonations (falloff over `SHAKE_RADIUS`, blasts > direct hits) and hard player bumps (reusing the existing `hard && (i==0||j==0)` gate) — so distant AI combat doesn't rattle the screen. `Game.shake` folds it in and decays (`SHAKE_DECAY = 3.0` ⇒ <0.4 s); skipped hit-stop substeps don't decay, so it shakes *through* the freeze. The camera offset (`shake²·SHAKE_MAX_OFFSET`, `gen_range` jitter) is **render-side only** — it never perturbs the sim. The HUD pops (SPUN-OUT pulse, position ▲/▼, FINAL-LAP flash) are likewise render-side, read from existing `combat`/`race` state.
- **Out-of-bounds respawn rides the ground query** (M9, `KartState::respawn_to_track`). Detection is a cheap test on the per-tick hint query (`g.height < OOB_MIN_HEIGHT` ‖ `g.lateral.abs() > OOB_MAX_LATERAL`) placed **before the wall clamp**, so a real excursion respawns cleanly instead of being yanked metres sideways (the clamp still handles small curb corrections). The recovery itself uses the **full** `track.ground_query` (O(n), but a rare path) for the genuinely-nearest frame regardless of hint staleness, then sets the kart upright on the centerline, facing along the track, drift/trick/boost cleared and speed scrubbed (`RESPAWN_SPEED_KEEP`). The teleport is hidden from the interpolated renderer by the `run_substeps` **prev-snap** guard. Note: the lateral threshold is mostly a backstop — the wall clamp keeps grounded karts on-road, so genuine OOB is almost always a *vertical* fall off a ramp/AoE.
- **Lap length is one build-time knob** (M9, `LAP_SCALE` in track_3d.rs). `new_closed` scales every anchor uniformly (currently **1.5×**), lengthening all three circuits ~50 % with zero hot-path cost; everything derived (LUT, ring mesh, boost pads, spawn grid, the collision-grid AABB) follows. Trade-off: curvature scales as `1/scale`, so **banking softens** ~⅓ — bump `BANK_FACTOR` later only if a smoke test says the corners read flat. The larger grid AABB adds ~+5 µs/substep (more empty cells cleared); if `LAP_SCALE` ever grows much further, scale the grid `cell_size` with the track.
- **Kart-vs-kart collision lives in combat, not physics** (M5, `resolve_kart_collisions`). It runs single-threaded at the end of `combat.step`, reusing the grid rebuilt for the projectile pass; overlaps resolve with mass-weighted, equal-and-opposite separation + impulse in the road's averaged tangent plane (so banked turns keep karts side-by-side, not stacked). **Key subtlety:** a grounded kart recomputes `velocity = forward * speed` every step, so a world-space velocity impulse would be wiped — `apply_bump` therefore maps the impulse's along-heading component into the scalar `speed` for grounded karts (lateral part is already delivered as the positional shove), and applies the full impulse only to airborne (free-body) karts. Per-class `mass` lives in `ClassSpec` (Juggernaut 1.6 → Stinger 0.7); no CCD is needed because max per-tick closing (~1.93 m) is far below the 2.8 m contact diameter.
- **Mesh lighting moved to the GPU** (M4): `MeshBuilder` used to bake Lambert into vertex color. It now stores the **model-space normal** in `Vertex.normal` (macroquad's `Vertex` has a usable `normal: Vec4`; the 3D pipeline binds it as the `normal` attribute) and **unlit albedo** in the color. The toon/crate shaders re-light. The track keeps its own baked-lit color and is only grain-modulated by the road shader.
- **Shader robustness:** `Shaders` fields are `Option<Material>`; a shader that fails to compile logs `[shaders] …` and **falls back to the default material** instead of panicking. macroquad auto-injects `Model`/`Projection`/`_Time` (vec4, `.x` = elapsed seconds) into every pipeline. Custom uniforms (`LightDir`, `CamPos`) are `Float4` to avoid any vec3 std140 packing risk.
- **Audio is feature-gated + synthesized to WAV** (M4 added shaders; M7 adds sound): macroquad's `audio` feature is **off by default** (`default = []`), so `Cargo.toml` must request `features = ["audio"]` — otherwise every `macroquad::audio::*` call is a silent no-op stub (this bit is easy to miss). `load_sound_from_bytes` decodes via audrey/**hound**, so `audio::synth` builds raw f32 PCM, wraps it in a canonical 16-bit mono **WAV** in-memory, and loads that — no asset files, no per-frame allocation (all synth at startup).
- **Engine "pitch" is faked by crossfading** (M7): `PlaySoundParams` exposes only `{ looped, volume }` — **there is no pitch/playback-rate control** in macroquad 0.4.14. So the engine is `N_ENGINE_BANDS = 8` pre-baked looped tones over 60→320 Hz; `AudioBank::update_engine` equal-power-crossfades the two bracketing bands by `speed_ratio()` each frame. Loops are clickless because each band holds an **integer number of fundamental cycles** (frequency back-solved to fit the buffer length); the noisy drift loop instead uses an **overlap-add** tail fold. Noise is a **seeded** xorshift so the synth is deterministic (testable).
- **Audio events never cross a `par_iter`** (invariant #3): every `events.push(..)` happens in a single-threaded phase — flow logic in `Game::update`, the post-`step_all` diffs in `run_substeps`, and combat's single-threaded `handle_firing`/`apply_hits`/`handle_pickups`/`resolve_kart_collisions`. Bumps are sounded only when **kart 0 is in the pair** and pickups only for **kart 0** (no positional audio yet, so AI-on-AI events would just be noise). The 4 per-class fire timbres are all reachable because the player can pick any class.
- **Boost pads reuse the ground query — no new broadphase** (M8): a `BoostPad` is just `{u_center, u_half, half_width, frame}`; `track.boost_at(track_u, lateral)` is an O(pads) interval test in spline-parameter space against values the per-kart ground query already produced, so the check rides `step_all` with zero added spatial work and zero alloc. Pads grant a boost via the **existing `boost_time`**, so the camera FOV juice *and* the M7 boost SFX (the `run_substeps` boost-edge diff) fire automatically — no new plumbing. Detection and the visual footprint are centered strips (`PAD_HALF_WIDTH < ROAD_HALF_WIDTH`), so hugging the curb misses.
- **Alternate tracks must be star-convex / non-self-intersecting in XZ** (M8): the lock-free collision hash is 2D (XZ), which assumes the loop never overlaps itself vertically. New circuits (`speedway`, `serpentine`) keep anchors at monotonically increasing angle around the origin (radius may vary) so the Catmull-Rom loop stays simple. A figure-eight would break the hash — don't add one without making the grid 3D first.
- **Track switching rebuilds, via `track_dirty`** (M8): `Game` owns the sim-side `TrackSpline` (+ its pads) and rebuilds `Combat`/race/grid on a track commit (a transition — allocation is fine there); the **GPU** road meshes live in `main`, which watches `game.track_dirty` and regenerates them once per change. `restart_race` (R) keeps the same track, so it never sets the flag. The **M10 `Minimap`** outline rides the same `track_dirty` signal — rebuilt once per track change in `main`, never per frame.
- **Rubber-band lifts ceilings, never teleports positions** (M10): the catch-up is an *honest* boost — `physics::rubber_band(gap)` scales only a trailing **AI**'s effective driving skill (`compute_ai_inputs`, folded in as an additive lift so it can't push skill past 1) and its drift-farm `effective_aggression` (`combat::plan_ai`). It never touches the player (slot 0 is overwritten with real input right after the AI pass) and never edits standings — a back-marker just corners a touch sharper and farms more mini-turbos, so every position is still earned (the "honest, no rigging" house rule). Gap is measured in **rank-key units** (1.0 = one lap), so it's track-length-independent and free of any arc-length lookup. `gaps_into` is filled every substep (like `places`) into a `Game.gaps` parallel array — `KartState` stays lean (invariant #4). The factor is read twice/AI kart (once for skill, once for aggression); recomputing the divide rather than caching a factor array keeps it a pure, single-source function.

---

## Test inventory (47)

- `track_3d`: spline wrap, length, frame orthonormality, ground query, even arc-length sampling; **M8**: all 3 circuits are valid orthonormal closed loops with ≥4 pads, boost-pad footprint is localized (on-pad vs off-strip vs between-pads).
- `physics`: throttle accel, drift→blue→boost, airborne gravity, trick-on-landing boost, fixed-size particle pool; **M8**: a boost pad grants a boost when driven over (centered) but not when missed (off-strip); **M9**: a kart flung 50 m off the road recovers onto the circuit within 1 s, upright, speed scrubbed; **M10**: `rubber_band` is strictly monotonic in gap and stays in `[1, 1+RUBBER_BAND_MAX]` (leader gets 1.0, far gap approaches but never exceeds the cap).
- `mesh_gen`: box geometry counts, kart mesh index range, glyph, HSV primaries.
- `race`: sequential lap counting, sector-skip rejected, reverse-cross rejected, standings order, countdown→release.
- `combat`: spatial-grid neighborhood, class specs distinct, intercept-leading, aggression curve, **end-to-end fire→hash→spinout**; **M5**: mass ordering, overlapping karts separate without jitter, heavier class displaces lighter more, no tunneling at top speed; **M5.1**: draft ramps to full in <0.5 s when tucked in & decays in <0.5 s when broken (leader never drafts), no draft outside the cone/range (beside / too far / too close / ahead), a full draft gains ≥3 m over 5 s on the line; **M10**: `effective_aggression` lifts a trailing kart above the same kart in the lead, is monotonic in gap for a fixed place, and never boosts the leader above bare `aggression`.
- `game` (**M6**): full flow cycle Menu→ClassSelect→TrackSelect→Race→Results→Menu drives headlessly; selected class propagates to `combat.karts[0]` for all 4 classes; pause runs 0 substeps and freezes kart positions, resume ticks again. **M8**: each track selection builds a distinct valid circuit (>100 m, ≥4 pads) and flags the meshes stale. **M9**: hit-stop skips exactly N substeps then resumes with the fixed clock caught up (no drift); screen shake stays ≤ `SHAKE_MAX` and decays to ~0 within 0.4 s.
- `audio` (**M7**): every one-shot is non-empty, finite, in `[-1,1]`, audibly non-silent, and exactly `n_samples(sfx_secs())` long; engine bands + drift loop are valid PCM, ascending in pitch, and **clickless** (wrap step ≤ max internal step); the WAV header declares matching RIFF/data lengths; `SfxQueue` caps at capacity (never grows/panics).

All tests are pure/headless — no window, GPU, **or audio device** (the audio tests
exercise only the `synth` submodule, never `AudioBank`). They cover the risk-prone
logic; the visual/shader/mixer layer is necessarily validated by running the app. One
**ignored** benchmark (`bench_sim_substep`) measures the per-tick sim cost (see below).

---

## Performance budget & benchmarks

The whole point of the fixed-timestep architecture is a predictable budget. Use
these as **regression gates** when adding systems (audio, more karts, hazards):

| Metric | Budget / baseline | How to measure |
|---|---|---|
| 60 Hz frame budget | **16,667 µs** total (sim + render + GPU) | the math (1e6 / 60) |
| Sim substep @ 8 karts | **~134–170 µs (≤1.0% of frame)** — baseline 141 (2026-06-20); M6 170 idle; M7 150; M8 134; M5.1 ≈ +1.5 µs; **M9 ≈ +5 µs total**; **M10 ≈ +0** (144.5 µs, 2026-07-08 — one O(n) gap scan + two `rubber_band` divides/AI kart, all sub-µs; the minimap is render-side, off the bench path). All well under the 500 µs gate | `bench_sim_substep` |
| Heap allocations / gameplay loop | **0** (invariant #2) | audit hot paths: no `Vec` growth / `Box` / `format!` |
| Headless test wall time | **< 1 s** | `cargo test` |
| Builds | **0 warnings**, debug + `--release` | `cargo build [--release]` |

The sim substep covers `compute_ai_inputs` + `plan_ai` + `step_all` + `combat.step`
(incl. kart collision) + particle integration — i.e. everything inside the
`while accumulator >= FIXED_DT` loop except `race.update` (negligible). At ~141 µs
it uses under 1% of one frame, so the budget is **render/GPU-bound, not sim-bound**;
new gameplay systems have ample room. **Regression rule:** a change that pushes the
substep past ~500 µs (3% of frame) or introduces any per-tick allocation needs
justification. Re-run the bench before/after large sim changes and record the delta.
**`plan.md` carries a per-milestone substep-delta budget table** (M7 audio ✅ ≈+0,
M8 tracks/pads ✅ ≈+0, M5.1 draft ✅ ≈+1.5 µs, **M9 juice + longer laps ✅ ≈+5 µs**, and
**M10 minimap/rubber-band ✅ ≈+0** all confirmed; next: M11 settings ≈+0, M12 ghost
<+10 µs) — worst-case total ~190 µs, still well under the 500 µs gate.

---

## Known tech debt / watch-list

- **M10 minimap look + rubber-band feel unverified.** Headless-tested (`rubber_band` monotonic+bounded, `effective_aggression` lifts a trailing kart) but the *look/feel* needs a `cargo run --release` pass: does the top-right radar read clearly (outline + dots, player distinct), and does the field close up believably without feeling rigged? Tune `RUBBER_BAND_GAP_HALF` (bite sooner) / `RUBBER_BAND_MAX` (ceiling) in `physics.rs`. **Edge:** `gaps_into` uses the overall max `rank_key` as the leader, so once an AI *finishes* (its `rank_key` jumps to ~10 000) every remaining kart briefly reads max catch-up — harmless (the factor clamps) and late-race, but note it if the tail suddenly surges after a finisher.
- **M9 juice + longer-lap feel unverified.** Headless-tested (respawn, hit-stop no-drift, shake bound/decay) but the *feel* — shake punch/decay, the hit-stop pause on a player spin-out, the SPUN-OUT/▲▼/FINAL-LAP HUD pops, and especially the **1.5× longer laps** (do the three circuits still drive well, and is the softened banking — ~⅔ of before — still satisfying, or should `BANK_FACTOR` rise?) — needs a `cargo run --release` pass. Now also has a draft visual hook (`combat.draft[0]`) if a HUD cue is wanted later.
- **Draft feel unverified (M5.1).** The slipstream is headless-tested (cone/range gating, ramp/decay timing, speed gain) but the *feel* — tuck-in tow strength, the FOV swell at raised top speed, draft→pad chaining — needs a `cargo run --release` pass. Only the implicit FOV juice signals it (no dedicated HUD cue).
- ~~No out-of-bounds respawn~~ ✅ **retired (M9):** a kart that leaves the circuit (vertical fall, or the lateral backstop) now respawns onto the nearest frame upright with scrubbed speed. Verify feel off the big hill / after a mortar AoE in the smoke test.
- **AI auto-fires** whenever a firing solution exists; cadence is reload-gated but there's no ammo conservation strategy beyond aggression.
- **`SpatialGrid` is `Vec<Vec<u16>>`** (per the original directive). Fine at this scale; if entity counts grow, a CSR (counts + flat index array) is more cache-friendly.
- **Three tracks (M8), no hazards yet.** CIRCUIT / SPEEDWAY / SERPENTINE via the
  `TRACK_ORDER` registry, each with 6 boost pads. Oil-slick/gate hazards are still backlog.
  New circuits must stay non-self-intersecting in XZ (the 2D collision hash relies on it).
- **Track/pad feel + track-select preview unverified (M8).** Driving feel of the three
  layouts, pad placement/visibility/catchability, the drift→pad chain, and the overhead
  track-select preview have only been validated headlessly — need a `cargo run --release` pass.
- **Audio mixing/playback unverified (M7).** Synth is unit-tested headlessly, but the
  actual mix — engine crossfade feel, per-class fire timbres, busyness of AI fire (all 8
  karts sound their cannons), `[`/`]` volume — needs a `cargo run --release` ear test on a
  real machine. **Enabling the `audio` feature makes macroquad open an audio device at
  startup**, so a machine with no audio endpoint may warn/fail to launch. Possible future
  tune: distance-attenuate AI fire/bumps (needs positional audio, not in 0.4.14's API).
- **Class-select feel/visuals unverified.** The full flow, the spinning class preview, the
  stat-bar panel, the pause overlay, and the per-state cameras have only been validated
  headlessly — they need a `cargo run --release` smoke test (no GPU window in the dev env).
