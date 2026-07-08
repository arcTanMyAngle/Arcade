# wii_kart — Forward Plan

The "Combat Grand Prix" pivot (**M1–M4**), **M5** (kart-to-kart collision), **M6**
(game-flow state machine), **M7** (procedural audio), **M8** (track variety + boost
pads), **M5.1** (slipstream/draft), **M9** (juice & recovery + longer laps) and **M10**
(minimap + rubber-band AI) are all **done** — see `handoff.md` for architecture and the
completed-milestone log below. This plan covers the **remaining two milestones** (M11, M12),
ordered by impact. Each lists scope, the files it touches, a **measurable DoD**, and a
**benchmark gate**. Preserve the five core invariants in `handoff.md` (60 Hz fixed step,
zero-alloc loop, rayon, lean `KartState`, procedural assets) in everything below.

## How "done" is judged (applies to every milestone)
- **Tests:** each milestone adds ≥1 headless test; `cargo test` stays green and **0 warnings**.
- **Perf gate:** sim substep stays **< 500 µs @ 8 karts** (baseline **141 µs**; M6 170 idle;
  M7 150; M8 134 µs; M5.1 draft ≈ +1.5 µs; **M9 juice + 1.5× laps ≈ +5 µs** → ~152 µs
  min-of-8, ≤1% of the 16,667 µs frame — see handoff *Performance budget*). Re-run
  `bench_sim_substep` before/after and record the delta. **0 new per-tick heap allocations.**
- **Builds:** `cargo build` and `cargo build --release` clean.
- **Feel:** anything visual/audio needs a `cargo run --release` smoke test (call it out —
  no GPU window in the dev env).

Numeric targets are starting tunables, not laws — but ship with them measured and recorded.

### Benchmark targets for the remaining milestones
| Milestone | Substep delta budget | Other hard gates |
|---|---|---|
| ~~**M5.1 Draft**~~ ✅ | **≈ +1.5 µs** (budget < +20) | reused the grid (`for_each_within`) + a parallel `f32` array, 0 new alloc |
| ~~**M9 Juice/Recovery**~~ ✅ | **≈ +5 µs** (budget < +15) | respawn rides the ground query; shake/feedback render-side; hit-stop = substep skip; +5 µs is the bigger grid from `LAP_SCALE` |
| ~~**M10 Minimap/Rubber-band**~~ ✅ | **≈ +0 µs** (budget < +10) | one O(n) gap scan + two `rubber_band` divides/AI kart (sub-µs); the minimap is render-side. Substep **144.5 µs** (within noise of the M9 152) |
| **M11 Settings** | **≈ +0 µs** | config/UI only (fewer karts only *speeds up* the substep) |
| **M12 Ghost replay** | **< +10 µs** | one pose write/substep into a pre-sized ring; playback render-side |
| **Running total** | must keep substep **< 500 µs** | currently ~134 µs → ~190 µs worst case, ample headroom |

---

## Priority milestones

### M5.1 — Slipstream / draft ✅ **DONE (2026-06-21)**
Shipped exactly to spec — a +13 % overspeed allowance (`DRAFT_SPEED_MULT`) when a kart
is tucked **4–14 m, within a ±12° rear-wake cone** directly behind a leader (headings
agreeing within ~60°). `Combat.draft: Vec<f32>` ramps to full / decays to zero each in
**0.4 s**; broadphase reuses the M5 grid via the new `SpatialGrid::for_each_within`
(14 m reach > one 10 m cell), fed into `physics::step_all` as a parallel `&[f32]` (one-tick
latency, like `places`). 3 headless tests (→ **42**), substep **≈ +1.5 µs** (min-of-8 A/B,
0 new alloc). No HUD cue (the FOV juice responds for free; explicit pop is **M9**). See the
completed-milestone log + `handoff.md` *Non-obvious decisions*. **Draft *feel* needs a
`cargo run --release` pass.**

---

