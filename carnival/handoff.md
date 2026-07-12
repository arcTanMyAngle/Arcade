# Uncanny Carnival — Handoff (session resume)

**What:** browser 3D carnival skill-suite. Three.js render, Vite build, one custom
deterministic physics kernel, procedural Web-Audio SFX, uncanny-valley PBR + clinical light.
6 games × 5 tiers. Zero RNG rigging.

**Where:** `Arcade/carnival/` (isolated — root `Arcade/` is the unrelated Rust kart game;
do **not** touch root `plan.md`/`handoff.md`/`src/*.rs`).

## Current status
- **Phase:** **M13 Anchor Smash BUILT — ◄ AWAITING PLAYTEST before M14.** High Striker deleted; ANCHOR SMASH is live.
  **59/59 tests**, clean **36-module** build, dev boots. L5 Basketball + L6 Skee-Ball still run through the legacy
  shim (migrate M14). M12/M12.5/M11 accepted by user.
- **M13 playtest focus:** (1) **ANCHOR SMASH** replaces the High Striker card (tag `RHYTHM · FLICK · IMPULSE`),
  cursor mode, 5 SMASHES. **CHARGE:** a metronome ticks; press the highlighted **A/S/D/F** glyph on its beat (lane
  bottom-centre) — on-beat presses spin the flywheel + pump the energy meter (right), off/wrong presses bleed it.
  **RELEASE:** after the last beat the hammer hoists; **drag down and flick** the mouse to slam. A *pure vertical*
  flick = **×3** alignment mult, a 45° flick = **×1** — confirm the mult (shown in the score pop) visibly ranges 1×–3×.
  Heavier slam (more energy + faster/cleaner flick) = bigger shockwave + camera kick + `slam`; mult ≥2.5 adds `crowd`.
  (2) **Both T1 (92 bpm, wide window) and T5 (132 bpm, 2-substep window) playable** — T5 is frame-tight by design
  (honest). (3) `?dev=1` F9 record → F10 replay on Anchor T1 ⇒ **identical score + frame hash** (the determinism cert:
  pattern seeds off tier only, scoring reads only `input.frame`, fx uses a decoupled seeded rng, camera kick render-only).
