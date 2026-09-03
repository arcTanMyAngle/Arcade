# wii_kart — Forward Plan

The "Combat Grand Prix" pivot (**M1–M4**), **M5** (kart-to-kart collision), **M6**
(game-flow state machine), **M7** (procedural audio), **M8** (track variety + boost
pads), **M5.1** (slipstream/draft), **M9** (juice & recovery + longer laps), **M10**
(minimap + rubber-band AI) and **M11** (settings + race options) are all **done** — see
`handoff.md` for architecture and the completed-milestone log below. This plan now covers
the **Season 2 roadmap** — a multi-milestone pass over MK-style items, track obstacles,
graphics and game-feel (**M13 → M16**), tackled one milestone per working session (M12 ghost
replay is parked in backlog). Each entry lists scope, the files it touches, a **measurable
DoD**, and a **benchmark gate**. Preserve the five core invariants in `handoff.md` (60 Hz
fixed step, zero-alloc loop, rayon, lean `KartState`, procedural assets) in everything below.

## How "done" is judged (applies to every milestone)
- **Tests:** each milestone adds ≥1 headless test; `cargo test` stays green and **0 warnings**.
- **Perf gate:** sim substep stays **< 500 µs @ 8 karts** (baseline **141 µs**; M6 170 idle;
  M7 150; M8 134 µs; M5.1 draft ≈ +1.5 µs; **M9 juice + 1.5× laps ≈ +5 µs** → ~152 µs
  min-of-8; **M10 ≈ +0**, **M11 ≈ +0**, ≤1% of the 16,667 µs frame — see handoff *Performance
  budget*). Re-run `bench_sim_substep` before/after and record the delta. ⚠️ It's a *mean*, so
  compare an **A/B on the same machine state** (a stash-pop baseline), not against a stale
  absolute — readings drift ~1.7× with thermal/load. **0 new per-tick heap allocations.**
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
| ~~**M11 Settings**~~ ✅ | **≈ +0 µs** | config/UI only; field size is a `[..active_karts]` sub-slice of full-capacity buffers (0 new alloc), so fewer karts only *speeds up* the substep. A/B vs the stashed pre-M11 tree read identical minima |
| ~~**M13 Items (MK-style)**~~ ✅ | **within budget** (376.14 µs absolute @ 8 karts, 2.26% of frame — machine-state sensitive; hot-path item work is O(boxes×karts) and sub-µs when idle) | items ride the existing parallel projectile pass; 0 new alloc; star reuses `boost_time` |
| ~~**M14 Ramps + accel strips**~~ ✅ | **≈ +0 µs** (353.82 µs absolute @ 8 karts, 2.12% of frame — ramps/strips ride the ground query like boost pads; budget < +5) | launch reuses the airborne+trick machinery; accel strip is a longer `boost_time` |
| **M15 Graphics & FX** | **≈ +0 µs** | render-side only (sky/ground/item glow/speed lines); sim untouched; MSAA 4x unchanged |
| **M16 Mechanics & feel** | **≈ +0 µs** | pure tunables + camera/HUD; needs a full `cargo run --release` feel pass |
| *(parked)* **M12 Ghost replay** | < +10 µs | one pose write/substep into a pre-sized ring; playback render-side |
| **Running total** | must keep substep **< 500 µs** | currently ~134 µs → well under the gate even after M13–M16, ample headroom |

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

### M11 — Settings screen + race options ✅ **DONE (2026-07-08)**
Shipped to spec. A new `Settings` `GameState` reached from a two-item Menu (START / SETTINGS,
new `FrameInput.nav_v` Up/Down cursor) holds **master volume, field size (`active_karts`),
lap count, default track, FOV** in a `Settings` struct on `Game` — edited in place
(`adjust_setting`, per-row clamps), persisted for the session, applied at `start_race`. **Field
size is a `[..active_karts]` sub-slice** of the full-capacity (`NUM_KARTS`) buffers across every
per-tick pass (`compute_ai_inputs`/`plan_ai`/`step_all`/`combat.step`/freeze-stun-particle
loops) — 0 new alloc, rayon over the slice, so a smaller field is *faster*; the parked tail is
never simulated/rendered/scored. Two enabling changes: `combat.step` rebuilds the grid from
`positions[..karts.len()]` (else a projectile could hit a stale parked kart), and
`RaceDirector::reset` `progress.resize`s to the field (within reserved capacity → no realloc);
`progress.len()` is then the field-size source of truth. `TOTAL_LAPS` const → `RaceDirector.laps`
field. Volume applies live (`main` mirrors `settings.master_volume` → `AudioBank::set_master`
each frame; `[`/`]` now edit that setting); FOV is the chase-cam base; `default_track` seeds
TrackSelect and is updated to whatever's actually raced. 4 headless tests (→ **51**): propagation
(lap target + field size, several combos), Menu↔Settings reachability + persistence, per-row
clamps, and parked-kart correctness across a re-race. Substep **≈ +0 µs** (A/B vs the stashed
pre-M11 tree, identical minima on the same machine state). **Settings screen look/feel — small
field & short/long laps, FOV extremes, volume-bar tracking — needs a `cargo run --release` pass.**