### M9 — Juice & recovery (+ longer laps) ✅ **DONE (2026-06-21)**
Shipped to spec. **Hit-stop:** the `run_substeps` loop drains `FIXED_DT` then skips while
`hitstop > 0` (time passes, sim holds → no drift); triggered by a fresh **player spin-out**
edge (`HITSTOP_SUBSTEPS = 3`). **Screen shake:** `Combat.trauma` (player-relative — nearby
detonations + hard player bumps) → decaying `Game.shake` (→0 in <0.4 s) → a render-side
`shake²` camera jitter. **OOB respawn:** `KartState::respawn_to_track` recovers a kart that
leaves the circuit to the nearest frame upright with scrubbed speed (detection before the
wall clamp; teleport hidden by a `run_substeps` prev-snap). **HUD:** SPUN-OUT pulse,
position ▲/▼, FINAL-LAP flash (all render-side). **Longer laps:** `LAP_SCALE = 1.5` in
`track_3d::new_closed`. 3 headless tests (→ **45**), substep **≈ +5 µs** (the bigger grid;
M9 logic sub-µs). Retired the OOB tech-debt item. **Feel + the longer laps/softened banking
need a `cargo run --release` pass.** See the completed-milestone log + `handoff.md`.

---

### M10 — Minimap / radar + rubber-band AI ✅ **DONE (2026-07-08)**
Shipped to spec. **Minimap** (`main.rs`, render-side): a `Minimap` struct samples the live
circuit centerline once into world-XZ points (rebuilt on `track_dirty`, like the road meshes),
`project`s them + every kart's live position into a top-right panel with a uniform, undistorted
fit — AI dots muted gold, the player a ringed bright green. **Rubber-band** (`physics::rubber_band`,
pure + testable): `1 + RUBBER_BAND_MAX·g/(g+GAP_HALF)` — a bounded, strictly-increasing function of
the gap-behind-leader (`RUBBER_BAND_MAX = 0.25`, `GAP_HALF = 0.4` rank-key units), 1.0 for the
leader. `RaceDirector::gaps_into` fills a per-kart gap array each substep (like `places`);
`compute_ai_inputs` folds the factor into effective skill (better cornering) and `combat::plan_ai`
into `effective_aggression` (harder drift-farming). Player untouched — only AI ceilings lift, no
teleporting. 2 headless tests (→ **47**): `rubber_band` monotonic + bounded, and a trailing AI
out-commits the same AI in the lead. Substep **144.5 µs** (≈ +0 vs M9). **Minimap look + rubber-band
feel need a `cargo run --release` pass** (dev env has no GPU): does the radar read clearly, and does
the field close up without feeling rigged? `GAP_HALF`/`RUBBER_BAND_MAX` are the tuning knobs.

---

### M11 — Settings screen + race options
**Why:** the M6/M8 flow now has menus but nothing is configurable; the ad-hoc `[`/`]` volume
keys want a real home. Leverages the existing front-end.
**Scope:** a `Settings` `GameState` reachable from the Menu holding **master volume, AI field
size, lap count, default track, FOV**, persisted in a `Settings` struct on `Game` for the
session and applied at race start. Buffers stay sized to `MAX_KARTS = 8`; an `active_karts ≤ 8`
field drives how many race (no per-frame realloc). `TOTAL_LAPS` becomes a settable race target.
**Touches:** `game.rs` (`Settings` struct, `Settings` state, `active_karts`, lap target),
`race.rs` (lap target as a field, not a const), `main.rs` (settings screen + apply volume),
`audio.rs` (master volume set from settings).

**DoD (measurable):**
- Settings reachable from the Menu and back; volume / laps / AI-count / track **persist across
  races within a session**.
- A started race **honors the chosen lap count and field size** (only `active_karts` race; the
  finish board reflects it).
- **Headless test:** settings propagate into a started race — `race` lap target == chosen,
  active racer count == chosen, for a couple of combinations.
- **Benchmark:** substep delta **≈ +0 µs** (config only; fewer karts is *faster*).

---

