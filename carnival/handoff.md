# Uncanny Carnival — Handoff (session resume)

**What:** browser 3D carnival skill-suite. Three.js render, Vite build, one custom
deterministic physics kernel, procedural Web-Audio SFX, uncanny-valley PBR + clinical light.
6 games × 5 tiers. Zero RNG rigging.

**Where:** `Arcade/carnival/` (isolated — root `Arcade/` is the unrelated Rust kart game;
do **not** touch root `plan.md`/`handoff.md`/`src/*.rs`).

## Current status
- **Phase:** All 6 booths built. **BIG POLISH PASS done — AWAITING PLAYTEST:** (1) Skee-ball reworked
  so it actually plays, (2) shared **characters** (uncanny attendants) at every booth, (3) shared
  **carnival decor** at every booth, (4) **richer audio** (per-booth ambient + dread drone + murmur).
- **Verified:** `npm test` = **28/28 pass**. `npm run build` clean (**33 modules**; new `characters`/
  `decor` share a chunk). `npm run dev` boots ~250ms; all 6 games + new core modules 200. Skee-ball
  power→ring mapping **verified headless**: power sweeps 10→20→30→40→50→gutter on T1 AND T5 (auto-tuned).
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

## Level 2 High Striker — as built
- **Skill model:** charge meter is a **triangle** oscillating 0→1→0 over `2·RISE`(=84) frames.
  Releasing near the peak gives high `charge` AND high timing `acc` at once (both derived from the
  release frame), so `sH = SWING·gain·charge·acc` peaks sharply. `acc = ACC_MIN + (1-ACC_MIN)·
  max(0,1-Δ/win)` (floor 0.5 so a charged-but-mistimed swing still launches at half power).
- **Physics (honest):** `v0 = railImpulse(sH,mH,mP,e) = (1+e)·mH/(mH+mP)·sH`; puck rises 1-D vs
  `g+µg`; `H = railApex = v0²/(2(g+µg))`. Puck **clamps at the bell** (real rail stop).
- **Difficulty is honest:** bell scale = a **fixed** `H_REF` = T5 perfect-play apex / T5.bell,
  shared by all tiers → heavier `mP`, more `µ`, lower `gain`/`e`, taller `bell`, and narrower
  `win` all genuinely lower reach vs one bar. T1 ⇒ ring with sloppy timing; T5 ⇒ 1-frame window +
  bell at ~perfect apex ⇒ frame-perfect release required. `mH=12`, `SWING=8`, `RISE=42` (tunables).
- **Round:** `N_SWINGS=10` attempts; bell = 200·(1+streak·0.1) + streak++; else ring 0–4 ×25,
  streak reset. Determinism: outcome is a pure fn of the release frame; no RNG in step.
- **New core surface:** `physics.railImpulse/railApex` (pure, tested); `input.lmb/pressQueue/
  releaseQueue` (hold+release edges, LMB mouseup added); `audio` voices `thud`(mallet) + `ding`
  (bell); `hud.mode('time'|'swings')`, `swings()`, `striker()`, `sweet()`, `charge()`; index.html
  `#striker` meter + `#hSwingsRow`. main.js resets `hud.mode('time')/striker(false)` per game.

## Adding a game (pattern established by Level 1)
1. `games/<id>.js` exports `create(ctx)` → `{ step(dt), render(alpha), teardown() }`.
   `ctx = { THREE, scene, camera, renderer, input, audio, hud, tier, end(title,body) }`.
2. Define `const TIERS=[…5 rows…]` (from that game's `level_*.md`); pick with `tier(TIERS,ctx.tier)`.
3. Reuse core: `physics.integrate/bounce/mulberry32/…`, `clinicalLights`+`mat.*`+`uncannySkew`,
   `audio.playSpatial`+`audio.listener`, `hud.*`. Pool projectiles; instance repeated props.
4. Flip the game's `on:false→true` + add `load:()=>import('./games/<id>.js')` in `src/main.js` GAMES.
5. New synth voice? add to `VOICES` in `core/audio.js`. New solver? add to `physics.js` **and a test**.
6. Determinism: no `Math.random` in `step`; seed via `mulberry32`. Update this handoff at the end.

## Level 2 High Striker — build notes (next)
- Charge (hold LMB → `charge∈[0,1]`) + release-timing accuracy vs a shrinking sweet-spot window →
  mallet head speed `sH`. Impulse to puck: `Δv=(1+e)·mH/(mH+mP)·sH`; puck 1-D up rail vs `g+μg`,
  peak `H=v0²/(2(g+μg))`; win if `H≥bellHeight`. All in `level_2_high_striker.md` tier table.
- Needs: a `railImpulse`/1-D integrate path (can reuse `integrate` on a y-only body), a charge/timing
  HUD bar (extend `hud.js`), mallet-thud + bell-ding synth voices. Input needs a **hold+release**
  (currently only edge-fire queue) — add `chargeStart`/`chargeRelease` events to `core/input.js`.

## How to run
`cd carnival && npm install` (done) → `npm run dev` → click SHOOTING GALLERY → pick tier →
click canvas to pointer-lock → aim mouse, click to fire, RMB scopes, ESC releases.

## Architecture snapshot
- `core/engine.js` — one `WebGLRenderer` (antialias, ACES), scene/camera reused per game.
- `core/loop.js` — fixed-step accumulator, `SUBSTEP=1/60`, render interp `alpha`.
- `core/input.js` — pointer-lock, per-frame immutable input snapshot.
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