---

### M12 — Best-lap ghost replay  *(parked — backlog, not part of Season 2)*
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

### M13 — Item pickup system (Mario-Kart-Wii-style items) ✅ **DONE (2026-09-03)**
**Why:** the Combat Grand Prix loop currently gives every chassis a fixed cannon fed by generic
ammo crates. The classic MK "?"-box roulette — mushroom / banana / shells / star — is the missing
skill-and-luck layer, and it's exactly what "pick up items like Mario Kart Wii" is asking for.
**Scope:** keep the class cannons as-is and add a parallel **item** layer:
- `ItemKind` enum (`Mushroom`, `Banana`, `GreenShell`, `RedShell`, `Star` + a `None` = empty slot)
  with `name()` / `color()` / `sfx()` helpers.
- `KartCombat` gains `held: ItemKind` and `star_time` — both in the existing per-kart parallel
  array, so `KartState` stays lean & `Copy` (invariant #4).
- **Item boxes** (`Vec<ItemBox>` on `Combat`, placed like boost pads/crates around the lap): a
  procedural glowing "?" box; driving through an available one rolls a seeded-RNG item (roulette)
  into that kart's `held` slot and starts the box's respawn cooldown.
- **Use:** a new edge-triggered player input (`E` / `LeftAlt`; the cannon stays on `Ctrl` / `F`)
  fires the held item; AI use items opportunistically (mushroom on straights, banana when chased,
  shells at the kart ahead, star defensively).
- **Item behavior** (all in the fixed step, reusing the existing projectile pool + spatial grid +
  `spinout` machinery): Mushroom → instant `boost_time`; Banana → dropped one-hit spinning hazard;
  GreenShell → straight, wall-bouncing shell; RedShell → homing shell at the nearest kart ahead;
  Star → `star_time` (temporary invincibility + speed, with a render-side glow).
- **HUD:** a bottom-right item-slot icon + MUSHROOM / STAR banners.
**Touches:** `combat.rs` (items, boxes, AI use, hazard integration), `physics.rs` (star speed
allowance), `game.rs` (edge clearing for the new input), `main.rs` (item key, box + shell/banana
rendering, HUD), `mesh_gen.rs` (item box + shell/banana meshes), `audio.rs` (item roll/use/star
SFX).

**DoD (measurable):**
- Headless tests: a box grants exactly one item from the roulette; mushroom/star apply their
  boost; banana/shell spin a victim out and disappear (banana is one-hit); red shell homes; star
  grants spinout immunity and expires; AI use items; `KartState` never carries item state.
- **Benchmark:** substep delta **< +20 µs** (items ride the existing parallel projectile pass; the
  pickup scan is O(karts×boxes) like the crate pass), **0 new per-tick alloc**.
- Builds 0 warnings; `cargo test` green (count grows).

---

### M14 — Track obstacles: launch ramps + acceleration strips ✅ **DONE (2026-09-03)**
Shipped to spec. **Ramps:** 3 full-width launch ramps per circuit raise the road surface via
`TrackSpline::surface_offset` (cosine ease to the lip, C1 at both ends) — the same offset feeds
both the road mesh (`push_ring`) and the physics ground query, so a kart climbs the lip and, past
it, becomes airborne; tricks cash the existing landing boost. **Accel strips:** 3 longer orange-red
strips per circuit detected by `accel_at` (same u-space interval test as `boost_at`), granting an
`ACCEL_STRIP_DUR = 1.4 s` boost (vs the pad's 0.9 s) via the same `boost_time` machinery. Ramps
read as a warm dirt tint on the raised rings; strips render as a distinct 4-chevron mesh in world
+ track preview. 4 new headless tests (**62 total**), 0 warnings, `bench_sim_substep` 353.82 µs
@ 8 karts (2.12% of frame — ≈ +0, well under the < +5 µs budget). **Ramp/strip feel needs a
`cargo run --release` pass.**
**Why:** the circuits are smooth Bézier surfaces with boost pads but no vertical/obstacle play.
Ramps give the existing airborne + trick + landing-boost machinery something to bite on (big,
earned speed), and stronger "acceleration" strips add the speed-run thrill.
**Scope:**
- `Ramp`: a procedural raised launch lip built into the road surface (mesh + physics). Driving up
  it becomes airborne; tricks cash the landing boost. Detection rides the ground query (like boost
  pads) — no new broadphase.
- `AccelStrip`: a longer, stronger boost strip (reuses `boost_time`, new duration + tint), distinct
  from the M8 pads.
- Placement per circuit in `TrackSpline` (each builder seeds its ramps + strips); the track-select
  preview + minimap optionally show them.
**Touches:** `track_3d.rs` (Ramp/AccelStrip data + placement + mesh), `physics.rs` (ramp launch +
accel-strip boost, both via the ground-query outputs), `mesh_gen.rs` or `track_3d` (ramp mesh),
`main.rs` (render ramps/strips), `game.rs` (nothing new — `track_dirty` already rebuilds).

**DoD (measurable):**
- Headless tests: a kart driving a ramp becomes airborne and can trick → landing boost; an accel
  strip grants a longer/stronger boost than a pad; both footprints are localized (off-footprint
  misses, like the M8 pad test).
- **Benchmark:** substep delta **< +5 µs**; 0 new per-tick alloc; 0 warnings.

---

### M15 — Graphics & FX polish (Arc iGPU-safe)
**Why:** the low-poly look can be lifted substantially with pure procedural rendering — no texture
files, no post-processing stack, MSAA 4x untouched — staying well within the Intel Arc iGPU budget.
**Scope:**
- Sky: vertical gradient + sun glow (procedural).
- Ground/road: subtle checker/noise + a finish-line stripe.
- Item boxes + ramps/accel strips get their own pulsing/glow materials (reuse the M4 `crate_pulse`
  fallback pattern).
- Speed FX: boost/speed lines at high speed, star sparkle trail, brighter drift sparks.
**Touches:** `main.rs` (sky/ground/FX draw), `shaders.rs` (optional subtle glow material),
`mesh_gen.rs` (FX sprites / item-box mesh).

**DoD (measurable):**
- All changes are render-side → substep **≈ +0 µs**, 0 new per-tick alloc, 0 warnings.
- **Feel:** needs a `cargo run --release` pass (call out — no GPU window in the dev env).

---

### M16 — Mechanics & player-feel pass
**Why:** after items + ramps land, tune the driving loop end-to-end so acceleration, drift →
mini-turbo, boost decay, camera juice and HUD readability all feel cohesive (the "fun and smooth"
bar).
**Scope:**
- Tunables pass in `physics.rs` (accel/brake curve, drift charge + mini-turbo timings, boost decay,
  star/draft ceilings).
- Camera + HUD in `main.rs` (FOV swell, item/boost readouts, position arrows).
- Balance in `combat.rs` / `game.rs`: AI skill curve, item frequency, star duration.
**Touches:** `physics.rs`, `main.rs`, `combat.rs`, `game.rs` (mostly constants + small code).

**DoD (measurable):**
- Headless tests where numeric (accel monotonicity, drift charge timings, boost durations).
- Substep **≈ +0 µs** (pure tunables); 0 new alloc; 0 warnings.
- **Feel:** a full `cargo run --release` session (call out).

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
Season 2 build order: **M13 → M14 → M15 → M16** — items first (the marquee feature and the most
new tech), then ramps/accel to give items and tricks something to play off, then the graphics/FX
pass, finally the mechanics/feel tuning once everything else is in. Each is a self-contained
working session: it lands on a green `cargo test` + 0-warning build with its own benchmark delta
recorded. **Recommended next: M15 — then a batched `cargo run --release` verification session once
M13–M16 are all landed.** M12 ghost replay is parked (see Backlog).

**Pending human verification (one `cargo run --release` pass — no GPU/audio in the dev env):**
- **M11 settings** — the two-item menu + Settings panel; does a **small field** (2–3 karts) and a
  **short/long lap count** race well; do the **FOV** extremes read good; does the volume bar track
  what you hear; do `[`/`]` and the screen agree? Knobs: `MIN_KARTS`/`MAX_LAPS`/`FOV_MIN`/`FOV_MAX`.
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
- **M14 — Track obstacles: launch ramps + acceleration strips** ✅ (2026-09-03): 3 full-width
  launch ramps + 3 acceleration strips per circuit. Ramps raise the road surface via
  `TrackSpline::surface_offset` (cosine ease to the lip), feeding **both** the road mesh and the
  ground query — a kart climbs the lip and, past it, becomes airborne; tricks cash the existing
  landing boost. Accel strips are detected by `accel_at` (same u-space interval test as
  `boost_at`) and grant a 1.4 s boost (vs the 0.9 s pad) via the same `boost_time`; rendered as a
  distinct 4-chevron orange-red mesh (world + track preview). 4 new headless tests (**62 total**),
  0 warnings, `bench_sim_substep` 353.82 µs @ 8 karts (2.12% of frame, ≈ +0). **Ramp/strip feel
  needs a `cargo run --release` pass.** Next-up: **M15**.
- **M13 — Item pickup system (Mario-Kart-Wii-style items)** ✅ (2026-09-03): MK-style items added
  parallel to the class cannons. New `ItemKind` (Mushroom/Banana/GreenShell/RedShell/Star/None) with
  a deterministic xorshift roulette (`roll_item`); `KartCombat` gains `held` + `star_time` (parallel
  array — `KartState` stays lean); 8 `ItemBox` "?" cubes placed around each lap (offset from the ammo
  crates), granting an item on drive-through when the slot is empty. Player fires the held item on a
  new edge-triggered `E`/`LeftAlt` (`Input.use_item`, cleared after the first substep); AI use items
  opportunistically (mushroom on straights, banana when chased, shells at a kart ahead, star when
  threatened). Behaviors: mushroom → `boost_time`; banana → one-hit dropped hazard; green shell →
  straight wall-bouncing shell; red shell → homing shell; star → `star_time` invincibility (spinouts
  blocked via a bool-returning `spinout`) + a long `boost_time` surge. Shells/banana ride the existing
  parallel projectile pass (new `ProjKind` variants + `shell_ride` helper); item state never touches
  `KartState`. 3 new SFX (ItemRoll/ItemLaunch/Star), textured "?" box + banana/shell meshes, HUD item
  slot + STAR banner, render-side star glow. 5 headless tests (**58 total**), build 0 warnings,
  `bench_sim_substep` 376.14 µs @ 8 karts (2.26% of frame; machine-state sensitive, well under the
  500 µs gate). **Items feel/balance + the star glow need a `cargo run --release` pass.** Next-up: **M14**.
- **M11 — Settings screen + race options** ✅ (2026-07-08): session config, applied at race start.
  New `Settings` `GameState` off a two-item Menu (START/SETTINGS, `FrameInput.nav_v` Up/Down);
  a `Settings` `Copy` struct on `Game` (`master_volume`/`active_karts`/`lap_count`/`default_track`/
  `fov`) edited via `adjust_setting` (per-row clamps), persisted for the session. **Field size is a
  `[..active_karts]` sub-slice** of the full-`NUM_KARTS` buffers on every per-tick pass (0 new alloc,
  rayon over the slice → fewer karts is faster; parked tail never sim/rendered/scored); enabled by
  `combat.step` gridding `positions[..karts.len()]` and `RaceDirector::reset` `progress.resize`ing to
  the field (within reserved capacity). `TOTAL_LAPS` const → `RaceDirector.laps` field. Volume applies
  live (`AudioBank::set_master` each frame; `[`/`]` edit the setting); FOV is the chase-cam base;
  `default_track` seeds/absorbs the TrackSelect pick. 4 headless tests (**51 total**: propagation,
  reachability+persistence, clamps, parked-kart-out + re-race), substep **≈ +0 µs** (A/B same-state),
  0 new alloc. **Settings look/feel needs a `cargo run --release` pass.** Next-up: **M13** (Season 2 items).
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