### M12 — Best-lap ghost replay  *(marquee flair)*
**Why:** a satisfying skill loop — race your own best lap. All the timing data exists; the
only new tech is a zero-alloc pose recorder.
**Scope:** record the player's per-substep pose into a **fixed-capacity ring** (sized for the
longest expected lap at 60 Hz) during a lap; on a new best lap, keep it; replay a **translucent
ghost kart** in sync on later laps/races. Best-lap *time* shown on the HUD/finish board.
**Touches:** `game.rs` (pose ring recorder, best-lap buffer + time, playback cursor; per-lap
split from `race`), `main.rs` (draw the translucent ghost), `race.rs` (expose per-lap split
times if needed).

**DoD (measurable):**
- The pose ring is **pre-allocated** (capacity ≥ a generous lap length) → **0 per-tick alloc**;
  overflow is handled (drop or clamp), never grows.
- The **best lap is captured and replayed in sync**; the ghost is visually translucent/distinct.
- Best-lap **time is displayed** and only updated when beaten.
- **Headless test:** recording a synthetic pose stream then replaying it reproduces the sampled
  poses within tolerance; a slower lap does **not** overwrite a faster stored one.
- **Benchmark:** substep delta **< +10 µs** (one pose write/substep; playback is render-side).

---

## Backlog (smaller, slot in anytime)
- **Defensive weapon use:** let the player aim/lob backward; AI already mines rear-ward.
- **Hazards:** oil slick / closing gate on the new tracks (the pad footprint plumbing generalizes).
- **More tracks:** the `TRACK_ORDER` registry + `new_closed` make adding circuits a few anchors.
- **Spatial grid → CSR** (counts + flat index array) only if entity counts grow.

## Tech debt to retire
- ~~**OOB respawn**~~ ✅ **done in M9** — a kart that leaves the circuit respawns onto the
  nearest frame upright with scrubbed speed.