- **⚠ Playtest feedback to honor (2026-07-12):** user finds **ring toss + basketball don't hit the Wii-Sports feel bar.**
  basketball = still the old meter-and-click model (rebuild §6/M14). ring toss = M12 drag-flick is abstract (no ring to
  grab, **no trajectory preview**, split gesture). Fix for both = **pull-back-to-aim + a LIVE trajectory arc + a weighty
  throw into depth** (the approved §6 `dragToShot`+`tracePath` model). **Roadmap adjusted: M14 now also reworks RING TOSS
  onto that model** (see plan.md §7 M14 + Status). Chose to keep order, so this lands at M14, not now. (Also: the ring-toss
  render camera kick added in M12.5 sits on a fixed-camera precision booth — a candidate to trim/remove during the M14
  rework, or sooner if it's adding to the disorientation.)
- **Verified (M12.5):** `npm test` = **58/58 pass** (57 prior + new `ringSettle` early-classify test). `npm run build`
  clean (**36 modules** — `fx.js` is now a shared chunk, imported by all 3 booths). `npm run dev` boots ~325ms.
- **M12.5 playtest focus (the point of this pass):** (1) **bursts fire** on plate knockdown (big) vs a survived hit
  (small amber spark), balloon **pop**, and **ringer**; (2) **camera kick** reads on those impacts but stays subtle;
  (3) **ring toss resolves fast** — a made ring snaps to RINGER instantly, no 6 s idle; (4) **dart fishtail is visible**
  (cheap low-kA darts wag their nose) and rounds are shorter (18 darts); (5) **plinker hit-vs-knockdown is legible** —
  a hit that doesn't topple = amber spark + ping, a knockdown = burst + bell. **Judgment call to confirm:** ring toss
  `sleepN` went 20→16 (M12 raised it to 20 for wobble exposure) — trades a little wobble for pace; revert toward 20 if
  the settle feel is missed. Also confirm `?dev=1` F9/F10 on shooting-T1 ⇒ identical score + hash (proves juice is
  render-only).
- **Verified (M12):** `npm test` = **57/57 pass** (50 prior + new `shooting.test.mjs` 4 + dart +2 + ringtoss +1).
  `npm run build` clean (**35 modules**). `npm run dev` boots ~270ms. **Played well, user-approved.**
- **M12 playtest focus:** (1) **TARGET PLINKER**: RMB scope (58→30 FOV), hold **Space** to steady sway (breath
  meter drains), fire drops tin/iron/gong plates on **knockdown** — heavy/far plates need a high hit; z-lanes
  drift + wind at higher tiers; watch DEAD EYE (5 top-edge bulls) / IRONWORK (3 heavy knockdowns) toasts. (2)
  **BALLOON DART**: crosswind gust shows in HUD; dart visibly pitches over (φ) — cheap darts (low kA) fishtail
  and land tail-heavy; Space=breath, LMB=throw. (3) **RING TOSS**: cursor drag-flick — drag a ring and flick;
  neon **ribbon** shows the drag, flick sets speed+azimuth, drag steepness sets arc, **A/D** held pre-tilts the
  ring plane ±8°; near-miss rims **scrape**. Confirm tickets/best banner + trophy toasts fire on round end.
- **Verified (M11):** `npm test` = **50/50 pass**; `npm run build` clean (**35 modules**); `?dev=1` F9/F10
  record→replay holds by construction (see M11 notes). Playtest **passed**.
- **M11 playtest focus:** (1) all 6 booths still play EXACTLY as before (shim is zero-diff); (2) reload
  persists the TICKETS counter (top-left HUD); (3) `?dev=1` → F9 record a shooting-T1 round, F10 replay
  ⇒ identical final score + the frame hash printed to console. Then approve → M12.
- **Prior M10 polish (unchanged, still awaiting judgement):** Skee-ball rework, uncanny attendants,
  carnival decor, per-booth ambient/drone/murmur. Power→ring mapping verified headless (10→50→gutter, T1 & T5).
- **Playtest focus this round:**
  1. **Skee-ball** (the fix): view looks down the lane, **hold LMB to meter, release to roll**; a
     glowing **predicted-landing marker** shows where it'll drop as you charge — move the mouse for
     lateral, place the marker on a ring. Should now be playable/satisfying; back-corner 100s need
     near-max power + lateral. Confirm it's fun; tune `RINGS`/speeds if needed.
  2. **Attendants** (all booths): a procedural uncanny figure watches you, tracks the projectile,
     twitches/blinks, and reacts (cheer/nod/shake). Judge creepiness + whether reactions land. Tunables
     in `core/characters.js` (proportions, twitch/blink rates, reaction timing).
  3. **Decor + audio** (all booths): string-lights/bunting/poles bloom; each booth has its own muffled
     ambience + low drone. Judge "far more graphics/audio"; call out too-busy/too-quiet.
- **Known iteration targets:** attendant placement per booth (may clip scenery — positions are in each
  game's `makeAttendant({at:[…]})`); decor scale/position per booth (`carnivalDress({span,back})`);
  ambient mix levels (`audio.js` PROFILES + droneGain).
- **No booths left to build.** After this: balance tuning + optional cross-booth high-score meta.

## M11 Foundational Framework — as built (kinetic input layer + store + fx)
- **`core/kinetics.js` (NEW, PURE, imports nothing):** the deterministic gesture/input math. `K`/`KEYMAP`/
  `DPHASE` consts; `makeKin(cfg)` + `makeFrame()`; event sinks `kinPointer`/`kinButton`/`kinKey`/`kinReset`;
  per-substep fold `kinSnap(kin,frame)` (edges counted, deltas summed, flick baked to floats, then clears +
  advances RELEASE→IDLE and the SWALLOW=8 counter). Flick estimator `flickFromSamples` = windowed mean over
  trailing 100 ms of a 32-sample ring (span-clamped ≥8 ms). Drag FSM IDLE→PRESS→DRAG→RELEASE (dead 0.012 NDC;
  RMB/reset cancels). Gesture maps `dragToShot`(§6.1) + `flickToLaunch`(§4); `wristQ`/`beatAcc` timing kernel.
  Determinism I/O: `packFrame`/`unpackFrame` (24 floats, fixed field order) + `hashFrames` (FNV-1a→uint32).
- **`core/input.js` (REWRITE):** thin DOM adapter over a kin instance. NDC-normalizes coords vs a cached
  `getBoundingClientRect` (resize-refreshed); lock mode keeps the legacy yaw/pitch accumulator (sens, scope
  ×0.4, pitch clamp) AND feeds kinetics; cursor mode tracks clientX/Y + arms the drag machine. `snap()` folds
  → `st.frame` (double-buffered) and mirrors the lock accumulator into `frame.yaw/pitch/rmb`. `setMode('lock'|
  'cursor')` + pointerlockchange both `kinReset` (SWALLOW edge-suppress) + clear queues. **Legacy shim intact:**
  `fireQueue/pressQueue/releaseQueue/lmb/scope/yaw/pitch/keys` DOM-driven in live play; on **replay** they are
  reconstructed from the frame (`driveShim`) so the 6 old games replay identically. Dev hooks: `record(on)`,
  `startReplay(f64,n)`, `stopReplay`, `replaying`.
- **`core/store.js` (NEW, PURE, injectable backend):** versioned schema `uncanny-carnival` v1
  `{v,tickets,best,plays,totalPlays,trophies}`. `makeStore(backend|null→in-memory)` → `load/save/best/
  finishRun/reset` + `session{score,runs}` (never serialized). `finishRun` bumps plays → records best →
  `ticketsFor`(floor(score/100)·tier + newBest·floor(score/200)·tier) → evaluates the **17-trophy** table
  (`+25` flat each) → save → `{earned,newBest,prevBest,unlocked}`. `migrate()` never throws (junk/old-v →
  fresh defaults; clamps negatives). No `Date.now` — trophy order = play index.
- **`core/fx.js` (NEW, render-side, THREE as param):** `makeBurst` (one InstancedMesh of tetrahedra,
  ring-allocated, spawned only from the caller's seeded rng, gravity step, visual-only) + `makeTrajLine`
  (preallocated BufferGeometry + `setDrawRange`, positions written from a pure-sim flat buffer).
- **Wiring:** `engine.attachInput(input)` → loop step is now `input.snap(); active.step(dt)` (snap runs once
  per substep before the game reads `input.frame`). `hud` gains `tickets(n)`/`toast(title,sub)`/`ribbon(x0,y0,
  x1,y1|null)`/`rhythm(seq,idx,hot)` + `index.html` DOM/CSS (`#hTicketsRow`,`#toasts`,`#ribbon`,`#rhythm`).
  `main.js`: `makeStore(localStorage ?? null)`+`load()`, `ctx.store`, `end(title,body,result?)` wrapper
  (`finishRun`→ `NEW BEST/BEST · +N TICKETS` banner + trophy toasts; 2-arg legacy calls stay no-op),
  `setMode('cursor')` on menu / `'lock'` default entering a booth, `setHudActive`. **`?dev=1`** F9/F10
  harness: F9 restarts the booth fresh + records packed frames; F10 restarts fresh + replays the log,
  logging frame count + hash (booths seed off tier only ⇒ identical input ⇒ identical score).
- **Determinism model (load-bearing):** wall-clock (`e.timeStamp`) lives ONLY in kinetics' capture buffers;
  flick velocity is pre-computed into floats inside the RELEASE frame; games read only `input.frame`
  (or, for the 6 shimmed booths, shim fields that are a pure function of the same frame). Replay = frame log.
- **Tests:** `test/kinetics.test.mjs` (estimator math/windowing/span-clamp, FSM press/drag/click/release/
  RMB-cancel, snapshot fold, key bitmask, SWALLOW, pack/unpack, hash determinism, dragToShot/flickToLaunch
  clamp+monotone) + `test/store.test.mjs` (defaults, ticketsFor, finishRun best/tickets/trophies, migrate
  junk+valid, injectable + null backend). **Did NOT touch the 6 game files** (zero-diff via the shim).

## M12 Targeting & Throwing Suite — as built (first booths on the kinetic layer)
- **`core/physics.js` (+3 pure solvers, each tested):**
  - `hingeKick(J,h,m,H)` → `ω = J·h/(m·H²/3)` — bullet momentum J=mB·|v| at hit-height h drives a plate
    (rod, end-inertia m·H²/3) about its base hinge.
  - `hingeStep(st,m,H,damp,dt)` → bistable knock-down integrator. Below break-over `HINGE_TIP=0.45` a base
    detent (`HINGE_K=0.85`, α=−3K·θ/(m·H²)) rights the plate; past it gravity's `α=(3g/2H)·sinθ` topples it
    to π/2 (fallen/dead). Both terms are true angular accels (τ/I) ⇒ heavier/taller plates honestly resist.
    Returns `true` on fall. `st={th,om}`.
  - `aeroPitch(phi,thV,speed,kA,dt)` → `dφ/dt=kA·|v|·sin(θv−φ)` — dart long-axis rights toward velocity;
    small kA lags (fishtail).
- **`core/audio.js`:** added `scrape` voice (gritty band-passed noise down-glide, ~0.16s) for ring-on-peg grind.
- **L1 → TARGET PLINKER (`games/shooting.js`, full rework; lock mode):** reads only `input.frame`
  (`f.press` fires, `f.rmb` scopes 58→30, `f.keys&SPACE` holds breath). **Z-lanes** `[{z:-10,mul:1},{z:-16,mul:2},
  {z:-22,mul:3}]` — near=tin, mid=iron, far=gong (`TYPES{m,H,W,pts}`), 3 plates/lane, seeded per-lane lateral
  drift (`T.laneAmp/laneOmega[3]`) + seeded gust wind on the bullet. Score **on knockdown** (pts·lane.mul·streak),
  not ring value: a hit adds `hingeKick` torque, `hingeStep` topples over the next substeps or rocks back — heavy
  plates need a high hit (top-edge = `stats.bulls`, arm≥0.85). Space-breath damps a seeded Lissajous sway
  (`STEADY 0.9`, drain per tier). `BULLET_M=0.008`, `HINGE_DAMP=1.2`, `RESPAWN=0.9`. `stats:{bulls,heavies}`.
  `end(...,{score,stats})`. TIERS shape `{vMuzzle,k,wind,round,laneAmp[3],laneOmega[3],sway,drain}`.
- **L3 BALLOON DART (`games/dart.js`, extend; lock mode):** frame API (`f.rmb` scope 58→22, `f.keys&SPACE`
  breath, LMB press→release throws via `armed`). Seeded **crosswind** gust (independent `rngW` seed so balloon
  layout is unchanged) → `windDrag` + `hud.wind`. **Pitch-over:** each dart tracks `phi` via `aeroPitch` (per-tier
  `kA:6→2`); the **swept TIP** `p+L_TIP·dir(φ)` (`L_TIP=0.17`) does the popping (sweptPointSphere on the tip
  segment) and orients the mesh — lagging φ shifts the swept endpoint. `stats:{clusters}` (dart pops ≥2). windproof
  trophy is score/tier-driven. `end(...,{score,stats})`.
- **L4 RING TOSS (`games/ringtoss.js`, full rework; cursor mode):** `setMode('cursor')`, fixed board camera.
  Drag→`hud.ribbon` (NDC→px); on `f.dphase===RELEASE` → `flickToLaunch(flickVX,flickVY,{k:2.2,vMin:2.0,vMax:4.6,
  azK:0.6,azMax:0.35})` = speed+azimuth, elevation `θ=clamp(atan2(dragDY,|dragDX|),0.35,0.95)`, backspin ∝ v0
  (`SPIN=26`). **A/D** held → initial `q` axis-angle ±8° about z (edge-catch). `stepRing` **UNTOUCHED** (MAXV 4.6);
  game-side `P.sleepN` raised 12→20 for wobble exposure; `scrape` on `ev.slide`. `stats:{backPeg,maxStreak}`.
  `end(...,{score,stats})`.
- **`main.js`:** GAMES row `shooting` → `label:'TARGET PLINKER', tag:'RIFLE · LANES · TORQUE'`. (end-wrapper +
  store already wired at M11; the 3 games now pass the 3rd `result` arg so tickets/trophies fire.)
- **Tests:** new `test/shooting.test.mjs` (hingeKick math, hingeStep super/sub-threshold, tin-falls/iron-survives,
  seeded-gust+fire determinism) + dart `+2` (aeroPitch convergence, tip-lag endpoint shift) + ringtoss `+1`
  (flickToLaunch ring-cfg clamp/monotone). **57/57.** L2/L5/L6 untouched (shim), migrate M13/M14.

## M12.5 Polish & Pacing pass — as built (feel/juice on the 3 M12 booths; render-only)
Guiding rule: **every add is render-side or game-side resolve logic — no physics/scoring math touched**, so the
`?dev=1` replay hash + scores are unchanged by construction. `fx` bursts spawn from the booth's existing seeded `rng`
(consumed only in `step`, never in a scoring branch) and step in the booth's `step` ⇒ deterministic + visual-only.
- **`fx.makeBurst` wired into all 3 booths** (was built at M11, unused): `makeBurst(THREE,scene)` in `create`,
  `fx.step(dt)` in `step`, `fx.teardown()` in `teardown`. Now a shared build chunk (35→36 modules).
- **Render-only camera kick** — `kick` scalar bumped in `step` on knockdown/pop/ringer, decayed each step
  (`KICK_DECAY 4.5`); applied ONLY in `render()` as a small rotation wobble (`KICK_AMP 0.014`, `simTime` oscillation).
  Plinker/dart save the **clean base aim** (`camP0`/`camY0`, set in step before the fire/throw dir is read) and
  re-derive rotation from it each render (step overwrites it next tick); ring toss pivots off a stored base quaternion
  `camQ0` and **never touches `camera.position`** (its `toss()` reads it). ⇒ the kick can't leak into the sim.
- **L1 TARGET PLINKER** — `hitPlate` (survived hit): small **amber spark** (`fx.spawn(h,5,rng,1.6,0xffe08f)`) + `ping`;
  `knockdown`: bigger burst (`14`, green / magenta for a bull) + `ding`. Reads "hit but standing" vs a clean drop.
  `TIERS.round` trimmed ~15% (60/50/45/40/35 → 50/42/38/34/30). Torque/hitbox math untouched.
- **L3 BALLOON DART** — hand-rolled shard pool **deleted** → `fx.spawn(at,12,rng,2.4,…)` on pop (plan §3.3). `N_DARTS`
  25→18; low-tier `v` nudged (30/27/24 → 34/30/26; T4/T5 unchanged, arc-skill preserved). **Legible fishtail:** render
  pitches the mesh from `phiR = thV + (φ−thV)·FISHTAIL_GAIN` (1.9) — visual exaggeration only; the swept **tip / pop
  test still uses true φ**, so honesty is intact.
- **L4 RING TOSS** — new pure `physics.ringSettle(b,peg,Ri,pegH)` returns `'ringer'` the instant a ring is encircling +
  below the peg top + essentially stopped (total-speed gate), so a made throw resolves immediately instead of idling.
  Wired into the resolve `if` (alongside `b.rest`/off-board); hard timeout **6→3.5 s**; `P.sleepN` **20→16** (deliberate
  wobble-vs-pace balance call — M12 raised it to 20 for wobble exposure). `stepRing` **UNTOUCHED**. Ringer spawns a
  green burst + kick.
- **Tests:** `test/ringtoss.test.mjs` `+1` — `ringSettle` (captured⇒ringer; still-dropping / off-to-the-side /
  hovering-above ⇒ keep simulating). **58/58.** No other test changed (the pure solvers are all unchanged).

## M13 Kinetic Power Engine — as built (ANCHOR SMASH replaces High Striker)
- **DELETED:** `src/games/highstriker.js`, `test/highstriker.test.mjs`; `physics.railImpulse`/`railApex`;
  `PROFILES.highstriker`. Grep gate confirmed: `railImpulse|railApex` and `highstriker` both absent from `src/`+`test/`.
- **`core/physics.js`:** rail model → **`trackImpact(vf,E,mH,H,mu,g=9.81) = √(vf² + 2·(g(1−μ) + E/(mH·H))·H)`**
  + `export const H_TRACK = 3.2`. Driven-hammer energy balance: ½mH·vImp² = ½mH·vf² + mH·gH(1−μ) + E. Pure, tested.
- **`core/audio.js`:** +`tick` (2 ms dry band-passed click, metronome), +`slam` (sub-sine 55→28 Hz + hi-passed noise
  crack + 4-partial 1.2 s inharmonic anvil ring), +`crowd` (3 staggered band-passed noise swells, ~1.4 s rise).
  `PROFILES.highstriker`→**`anchor:[320,0.20,41]`**. `ambientProfile` now **ramps** via `setTargetAtTime(…,0.4)`
  (lp freq / bed gain / drone) instead of hard `.value` sets — applies to every booth, render-side (no determinism impact).
- **`core/main.js`:** GAMES row → `{id:'anchor', label:'ANCHOR SMASH', tag:'RHYTHM · FLICK · IMPULSE', load:()=>import('./games/anchor.js')}`.
  (`store.js` was already anchor-ready from M11: `GAMES` list + `anchor_resonant`/`anchor_chain` trophies.)
- **`games/anchor.js` (NEW, cursor mode, `N_SMASH=5`, zero RNG in outcome):**
  - **TIERS `[bpm,L,win,μ,mH,E_HIT]`:** `{92,6,6,0.02,10,120}` … `{132,10,2,0.06,14,100}`. `SPB=round(3600/bpm)`
    substeps/beat; beat `i` at charge-substep `i·SPB` (one beat of lead-in via `cn` starting at −SPB). `E_MAX=L·E_HIT`.
  - **CHARGE:** pattern of `L` A/S/D/F keys drawn from **`mulberry32(0xA7C4 ^ tier·2654435761)`** (`rngPat`). Steady
    `tick` metronome (independent of hits). Per beat: correct `keyPress` bit within ±`win` ⇒ `E += E_HIT·beatAcc(err,win)`
    + `clack`; wrong key / missed beat ⇒ `E *= 0.85`. Windows never overlap (`2·win`≤12 ≪ `SPB`≥27) so beats are cleanly
    separable; at the charge→release edge any un-pressed trailing beats are flushed as misses (fixes a last-beat boundary
    gap). `hud.rhythm(glyphs, bi, hot)` lane + `hud.striker`/`hud.charge(E/E_MAX)` energy meter (sweet band hidden via
    `hud.sweet(1)`). Flywheel disc spins ∝ E (visual).
  - **RELEASE:** 90-substep capture window, hammer hoisted to `TOP_Y=BASE+H_TRACK`. On the `dphase===RELEASE` frame with
    `flickVY < −0.4`: `align = 1 − clamp(|flickVX|/|flickVY|,0,1)`, `vf = 1.8·min(−flickVY, 3.5)`; no flick in the window ⇒
    limp drop (vf=0, align=0). `whoosh` on the drop.
  - **SLAM (visual):** hammer integrates the run with constant `a = g(1−μ)+E/(mH·H)` (the same closed form) from `vf`,
    landing at `vImp`. On land: `slam`, `fx` shockwave (`rngFx` = **decoupled** seed `0xA9C4^…` so play can't desync the
    pattern stream), power-scaled camera kick (render-only quaternion pivot off `camQ0`, ringtoss pattern), `crowd` if mult≥2.5.
  - **Scoring:** `VIMP_REF = trackImpact(1.8·3.5, E_MAX, mH, H_TRACK, μ)` at create; `power = min(vImp/VIMP_REF,1)`;
    `mult = 1 + 2·align²` (1×–3×); `pts = round(400·power²·mult)` (perfect play = 1200). Stats `{maxMult, crits (mult≥2.5
    count), fullChain (any attempt with every beat hit)}`.
- **Tests:** `test/anchor.test.mjs` (5) — trackImpact E=0 closed form, monotone in E+vf, alignment 3×/1×, rhythm energy
  (perfect chain = E_MAX exactly, miss = 0.85×), determinism (fixed beat-log + flick → identical score; perfect = 1200).
  Replicates the pure scoring pipeline on the shared `trackImpact`/`beatAcc` solvers (house style). **59/59 total.**
- **NOT touched:** L1/L3/L4 (M12.5-tuned), L5/L6 (shim). Camera kick / fx / flywheel are render/visual-only ⇒ replay hash holds.

## Polish pass — characters + decor + audio + skee-ball fix (as built)
- **`core/characters.js` — `makeAttendant(THREE, scene, {at,face,hue,kind,audio})`:** procedural uncanny
  humanoid from primitives (legs/torso/arms-on-pivots/oversized skewed head/glowing eyes/mouth; `barker`
  hat, `clown` nose+tufts). `update(t, watchPos)` = breathing + sway + head-track-or-idle-drift with
  sudden twitches + rare blink; `react('cheer'|'nod'|'shake')` = stiff applause(+murmur)/nod/head-shake.
  `teardown()` disposes. Time-driven (deterministic-ish, render-side). One per booth; each game calls
  `att.update(simTime, projectilePos|null)` and `att.react(...)` on score/miss, `att.teardown()`.
- **`core/decor.js` — `carnivalDress(THREE, scene, {theme,span,back,front})`:** two sagging bulb strings
  (emissive → bloom), pennant bunting, striped corner poles, top valance. Static group, one call/booth.
- **Audio (`core/audio.js`):** `ambientProfile(name)` retunes the muffled bed + a new **low dread drone**
  per booth (PROFILES table); new **`murmur`** attendant voice. `ambient(on)` also gates the drone.
- **All six games wired:** `carnivalDress(...)` + one `makeAttendant(...)` + `audio.ambientProfile(id)`
  in `create()`; `att.update`/`att.react`/`att.teardown` hooked to each booth's events.
- **Skee-ball rework (`games/skeeball.js`):** the previous build overshot every ring. Now: launch speed
  is **auto-tuned per tier** (binary search `findV` on the pure `rollFly` sim so MIN power lands at the
  front ring, MAX just past the back); **lateral-only aim** (fixed pitch, clamped yaw); a live
  **predicted-landing marker** (runs `rollFly` each frame for current power+lateral); rings moved to a
  reachable z-layout at one low aperture height so the descending arc drops through. Verified headless:
  clean 10→50→gutter sweep on T1 & T5. Same roll/lip/fly/rim-rattle physics as before.

## Level 6 Skee-Ball — as built (`games/skeeball.js`) — FINAL BOOTH
- **Roll → lip-launch → ring drop, all honest:** flat run then incline ramp; along-surface decel
  `a = μr·g` (flat) / `(g·sinθ + μr·g·cosθ)·cosθ` horizontal (ramp climb). At the lip crest the ball
  leaves the surface with the ramp's velocity (`vy = f·tanθ` + small lip kick) → projectile via
  `integrate`. **The parabola is the whole skill:** too slow stalls short (gutter), too fast overshoots.
- **Rings:** 7 apertures (10/20/30/40/50 up the lane + two back-corner 100s), radius × tier `sc`.
  Score = center sweeps down through an aperture inside `r−0.4·bR`; rims are `sphereTorus` +
  `resolveBallContact` so tight rings rattle out. Side rails reflect lateral (`eW`). Round = 9 balls.
- **Controls:** pointer-lock (yaw = lateral aim) + hold-LMB power meter (striker bar, `sweet(1)`) +
  release-to-roll. Reused voices: `whoosh` release, `thock` roll-rumble(throttled)+gutter, `clack`
  lip-tick/rail/rim-rattle, `thud` drop, `ding` 100-hole. No new audio voice needed.
- **State machine** (in the game, not physics.js): `ready → roll → fly → resolve`. `resolve()` calls
  `finish()` when the last ball settles. Tests replicate the roll/parabola formulas (like L2/L3 do).
- **Tunables:** `MINV/MAXV` (roll speed), `RINGS` layout/radii, `Z_FLAT_END/Z_LIP/RAIL`, tier table.

## Level 5 Basketball — as built (`games/basketball.js` + `physics.sphereTorus`/`resolveBallContact`)
- **New pure solvers in `physics.js`:** `sphereTorus(b,bR,{cx,cy,cz,Rr,Tr})` = ball vs horizontal
  rim (closest point on the rim centerline circle → normal; null through the hole). `resolveBallContact
  (ball,n,pen,e,mu)` = spin-aware solid-sphere contact (restitution + Coulomb friction using the
  surface velocity v+ω×rA, restitution slop near rest) → **backspin walks a rim clip toward center =
  "shooter's roll", emergent not rigged.** Reused for rim, backboard, floor. `cross` now exported.
- **Flight:** `integrate(G + windDrag(kB) + Magnus)`, Magnus accel = `T.cM·MAG·(ω×v)` (MAG=0.02 keeps
  it subtle). Slight spin decay. **Make** = center sweeps down through the rim plane with `hd < rimR−bR`
  (the tier window), `v.y<0`; **swish** if `!rimHit` else **make**; ball then falls through the net.
- **Controls:** pointer-lock aim (starts pitched up at the hoop) + hold-LMB power meter (reuses striker
  bar, `sweet(1)`) + release-to-shoot; backspin ω about the lateral ⟂-shot axis, ∝ power. Round = 10
  shots. New `swish` voice; rim = `ping`, bounce/bank = `thock`, release = `whoosh`.
- **Tunables:** `MINV/MAXV/SPIN/MAG`, `POWER_FR`, `RIM_MU/FLOOR_*`, tier table. Power→distance and
  backspin strength most likely to need feel tuning; rim `emissiveIntensity` for bloom.

## Shared graphics/atmosphere upgrade — as built ("better + scarier", all booths)
- **`engine.js`:** PBR env reflections (`PMREMGenerator.fromScene(RoomEnvironment)`, `scene.environment`,
  `environmentIntensity 0.32`) + a post stack via `EffectComposer`: `RenderPass → UnrealBloomPass
  (0.7/0.5/0.85) → GradePass(vignette·CA·grain, linear-space) → OutputPass(ACES+sRGB)`. Gated by
  `POST=true`; env + composer wrapped in try/catch (headless-safe). `render()` drives `composer.render()`
  + `updateAtmosphere()`. Resize updates composer/bloom/grade. `clearScene` now also disposes
  normal/roughness maps.
- **`materials.js`:** `clinicalLights` now sets `FogExp2(0x04060a,0.028)` + dark `background`, lowered
  ambient (0.28), shadow bias; registers flickering fluorescents. `updateAtmosphere()` (exported,
  called each render) gives the white key a dead-tube stutter + steady shimmer on a neon. New
  `normalTex()` (finite-difference of the noise height) → `mat.metal`/`mat.wood` get real surface
  relief (`normalScale` 0.75 / 0.5).
- Determinism unaffected — all post/atmosphere is render-side (uses `performance.now`, never step).

## Level 4 Ring Toss — as built (`games/ringtoss.js` + `physics.stepRing`)
- **The showcase solver, pure in `physics.js`:** `stepRing(ring,peg,board,P,dt)` models the ring as a
  rigid torus sampled into `nodes`(14) beads on its centerline; per micro-substep it gathers node
  contacts (peg shaft + top-rim circle via `pegContact`, board via `planeContact`), then a
  sequential-impulse solve (restitution + Coulomb friction, torque via world inverse-inertia of a
  torus) + one **averaged** positional correction. **Anti-tunnel:** `micro = clamp(ceil(|v|·dt/r),1,8)`
  so displacement < thickness. **Settle:** restitution slop (<0.25 m/s ⇒ e=0) + heavy wobble-bleed
  once the ring lies flat (nc≥N/2) + sleep latch. Quaternion helpers `qapply`/`qIntegrate`, `cross`
  now exported. Tested: no-tunnel, restitution (no energy gain), capture encircles, determinism.
- **Game:** pointer-lock aim (view starts pitched down at the board) + **hold LMB power meter**
  (reuses the L2 striker bar with `sweet(1)` = no band) + release-to-toss; faster power ⇒ more speed +
  more backspin (ω about the horizontal ⟂-throw axis). Ring thrown flat (axis +y) so it can drop over
  a peg. 5-peg board (farther = more pts), per-tier board tilt, seeded peg jitter. `nearestPeg` collides
  the active ring vs its closest peg (+ board always). Round = **8 rings**; classify on rest/off-board/
  timeout: ringer (encircling & low) / lean / miss. New `clack` voice (throttled), `whoosh` on toss.
- **Tunables for playtest:** `MINV/MAXV/SPIN` (throw), `PEGS` layout/points, `PEG_H`, `RING_M`,
  `P.sleep*`, tier table. Backspin benefit + power→distance mapping most likely to need feel tuning.

## Level 3 Balloon Dart — as built (`games/dart.js`)
- **Controls:** pointer-lock aim; **RMB** = scope (FOV 58→22 + vignette + braces sway ×0.7);
  **hold LMB** = "hold breath" → `steady` ramps up, damping Lissajous sway by ×(1−0.9·steady),
  drains the `breath` meter (empty ⇒ can't steady); **release LMB** = throw. Reuses `input.lmb/
  pressQueue/releaseQueue`. Guarded so the lock-engaging click can't auto-throw (throw needs a
  prior locked press → `holding`).
- **Dart physics (honest):** slow projectile, `a = G + windDrag(v,0,kD)` (quadratic drag), `integrate`.
  Arc drop scales with distance → hold-over/lead is the skill. Tip pop = `sweptPointSphere(prev,cur,
  balloonCenter,rB)` per substep (no body-overlap fudge). A dart can pop multiple spheres in one
  throw ⇒ **cluster** combo. Board (`z≤BOARD_Z`) or floor (`y≤0.05`) ⇒ resolve (miss if 0 pops).
- **Thin/partial hitbox:** exposure tiers (3:0.7, 4:0.5, 5:0.35) render a cutout plate over the left
  `(1−expo)` of each balloon; a hit is valid only if `hit.x−balloonX ≥ rB·(1−2·expo)` (exposed cap).
- **Determinism:** balloon jitter/colors/skew, sway phases, drift phases, shard spread all from one
  seeded `mulberry32(0xBA110^tier)`; sway/drift are pure fns of `simTime`; no `Math.random` in step.
- **Balloons** = one `InstancedMesh` (COLS6×ROWS4), egg-skewed, drift `x=bx+A·sin(ωt+φ)` (tiers≥2),
  respawn wave when cleared. Pooled darts (12) + pooled shards (80). Round = **25 darts**.
- **Scoring:** pop = `100·round(0.20/rB)·(1+streak·0.1)` (smaller balloon ⇒ ×bonus), streak++/reset
  on whiff; cluster = +150·(extra pops). New audio voices `whoosh`/`pop`/`breath`; HUD `mode('count')`
  + `count(label,n)` (generalized from L2 swings), `scope()`, `breathShow()`/`breath()`.
- **Deferred polish:** scope CA/lens-breathing (only a CSS vignette now); wrinkled-skin remnant on pop.

## Level 2 High Striker — DELETED at M13 (superseded by ANCHOR SMASH)
- The mallet/rail-impulse booth (`highstriker.js`, `railImpulse`/`railApex`) was **removed** at M13; see the
  **M13 Kinetic Power Engine — as built** section above for its replacement (rhythm-charge + vertical-flick anchor).
  Historical build notes live in the M5 changelog entries below. The shared `hud.striker/sweet/charge` meter + the
  `thud`/`ding` voices it introduced were **kept** (Anchor reuses the meter; other booths use the voices).

## Adding a game (pattern established by Level 1)
1. `games/<id>.js` exports `create(ctx)` → `{ step(dt), render(alpha), teardown() }`.
   `ctx = { THREE, scene, camera, renderer, input, audio, hud, store, tier, end(title,body,result?) }`.
   Kinetic booths: call `input.setMode('lock'|'cursor')` in `create()`, read **only** `input.frame` in `step()`
   (never the legacy shim), and pass `end(title, body, {score, stats})` so `finishRun` fires tickets/trophies.
2. Define `const TIERS=[…5 rows…]` (from that game's `level_*.md`); pick with `tier(TIERS,ctx.tier)`.
3. Reuse core: `physics.integrate/bounce/mulberry32/…`, `clinicalLights`+`mat.*`+`uncannySkew`,
   `audio.playSpatial`+`audio.listener`, `hud.*`. Pool projectiles; instance repeated props.
4. Flip the game's `on:false→true` + add `load:()=>import('./games/<id>.js')` in `src/main.js` GAMES.
5. New synth voice? add to `VOICES` in `core/audio.js`. New solver? add to `physics.js` **and a test**.
6. Determinism: no `Math.random` in `step`; seed via `mulberry32`. Update this handoff at the end.

## How to run
`cd carnival && npm install` (done) → `npm run dev` → pick a booth + tier. Lock booths (TARGET PLINKER, dart):
click canvas to pointer-lock, aim mouse, LMB fires/throws, RMB scopes, **Space** holds breath, ESC releases.
Cursor booths (ring toss, **anchor smash**): ring toss = drag on a ring and flick to throw, **A/D** pre-tilt the
plane; anchor = press **A/S/D/F** on the beat to charge, then **drag down + flick** to smash. `?dev=1` → F9 record /
F10 replay a round (prints score + frame hash).

## Architecture snapshot
- `core/engine.js` — one `WebGLRenderer` (antialias, ACES), scene/camera reused per game.
- `core/loop.js` — fixed-step accumulator, `SUBSTEP=1/60`, render interp `alpha`.
- `core/kinetics.js` — **PURE** gesture/input math: flick estimator, drag FSM, key bitmask, per-substep `kinSnap` InputFrame, `packFrame`/`hashFrames`. Node-testable, imports nothing.
- `core/input.js` — thin DOM adapter over a kin instance (NDC coords, `setMode('lock'|'cursor')`, `snap()`→`input.frame`) + legacy shim (fireQueue/…/yaw/pitch) + record/replay.
- `core/store.js` — **PURE** persistence: v1 schema, tickets, 17 trophies, `finishRun`/`migrate`, injectable backend. Imports nothing.
- `core/fx.js` — pooled `makeBurst` (InstancedMesh) + `makeTrajLine` (preallocated line). Render-side, THREE as param.
- `core/physics.js` — `integrate()`, collision solvers, `mulberry32(seed)`, material consts. **Pure, no three import → unit-testable in node.**
- `core/audio.js` — `AmbientBus` (BiquadLP ~400Hz, low gain) + `SfxBus` (dry, `PannerNode`), `playSpatial()`, synth voices.
- `core/materials.js` — procedural PBR (canvas noise), `clinicalLights(scene)`, `uncannySkew(mesh)`.
- `core/hud.js` — DOM overlay: score, tier, reticle, feedback pops, charge/scope/breath meters.
- `core/tiers.js` — `applyTier(game, n)` reads per-game `TIERS[1..5]`.
- `core/characters.js` — `makeAttendant()` procedural uncanny watcher figures (idle+track+react).
- `core/decor.js` — `carnivalDress()` shared booth dressing (bulb strings, bunting, poles, valance).
- `games/*.js` — each exports `{init(ctx), update(dt,input), teardown()}`.
- `main.js` — menu → `loadGame(id, tier)` → lifecycle.

## Key decisions (locked)
- Physics: **fully custom analytic** (no cannon/ammo). Determinism > convenience.
- Build: **Vite + npm**, single dep `three`.
- Location: `carnival/` subfolder.

## Invariants to preserve (see plan.md)
60Hz fixed step · no `Math.random` in step · seeded PRNG · pooled/instanced props · dense docs.

## Open questions / risks
- Ring-toss thin-torus tunneling → swept sphere-vs-peg + substepping (see `skills.md`).
- Backspin model for basketball rim (tangential friction impulse) — tune in `level_5`.
- Determinism across machines: fixed dt + no wall-clock in step; float order fixed.

## Changelog
- (init) Architecture approved; docs authoring started.
- (M0–M4) Scaffolded Vite+three; built core (engine/loop/input/physics/audio/materials/hud/tiers)
  + `games/shooting.js` (Level 1, all 5 tiers). 6/6 headless tests, clean build, dev server boots.
  Physics kernel is dependency-free (node-tested).
- (M4 ✅) Level 1 **playtested & approved** by user in-browser.
- (M5) Built Level 2 High Striker (`games/highstriker.js`): triangle charge/timing meter, honest
  rail-impulse physics (`railImpulse`/`railApex`), fixed-`H_REF` tier scaling, thud+ding voices,
  hold/release input, HUD meter+swings. 10/10 tests, clean 16-module build, dev boots.
- (M5 ✅) Level 2 **playtested & approved** ("looking crisp").
- (M6) Built Level 3 Balloon Dart (`games/dart.js`): ballistic-arc darts, swept thin-hitbox pops
  (`sweptPointSphere`), scope+hold-breath-steady+release-throw, seeded drift/sway, cutout exposure
  caps, InstancedMesh balloons + pooled darts/shards, whoosh/pop/breath voices, generalized HUD
  count + scope/breath overlays. 14/14 tests, clean 17-module build, dev boots.
- (M6 ✅) Level 3 **playtested & approved** ("crisp"). User note: want better + scarier graphics.
- (M7) Built Level 4 Ring Toss (`games/ringtoss.js` + pure `physics.stepRing` rigid-torus solver:
  sampled-node torus↔cylinder/plane, sequential impulses, micro-substep anti-tunnel, restitution-slop
  + wobble-bleed settle; `qapply`/`qIntegrate`/`cross` added). Power-toss + backspin, 5-peg board, clack
  voice. **+ shared graphics/atmosphere upgrade** (bloom, vignette/CA/grain grade, fog, flickering
  fluorescents, PBR env reflections, normal maps). 19/19 tests, clean 29-module build, dev boots.
- (M7 ✅) Level 4 Ring Toss + graphics **playtested & approved** ("looks excellent").
- (M8) Built Level 5 Basketball (`games/basketball.js` + pure `physics.sphereTorus`/`resolveBallContact`
  spin-aware sphere contact → emergent backspin "shooter's roll"; Magnus flight; swish/make/miss with
  swept rim-plane make test; power-shoot + backspin; swish voice). 24/24 tests, clean 30-module build,
  dev boots.
- (M8 ✅) Level 5 approved ("continue").
- (M9) Built Level 6 Skee-Ball (`games/skeeball.js`): ramp roll (surface decel) → lip-launch when the
  ball leaves the surface at the crest → projectile → ring-aperture drop with `sphereTorus` rim rattle;
  9-ball round, lateral aim + rails, reused voices. 28/28 tests, clean **31-module** build, dev boots.
  **🎉 All 6 booths built.**
- (M9 ✅) L5 approved ("continue").
- (M10) POLISH PASS on user note ("skee-ball not playing well; far more graphics+audio; make your own
  characters"): reworked Skee-ball (auto-tuned per-tier launch + predicted-landing marker + lateral aim
  + reachable rings — verified headless 10→50→gutter both tiers); added `core/characters.js` (uncanny
  attendants) + `core/decor.js` (carnival dressing) + audio per-booth ambient/drone/murmur; wired all
  6 booths. 28/28 tests, clean 33-module build, dev boots. Awaiting playtest.
- (M11-plan) **Kinetic-overhaul master blueprint authored; `plan.md` REPLACED (v2, M11–M15).** User-approved
  scope: InputFrame kinetic input layer (`core/kinetics.js` pure — flick velocity, drag FSM, WASD/Space,
  per-substep determinism snapshot), `core/store.js` (localStorage high scores/tickets/17 trophies, injectable
  backend), **Anchor Smash replaces High Striker** (rhythm charge + vertical flick, `trackImpact`; rail fns
  deleted at M13), basketball rebuild (drag-to-arc `dragToShot` + `ballStep`/`tracePath` preview + Space
  wrist-flick; rim e=0.75 board e=0.60), cursor drag-flick for ringtoss/skeeball, plinker z-lanes + hinged
  torque targets, dart crosswind + `aeroPitch`. Hybrid cursor model; aesthetic + determinism invariants kept.
  Blueprint only — **no code changed** (28/28 tests intact). Execution starts at M11 per `plan.md` §7/§8.
- (M11) Built **Foundational Framework** (§3 + §7 M11 row): `core/kinetics.js` (pure — flick estimator,
  drag FSM, key bitmask, per-substep `kinSnap` InputFrame, `packFrame`/`hashFrames`), `core/input.js` rewrite
  (DOM adapter feeding kinetics + zero-diff legacy shim + record/replay), `core/store.js` (pure — v1 schema,
  `finishRun`, `ticketsFor`, 17 trophies, `migrate` never-throws, injectable backend), `core/fx.js`
  (`makeBurst`/`makeTrajLine`). Wired `engine.attachInput`, HUD `tickets/toast/ribbon/rhythm` + `index.html`,
  `main.js` `ctx.store`+`end(result)` wrapper+mode switching+`?dev=1` harness. **50/50 tests**
  (28 existing via shim + 22 new), clean **35-module** build, dev boots. **6 game files untouched.**
- (M11 ✅) Foundational Framework **playtested & approved** (user, 2026-07-11): 6 booths unchanged, tickets
  persist on reload, F9/F10 replay identical.
- (M12) Built **Targeting & Throwing Suite** (§4 L1/L3/L4 + §7 M12 row): physics `hingeKick`/`hingeStep`/
  `aeroPitch` (+tests); **L1 TARGET PLINKER** rework (z-lanes, hinged tin/iron/gong torque plates scored on
  knockdown, Space-breath, RMB scope — first frame-API booth); **L3 dart** crosswind gust + aeroPitch tip-lag
  fishtail + Space-breath + LMB throw; **L4 ring toss** cursor drag-flick (`flickToLaunch` speed+azimuth, drag
  steepness=arc, A/D ±8° pre-tilt) + `scrape` on slide, `stepRing` untouched; `audio.scrape` voice; main.js
  label→'TARGET PLINKER'. All three pass `end(...,{score,stats})` so tickets/trophies fire. **57/57 tests**
  (new `shooting.test.mjs` 4 + dart +2 + ringtoss +1), clean **35-module** build, dev boots. L2/L5/L6 still on
  the shim (migrate M13/M14).
- (M12 ✅) Targeting & Throwing Suite **played well, user-approved**.
- (M12.5) **Polish & Pacing pass** on the 3 M12 booths (feel/juice/pacing, render-only — no sim/scoring math
  changed): `fx.makeBurst` wired into all three (dart's shard pool deleted → shared burst); render-only impact
  camera kick (clean-base re-derive on plinker/dart, `camQ0` pivot on ringtoss, position untouched); ring toss
  pacing via new pure `physics.ringSettle` early-capture + timeout 6→3.5 + sleepN 20→16; dart `N_DARTS` 25→18 +
  low-tier v nudge + render-only exaggerated fishtail (pop test stays true-φ); plinker survived-hit spark vs
  knockdown burst + round timers −15%. **58/58 tests** (+`ringSettle`), clean **36-module** build (fx now a
  shared chunk), dev boots ~325ms.
- (M12.5 ✅) Polish & Pacing pass **played & accepted** (user, 2026-07-12); verdict also flagged ring toss +
  basketball feel → M14 scope adjusted (see Status / plan §7 M14). Chose stay-on-roadmap: M13 next.
- (M13) Built **Kinetic Power Engine** (§5 + §7 M13 row): **deleted High Striker** (`highstriker.js`,
  `highstriker.test.mjs`, `physics.railImpulse`/`railApex`, `PROFILES.highstriker`; both grep gates empty) →
  **ANCHOR SMASH** (`games/anchor.js`): seeded A/S/D/F rhythm-charge spins a flywheel storing energy E, then a
  downward wrist-flick releases a hammer down a `H_TRACK=3.2` m run — new pure `physics.trackImpact(vf,E,mH,H,μ)`;
  `power=vImp/VIMP_REF`, alignment `mult=1+2·align²` (1×–3×), `pts=round(400·power²·mult)`. Cursor mode, 5 smashes,
  zero RNG in outcome (pattern seeds off tier only; scoring reads only `input.frame`; fx uses a decoupled seed).
  New voices `tick`/`slam`/`crowd`; `PROFILES.anchor`; `ambientProfile` ramps via `setTargetAtTime`; menu card swap.
  Render-only camera kick + flywheel/hammer/shockwave visuals. `test/anchor.test.mjs` (5). **59/59 tests**, clean
  **36-module** build, dev boots. ◄ AWAITING PLAYTEST before M14.