- **AI ammo strategy:** conserve/burst logic beyond the current always-fire-when-solved.
- **AI fire is non-positional** — every kart's cannon sounds at full volume; add distance
  attenuation when/if positional audio is feasible (not in macroquad 0.4.14's API).
- Extract shared constants (kart radius, light dir) duplicated across `physics`/`combat`/`shaders`.

## Open design questions (decide before building)
1. **Spinout vs. health:** keep binary spin-out, or a shield/health model so classes differ in
   durability? (Interacts with M5 mass.) Affects M9's feedback design.
2. **Catch-up philosophy:** rubber-banding aggressiveness — none / mild / MK-style? Sets the
   `RUBBER_BAND_MAX` in M10 and interacts with the M5.1 draft.
3. **Local multiplayer / split-screen?** Large lift (camera, input, viewport). The M6 `Game`
   refactor + M11 `active_karts` make it *more* feasible, but it's still its own milestone.

---

## Recommended order + pending verification
Build order: **M10 → M11 → M12** (awareness/balance, then configurability, then the replay
flair). M5.1, M9, and **M10** are done. The remaining two fit comfortably under the 500 µs substep
gate (see the table above). **Recommended next: M11 (settings + race options).**

**Pending human verification (one `cargo run --release` pass — no GPU/audio in the dev env):**
- **M10 minimap + rubber-band** — does the radar read clearly (outline + dots, player distinct),
  and does the field close up believably without feeling rigged? Tune `GAP_HALF` (bite sooner) /
  `RUBBER_BAND_MAX` (ceiling) if the catch-up is too weak/strong.
- **M9 juice + longer laps** — shake punch/decay, the hit-stop pause on a player spin-out,
  the SPUN-OUT/▲▼/FINAL-LAP HUD pops, OOB respawn off the big hill / after a mortar AoE, and
  especially the **1.5× longer laps**: do the three circuits still drive well, and is the
  softened banking (~⅔ of before) satisfying or should `BANK_FACTOR` rise?
- **M5.1 draft feel** — does the slipstream tow read clearly when you tuck in (≤0.5 s
  build), does the FOV swell at the raised top speed, and does chaining a draft into a
  boost pad feel like a big run? (No HUD cue — only the implicit FOV juice.)
- **M8 track/pad feel** — the three circuits (CIRCUIT/SPEEDWAY/SERPENTINE) drive well and don't
  self-clip; the track-select overhead preview reads clearly; boost pads are visible, catchable,
  and the boost (with its M7 whoosh) feels good; chaining drift→pad is satisfying.
- **M7 audio mix** — engine note rising/falling with speed (clickless), drift screech, per-class
  fire timbres, explosion/pickup/bump, countdown 3-2-1-GO, lap chime, finish jingle, menu blips,
  `[`/`]` master volume. ⚠️ The `audio` feature opens an audio device at startup — a machine with
  no audio endpoint may warn/fail to launch.
- **M6 front-end feel** — full Menu→ClassSelect→TrackSelect→Race→Results→Menu loop, the spinning
  class preview + stat bars, the pause overlay, the per-state cameras.
- **M5 collision feel** — bump strength, start-line pile-up, side-by-side on a banked turn.

---

## Completed milestone log (reference — details in `handoff.md` + memory)
- **M10 — Minimap / radar + rubber-band AI** ✅ (2026-07-08): spatial awareness + catch-up.
  **Minimap** (`main.rs`): a `Minimap` struct samples the live circuit centerline once into
  world-XZ points (rebuilt on `track_dirty`), then `project`s outline + live kart positions into
  a top-right panel (uniform undistorted fit; AI gold, player ringed green). **Rubber-band**:
  new pure `physics::rubber_band(gap) = 1 + RUBBER_BAND_MAX·g/(g+GAP_HALF)` (bounded, strictly
  increasing, 1.0 for the leader; `MAX = 0.25`, `GAP_HALF = 0.4`). `RaceDirector::gaps_into`
  fills a per-kart gap array each substep (parallel array, like `places`); `compute_ai_inputs`
  folds it into effective driving skill and `combat::plan_ai` into a new `effective_aggression`
  (drift-farm harder the further you trail). Player untouched — only AI ceilings rise, no
  position teleporting. 2 headless tests (**47 total**: `rubber_band` monotonic+bounded, trailing
  AI out-commits the lead), substep **144.5 µs** (≈ +0 vs M9), 0 new per-tick alloc. **Minimap
  look + rubber-band feel need a `cargo run --release` pass.** Next-up: **M11**.
- **M9 — Juice & recovery (+ longer laps)** ✅ (2026-06-21): a game-feel pass plus the last
  tech-debt item. **Hit-stop** (`game.rs`): the `run_substeps` loop drains `FIXED_DT` then
  `continue`s while `hitstop > 0` — a whole-sim freeze that still advances the clock (no
  drift), fired by a fresh player spin-out edge (`HITSTOP_SUBSTEPS = 3`). **Screen shake**:
  `Combat.trauma` (`pub f32`, zeroed each `step`) gathers player-relative rumble from nearby
  detonations (falloff over `SHAKE_RADIUS`) and hard player bumps; `Game.shake` folds it in
  and decays (`SHAKE_DECAY = 3.0` ⇒ <0.4 s); `main` adds a `shake²` camera jitter
  (render-side, never perturbs the sim). **OOB respawn** (`physics.rs`): detection on the
  per-tick hint query (`g.height < OOB_MIN_HEIGHT` ‖ big lateral) *before* the wall clamp →
  `respawn_to_track` uses the full `ground_query` for the nearest frame, sets the kart
  upright, facing along the track, drift/trick/boost cleared, speed × `RESPAWN_SPEED_KEEP`;
  a `run_substeps` prev-snap (>30 m jump) hides the teleport from interpolation. **HUD**
  (`main.rs`, render-side): SPUN-OUT scale pulse, position-change ▲/▼, FINAL-LAP flash.
  **Longer laps**: `LAP_SCALE = 1.5` applied to every anchor in `new_closed` (~50 % longer,
  banking softens ~1/scale). 3 headless tests (**45 total**: OOB respawn, hit-stop exact-N +
  no-drift, shake bounded+decays), substep **≈ +5 µs** (min-of-8 A/B: 152.4 µs @1.5× vs
  147.0 @1.0× — the delta is the bigger collision-grid clear; M9 logic itself sub-µs), 0 new
  alloc. **Feel + the longer laps need a `cargo run` smoke test.** Next-up: **M10**.
- **M5.1 — Slipstream / draft** ✅ (2026-06-21): a kart drafts when tucked **4–14 m** behind
  a leader inside a **±12° rear-wake cone** (`dir·forward[lead] ≥ cos 12°`) with headings
  agreeing within ~60°. `combat.rs`: `Combat.draft: Vec<f32>` (parallel array — `KartState`
  stays lean), updated by a single-threaded `compute_draft` at the **end** of `combat.step`
  (sees post-collision positions, feeds **next** tick — one-substep latency, no second
  broadphase). Broadphase reuses the M5 grid via a new `SpatialGrid::for_each_within(x,z,radius)`
  ((2r+1)² window) because 14 m > one 10 m cell; `for_each_near` untouched. `physics.rs`:
  `DRAFT_SPEED_MULT = 0.13` raises the grounded ceiling to `MAX_SPEED·(1+0.13·draft)` (boost
  still ×on top); fed through a new `draft: &[f32]` arg on `step_all`/`KartState::step`. Factor
  ramps 0→1 / decays 1→0 each in **0.4 s**; gated on `active` (stays 0 in the countdown). 3
  headless tests (**42 total**: cone/range gating, ramp+decay timing, ≥3 m/5 s speed gain),
  substep **≈ +1.5 µs** (min-of-8 A/B; budget < +20), 0 new alloc. No HUD cue — FOV juice
  responds for free; explicit pop deferred to M9. **Draft feel needs a `cargo run` smoke test.**
- **M8 — Track variety + boost pads** ✅ (2026-06-20): 3 circuits (CIRCUIT/SPEEDWAY/SERPENTINE)
  via a `TRACK_ORDER` constructor registry, each built through `new_closed` (which now also
  places **6 boost pads/lap**). `BoostPad` detection is a pure interval test in spline-parameter
  space — reuses the kart's `track_u`/`lateral` from the ground query (**no new broadphase**);
  pads grant a 0.9 s boost via the existing `boost_time` (so camera juice + the M7 boost SFX
  fire for free) and render with the `crate_pulse` material. New `TrackSelect` flow state
  (overhead preview + length/pad readout); `Game.track_dirty` tells `main` to rebuild the GPU
  road meshes on a track change. 4 new tests (**39 total**), substep **134 µs** (≈ no delta).
  **Track/pad feel needs a `cargo run` smoke test.**
- **M7 — Procedural audio** ✅ (new `src/audio.rs`): pure `synth` submodule (deterministic DSP +
  16-bit-mono WAV encoder + 16 one-shots, 8 engine bands, 1 drift loop), headless-tested;
  device-side `AudioBank` decodes the in-memory WAVs and mixes. Enabled macroquad's `audio`
  feature (off by default). No pitch API in 0.4.14 → engine "pitch" is an equal-power crossfade
  of 8 pre-baked 60→320 Hz loops by `speed_ratio()`; clickless loops. Events flow through a
  fixed-array zero-alloc `SfxQueue` (sink in `combat.step`; race cues diffed in `run_substeps`;
  flow cues in `update`); `main` drains it each frame. Substep 150 µs. **Mix needs an ear test.**
- **M1 Race Director**, **M2 Combat Core**, **M3 Combat AI**, **M4 Shaders** — the Combat Grand
  Prix pivot; playtested in-window on the Arc iGPU.
- **M5 — Kart-to-kart collision** ✅ (combat.rs): per-class `mass`, mass-weighted separation +
  tangent-plane impulse in `resolve_kart_collisions`, reuses the projectile grid, 0 alloc.
- **M6 — Game flow** ✅ (new `src/game.rs` + `main.rs` shell): `GameState` machine, `Game` owns
  the sim + the 60 Hz loop, value-type `FrameInput` → headless-testable; class-select commits to
  kart 0; Esc pause = 0 substeps.
