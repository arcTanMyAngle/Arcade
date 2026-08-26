# BREACHPOINT — handoff

Living state doc. Update at the end of every work chunk.

## Architecture and invariants

BREACHPOINT is a procedural Three.js FPS pursuing modern-shooter rendering
technique and feel. `src/main.js` is the integration root; subsystem signatures
and ownership live in `CLAUDE.md`. Simulation is fixed at 128 Hz and reads only
immutable per-tick input frames.

Non-negotiable: no binary assets, seeded randomness only, honest hitboxes/spread,
visual and collision geometry authored together, fixed-size runtime pools, and no
per-frame heap growth in hot paths.

**Standing constraints on all future level work** — both were paid for in full
sessions and both fail silently:

- **The world-sealing test must stay green.** New geometry may never open a
  standing sightline out of the level below the horizon. Purely additive brushes
  cannot break it, but anything that *moves* or *removes* geometry can.
- **Check the nav grid after adding large obstacle brushes.** Bounds are derived
  from obstacle brushes in `ai/nav.js`; past the 9,000-node cap the cell size
  coarsens and AI pathing degrades **with no error**. Currently cell 1.000,
  71×76 = 5,396 nodes, 3,604 spare. Masses that project *inward* from existing
  extents cost nothing — that is how Phase 3 added 68 brushes for zero nav cost.

## Status (2026-08-05, Phase 4 — PARTIAL, agents killed by spend limit)

### Phase 4 landed in the tree: the ambient double-count, and a sky deck

Three agents were fanned out (ambient, characters, sky). **All three were killed
mid-flight by a monthly spend limit**, none reported. The lead verified what they
left behind rather than trusting it. `src/ai/**` is **untouched** — the character
agent died before its first edit, leaving only a baseline capture in
`shots/char1-before/`. Defects #4, #6, #7 are therefore **not started**.

**The ambient root cause was found and it is real.** `envMapIntensity 1.7` was
double-counting sky irradiance: three sums `getIBLIrradiance()` (the PMREM sky,
scaled `PI * envMapIntensity`) into the **same** irradiance accumulator the
hemisphere light writes to. So every shadowed surface got two stacked blue sky
fills, the PMREM one being the more saturated (zenith B:R ~8.8:1). That is why
shadow went blue *and* why starving either term alone crushed to black.

Rebalanced in `render/materials.js` + `render/lighting.js`: `envMapIntensity`
**1.7 → 1.0** (indirect specular sheen only), hemisphere **0.95 → 0.72** with
ground **0x4a4034 → 0x6b5a44**, bounce **0.55 → 0.95** and warmed
**0xffd9b0 → 0xffcb96**. Fill now lives where it can be colour-balanced.

**Measured, `wallW`, shipped `lvl-comp3` vs `amb2` — same pose, clean A/B:**

| Region | Before | After |
|---|---|---|
| Shadowed west wall field | luma 71.7, rgb 67/72/84, **B−R +17** | luma 78.5, rgb 83/77/82, **B−R −1.4** |
| Ground band at wall base (y 470–530) | luma 6.6–9.8, min 0 | luma 6.1–10, min 0 |

- **Symptom 1 (blue shadow) is FIXED** — B−R +17 → −1.4 is neutral, and the wall
  got slightly *brighter* rather than darker. This is the session's real win.
- **Symptom 2 (crushed ground band) is NOT fixed.** Still luma ~6–10 with min 0.
  It is less blue (B−R 23.5 → 13.8) but just as dark. Three multiplicative terms
  land on that band — the wall's cast shadow, occluded sky, and GTAO in the
  corner — and rebalancing ambient only touched one. **Next attempt should
  establish which term dominates before changing anything**; the un-shadow-mapped
  `bounce` light is the only fill that still reaches it, so measure with GTAO
  disabled first to see whether GTAO is the floor.
- **Symptom 3 (breach reads as "outside") is NOT fixed.** breach-centre luma
  86.1 vs bulkhead 86.5 — no separation. Confirms the standing prediction: this
  needs a **warm exterior fill light**, not an ambient or albedo change.
  *Caveat: the before frame `gate-fix2` predates Phase 3 level work, so absolute
  values there are confounded; the breach-vs-bulkhead gap within one frame is the
  trustworthy part.*

**Sky (`render/sky.js`) gained a cloud deck and a sun disc.** Warped-fbm cumulus
projected onto a notional layer (compresses toward the horizon), dissolving into
the existing haze rather than clipping it; sun disc with limb darkening, a tight
pre-bloom ring and a wide Mie lobe, dimmed by cloud in the same view direction.
Verified visually in `shots/sky1/overlook.png` — it reads as cloud, not as noise.

**But its reproducibility claim FAILS, and this is a real defect.** Two
independent captures of `overlook` differ in **8,538 sampled sky pixels** (max
channel-sum delta 11, ~4 per channel). The module drives `uTime` off a call-count
clock specifically to avoid wall-clock — correct intent — but `update()` is called
once per *render* frame, and **the rAF window between `loop.start()` and the
`loop.stop()` in `main.js`'s HEADLESS branch runs a variable number of frames.**
The nondeterminism is inherited from the loop, not from the sky shader.

### The harness defect behind both the sky drift AND defect #10

`core/loop.js` is wall-clock driven (`now = () => performance.now()`, accumulator,
`MAX_STEPS = 8`). Under SwiftShader a render frame costs hundreds of ms, so `acc`
accumulates enough for **up to 8 sim ticks per render frame, varying with real
frame time**. Therefore **`__GAME__.settle(n)` does not advance a deterministic
number of sim ticks.** Static poses hide this because the scene reaches steady
state. It is fatal for anything time-varying — which is why the sky now drifts
between runs, and why **combat visuals (defect #10) have never been capturable**:
a muzzle flash lives ~2–3 ticks, so "fire then settle" lands on a different tick
every run.

**Designed fix, deliberately NOT applied this session** (see risk below):

1. `main.js` — in HEADLESS, pass a virtual clock to `createLoop`. The
   `createLoop({ step, render, now })` signature **already accepts `now`**;
   `main.js` simply never passes it. A clock advancing a fixed step per render
   frame makes `settle(n)` mean exactly n ticks. No contract change.
2. `core/input.js` — `createScriptedInput(script)` closes over the array with no
   setter and no way to reset `t`. Add `setScript(arr)`.
3. `tools/capture.mjs` — combat shot spec = pose + script + tick offset, driving
   the real `weapons.step` → `weapon:fire` → fx path.

**Why it was not applied:** a virtual clock changes the tick count behind *every*
existing acceptance shot (TAA convergence, AI and level state all advance less per
`settle`), so it can shift every frame in `shots/`. That needs a rebuild-and-
recapture loop to re-baseline, and this session had no budget left to finish one.
**Landing it half-verified is exactly the failure mode this project has already
paid for twice.** Do it first in a session with room to re-baseline.

### Fixed and visually verified in a prior session — Phase 3, defects #2 and #3

**#3 The perimeter walls are trimmed.** `wallTrim()` in `src/world/level.js`
authors every inner face: a plinth and drip, a string course and drip, a
three-part cornice whose corona oversails 0.40 m, capped pilasters every ~5.3 m,
a service layer (conduit run at y=6.35, junction boxes, drops, wall boxes) and
hooded lamps on the west and south runs. Runs stop at the adjoining wall's inner
face, and the north runs stop at the gateway jambs so the 9 m portal stays clear.

- **The design premise was measured on both cases, and it is the same physics
  that killed the Phase 2 brick experiment.** `sunDir = (-0.42, 0.78, 0.46)`
  lights only the east and north inner faces, so relief has to read on faces that
  never see the sun. Vertical relief on a shadowed face separates by nothing;
  horizontal relief separates by a lot, because the hemisphere fill is bright sky
  over dark ground, so an up-face and a soffit land far apart with no sun
  involved. Hence banding, and caps even on the pilasters.
- **Shadowed west wall** (new `wallW` pose, 8.4 m): field luma **68–79**, trim
  soffits dip to **48–55**. **Sunlit north wall** (`hero`): field **135**,
  soffits **62–68** — a 2.1:1 ratio. The banding reads in both conditions.

**#2 Overlook composition.** Two large masses rather than more props: an 11 × 8 m
concrete-framed maintenance bay at `(-12, 13)` with 4.6 m clear height, and a
9.6 m water tower at `(-3, 20.8)`. The frame now reads near railing → sunlit
crate pair → bay (22 m) → tower (32 m) → wall (34 m), where it was flat sand
holding one 1.3 m crate.

- **Placement was measured, not eyeballed.** A projection script mirroring
  `controller.pose()` (fov 80, 16:9, eye 1.58 over the 3.38 m catwalk, YXZ euler)
  located the empty band at px 850–1280 = ground `x -20..-6, z 5..22`. It was
  validated against known landmarks first: the crate at `(-15.5, 9)` projects to
  px(1009, 457) and the HVAC pair to px(1213, 402), both matching the shipped
  frame. This is the same discipline as the crush map — guessing rectangles off a
  thumbnail does not work.
- **The tower height is a measured choice**: at 9.6 m the tank lands at py ~224
  against a south wall top of py ~258, so it silhouettes against sky instead of
  grazing the wall edge. Legs are vertical because a splayed `beam` AABB would be
  a metre of phantom collision.
- The recovery cluster was **not** relocated. It projects to px 639–648 at
  35–41 m — dead centre, not in the right half at all. With real midground in
  front of it, it now reads as the far layer instead of as the only content.

**Tried and measured as regressions — do not repeat:**

- **Bay walls jammed to the roof deck** (3.9 m walls under a 4.4 m deck). The
  wall/roof junction and the internal corner painted **solid magenta** in the
  crush map, ~2 k px at luma 0 — the same contact-occlusion failure as the
  sally-port conduits. Fixed by a **1.6 m clerestory gap** and by stopping the end
  wall short in z so the two walls never form an inside corner.
- **Props parked inside the bay.** The crate alone was ~1 k px of crush. The roof
  shadows `x -15.4..-3.6, z 5.9..14.7` (sun travels `(0.42, -0.78, -0.46)`);
  anything in that box gets neither sun nor sky. Props moved to the forecourt at
  `z < 5.89`, where they are now a lit foreground for the bay.
- **Bay columns in `paintedMetal`** — six saturated blue verticals that fought the
  yard palette for attention. Now `concrete`.
- **Junction and wall boxes in `paintedMetal`** — read as rows of small blue
  windows along every wall at distance. Now `rustedSteel`.

**Crush accounting on `overlook`, whole frame, luma < 4:** shipped baseline
**38,208 px** (4.146%) → first bay version **40,968** (+2,760) → with clerestory
**40,036** (+1,828) → **shipped now 39,026 (+818)**. The remainder is thin contact
occlusion along the roof deck edge, the same class and scale as the 45 px the
sally port kept.

**Cost: zero new draw calls.** Level batches stay at **14** — every piece merged
into an existing material batch — and programs stay **69**, because no new
material was introduced. Level geometry **7,200 → 12,488 triangles**, **98 → 166
brushes**. The AI nav grid is **unchanged at cell 1.000, 71×76 = 5,396 nodes**
with 3,604 nodes of headroom: every new mass projects *inward* from existing
extents, so the obstacle bounds (`x ±31.60`, `z -40.80..27.60`) did not move.
This was checked, not assumed.

**Both sealing tests stayed green through every iteration**, as required of all
new level geometry. Suite 44/44 throughout.

**New poses**, because the trim could not be judged honestly from `overlook`
(where a 0.5 m cornice is 6 px): `wallW` — the west wall at 8.4 m, deliberately
the shadowed hard case — and `bay`, the new masses from the player's spawn
approach.

### Handed to the Graphics Engineer — ANSWERED IN PHASE 4, kept for the record

Phase 3 handed two measured items to the render agent. **Phase 4 acted on both;
one is closed and one is not.** Do not re-file these as new work — read the
Phase 4 section above for current numbers.

1. **"Shadowed faces swing hard blue" — CLOSED.** The diagnosis (hemisphere fill
   plus `envMapIntensity 1.7`) was right in its parts but missed the mechanism:
   the two were being *summed into the same irradiance accumulator*, so it was a
   double-count, not merely two strong terms. Fixed; B−R +17 → −1.4 on `wallW`.
2. **"Ground at the base of the perimeter walls is crushed" — STILL OPEN.** The
   Phase 3 attribution stands and is still the best evidence: the band is
   uniformly black across its full 4 m width rather than decaying with distance
   from the 0.30 m plinth, and it starts at py ~471 exactly where the plinth foot
   projects, so it is cast shadow plus occluded sky and it predates the trim.
   Phase 4 added one fact: **rebalancing ambient did not move it** (luma 6.6–9.8
   → 6.1–10), which rules ambient out as the dominant term and points at GTAO or
   the cast shadow itself.

### Fixed and visually verified in the prior session — the north gateway void

- **Outstanding defect #1 is closed.** The 9 m gateway at `z = -27` is now the
  mouth of a roofed **sally port**: side walls at `x = ±4.5..±5.5` running
  `z = -27.6 → -34.8`, a roof slab at `y = 5.8` matching the gate lintel, and a
  partly collapsed bulkhead at `z = -35.1` whose breach frames an exterior
  backdrop mass at `z = -39..-40.4`. All of it in `src/world/level.js`.
- **The bounding argument is geometric, not eyeballed.** Port walls bound every
  sightline laterally; roof slab and the bulkhead's intact lower course bound it
  vertically; the backdrop slab spans the full remaining cone. The backdrop is
  the guaranteed backstop — masses in front of it (a container stack, a lattice
  mast, forward wings) are free silhouette and can be rearranged safely.
- **Measured, same regions as the original defect report:** `overlook` left edge
  min-luma **0.0 → 7.0** (mean 67.9 → 104.8); `diagLeft` gate rectangle min-luma
  **0.0 → 13.6**; the breach itself min **31.1**, zero sub-4 pixels. A crush map
  (sub-4 luma painted magenta over the whole frame) confirms the only crushed
  pixels left near the gate are the ceiling conduit run's contact-occlusion
  pockets — 121 px, reduced to 45 by hanging the conduits 0.42 m below the slab
  instead of 0.2 m — plus the pre-existing viewmodel.
- **A regression test now enforces the invariant** (`test/gameplay.test.mjs`,
  "no standing sightline escapes the level below the horizon"). It builds the
  **real** level — only `mats` is stubbed — and fires ~55 k rays from ~130
  standing eye positions across the yard, the port and the catwalk, asserting
  that **no ray with `dir.y <= 0` leaves the world**. Rays that rise are fine;
  sky above the horizon is sky. Verified non-vacuous: against the pre-fix
  `level.js` it reports **8 escaping sightlines** and fails.
- **A second test pins the portal open** ("the north gateway stays open onto the
  sally port"), because bricking up the gateway would also pass the sweep and
  would delete a traversable 9 m portal. It asserts the axial ray still reaches
  the bulkhead at ~24.8 m.
- **Cost: zero new draw calls.** Everything merges into existing material
  batches. Level geometry 5,952 → 7,200 triangles, 67 → 98 brushes. Whole-frame
  387 draws (unchanged), 231,238 → 236,230 triangles, 69 programs (unchanged —
  the 4th point light did not add a program). AI nav grid stays at **cell 1.000,
  71×76 = 5,396 nodes** against the 9,000 cap, so nav resolution is unaffected.

### Fixed and visually verified in earlier sessions

- **The game was unbootable at the start of the boot-fix session.** The previous session's
  enemy-body rewrite mixed indexed primitives (`Capsule`/`Cylinder`/`Sphere`) with
  non-indexed `RoundedBoxGeometry` in the same merge bin. `mergeGeometries`
  returns **`null`** for a mixed bin instead of throwing, so three of the six
  material families merged to `null` and the resulting `Mesh(null)` threw
  `Cannot read properties of null (reading 'morphAttributes')` during boot. The
  page rendered `BOOT FAILED`. The suite passed 40/40 the entire time. Fixed in
  `src/ai/body.js` with a `push()` helper that flattens every geometry to
  non-indexed before binning; the merge now **throws** rather than yielding `null`.
- **Two regression tests added** (`test/gameplay.test.mjs`) so this cannot recur:
  one asserts all six families merge to real, finite geometry; one asserts living
  anatomy (every bin except `gun`) stays inside `AGENT_R` × `AGENT_H`. The capsule
  test measures **true per-vertex radial distance**, not a bounding box — its
  first version was too weak and would have passed a corner sitting 0.42 m out.
- **Enemy anatomy rewritten.** Constant-radius capsule bones replaced with a
  tapered-cylinder helper plus sphere joint mass at knees/elbows/deltoids/wrists.
  Calves went from a uniform 19 cm sausage to 0.042 ankle → 0.072 belly → 0.052
  knee; helmet 32 cm → 24 cm wide; torso is two stacked masses that V-taper; plate
  carrier darkened to `0x1b201f` at roughness 0.52 with real profile depth; head
  gained a neck and armor collar. Measured extents: **y 0.000–1.763 (limit 1.78),
  radius 0.338 (limit 0.36)**. Still six bins / six draws per agent.
- **Weapon material response fixed.** The receiver, 0.72 m top rail, magazine and
  optic base were `metalness 0.9 / roughness 0.26 / envMapIntensity 2.1` — they
  mirrored the sky, read as chromed aluminium, and blew to pure white across the
  lower third of the ADS frame. Four materials became fourteen mapped by real
  finish (parkerized, anodized, polymer, small bright parts), env intensity pulled
  to ~0.9–1.25, plus a shared `onBeforeCompile` procedural noise breakup
  (mottle / streak / wear / bump). The ADS deck is now darker than the sand behind
  it.
- **Viewmodel arms rebuilt** — sleeve fabric bunching rings, a dark gauntlet cuff
  separating sleeve from glove by value, wrist break, per-finger segments on both
  hands, bevelled optic housing bars, and the blue Fresnel rim on the receiver
  flank removed. **Caveat: its author was killed by a spend limit before it could
  capture. I captured and inspected it myself in `shots/final1/` — it renders
  correctly and the ADS sight picture is intact — but it never went through its
  own critic iteration.**
- **A debug frame-time readout was shipping in every frame.** `main.js` assigned
  `hudCtx.stats = loop.stats` unconditionally and `ui/hud.js:64` draws it whenever
  stats exist, so `0 FPS 1.7 MS` sat under the health readout in every acceptance
  capture. Now gated behind `?stats`.
- **`tools/capture.mjs` now dumps page console output and body text when the game
  never becomes ready**, instead of reporting a bare `Timeout 180000ms exceeded`.
  That bare timeout is exactly what hid the boot failure above.

### Unchanged and still true

- The level is a batched exterior CQB yard with a playable catwalk/stairs,
  containers, HVAC, pipes, vehicle, pallets/crates, rubble, signage, railings,
  localized lights, and a traversable 2.5 m OPS-01 recess with a breach-staging
  and a vehicle-recovery cluster. Geometry merges to one mesh per material; solid
  helpers author matching collision.
- `world/collision.js` uses a grid broadphase for movement and ballistic rays and
  returns material, hit point, and outward normal.
- Post is HDR world render → GTAO → camera-reprojected TAA → isolated layer-2
  viewmodel → bloom → restrained grade → output transform → FXAA.
- The BP-15 keeps deterministic 750-rpm fire, truthful spread, recoil, ADS,
  tactical/empty reloads, and ballistics. The open red-dot and centered ADS solve
  are unchanged and re-verified.
- Audio is fully synthesized. AI uses the nav graph for reaction, cover,
  peek/fire/duck, suppression, honest capsule zones, damage, and death collapse.

## Verification

- Node suite: **44/44** (42 + the two world-sealing tests). Re-verified after the
  Phase 4 ambient and sky changes.
- Production Vite build: **passes** (re-verified after Phase 4).
- **Phase 4 capture — the current shipped state: `shots/amb2/`** (`wallW`, `hero`,
  `gate`, `overlook`) for ambient, and **`shots/sky1/`** (`overlook`, `hero`,
  `bay`) for the cloud deck and sun disc. `shots/amb1/` is the first ambient loop.
  `shots/sky2/` is the second independent run kept as the evidence that the sky is
  **not** byte-reproducible. `shots/char1-before/` is a baseline for character work
  that never started. Whole-frame perf at `amb2`: **387 draws / 257,382 tris /
  69 programs**, `q=ultra` — unchanged program count, well inside the 900/1.6 M gates.
- **Phase 3 capture: `shots/lvl-comp3/`** (`overlook`, `bay`, `wallW`) — the
  previous shipped state, and the **before** frame for the Phase 4 ambient A/B.
  `shots/lvl-comp1/` and `lvl-comp2/` are the two Phase 3 revision loops, kept
  because their crush maps are the evidence for the bay fixes.
- Gateway capture: **`shots/gate-fix2/`** (`gate`, `gateIn`, `diagLeft`,
  `overlook`) — the Phase 2 shipped state and the before/after for `overlook`.
  `shots/gate-fix3/` is the rejected brick experiment.
- Prior capture: **`shots/final1/`** (`hero`, `ads`, `overlook`, `enemyClose`).
- **Judge level cost by the level's own batches, not the whole-frame number.**
  Whole-frame draws swung 353 / 369 / 387 across three Phase 3 captures with no
  level change between two of them — the delta is AI agents surviving frustum
  culling differently, not geometry. The stable figures: level **batches 14
  (unchanged)**, level geometry **7,200 → 12,488 triangles**, **98 → 166
  brushes**, **69 programs (unchanged)**, `q=ultra` — against gates of **900
  draws / 1.6 M triangles**. Nowhere near the gate; art direction is still the
  constraint.
- `shots/lvl-comp3/console.log` is clean apart from SwiftShader's expected missing
  `KHR_parallel_shader_compile` warning.

## Honest visual assessment

Verdict remains **ITERATE**, not SHIP. The weapon no longer reads as chrome and
the hostile no longer reads as a toy — both were severe, both are genuinely fixed
and visually confirmed. What remains is real and mostly known.

### Outstanding defects, ranked

1. **UNRESOLVED SUB-ITEM of the (now fixed) gateway void: the breach does not
   read as "outside".** The void is gone and the port is not an unlit recess —
   but through the breach, exterior mean luma is **94.8** against the bulkhead
   framing it at **88.1**, and both read cool (rgb 96/94/103 vs 84/88/101). The
   eye is not pulled through the opening. **Two revision loops were spent on this
   and it is flagged for human review, per the iteration budget.**
   - What was tried and *measured as a regression, do not repeat*: swapping the
     exterior masses to `brick` for hue separation. Breach-left fell **85.3 →
     68.2** mean and stayed cool (rgb 67/67/79). Reverted.
   - **Why it failed, and what to do instead.** Those masses are in shadow, so
     they are carried by the cool hemisphere fill (`0x9ec4f5`) and a lower-albedo
     material only darkens them. The separation has to come from **light**, not
     material: a warm exterior fill beyond the bulkhead (a 5th point light in
     `level.js` around `z ≈ -38`), or getting real sun onto the backdrop's `+z`
     face. Confirm first *why* a `+z`-facing wall with `dot(n, sunDir) = 0.46` is
     rendering unlit — if the shadow frustum (S = 40, player-centred) is clipping
     it, that is a `render/lighting.js` matter and belongs to the render agent,
     not the level agent.
   - **Phase 4 update — the "warm exterior fill" prescription is now confirmed,
     not just theorised.** Rebalancing the whole ambient model (which fixed the
     blue cast everywhere else) moved the breach separation not at all: breach
     centre luma 86.1 vs bulkhead 86.5. A global ambient change cannot separate
     two surfaces that are both carried by ambient. **The next attempt must be a
     local light** — a 5th point light beyond the bulkhead around `z ≈ -38` — or
     real sun on the backdrop's `+z` face. Confirm the shadow-frustum question
     (`S = 40`, player-centred, `lighting.js:18`) before assuming the latter.
   - Lower-priority in the same frame: the stepped bulkhead tear reads as
     pixel-stair noise at 27 m rather than as collapsed masonry, and the lattice
     mast is a heavy dark blob in the opening at radius 0.15.
2. **PARTIALLY FIXED in Phase 4 — blue shadow is closed, crushed ground is not.**
   The blue cast is genuinely solved (B−R +17 → −1.4 on the shadowed west wall)
   by removing the `envMapIntensity` double-count; see the Phase 4 section for the
   mechanism and the table. **What remains is the crushed ground band only**
   (still luma ~6–10, min 0 at the wall base) and it is now a *different* problem
   from the one originally filed: three multiplicative terms stack there (cast
   shadow × occluded sky × GTAO) and ambient was only one of them. Measure with
   GTAO off first to find the dominant term.
3. **Ground macro variation is too subtle.** A materials pass landed a macro
   breakup term (programs 63 → 67) but its author measured it as reading too
   weakly and was killed before strengthening it. The yard still reads close to
   one tiled surface. **This change is in the tree, half-tuned.**
4. **Enemy uniform is one flat olive value** at one roughness — no camo, no fabric
   variation. Needs a texture exposed from `render/materials.js`, which
   `ai/body.js` does not own.
5. **`corrugated` does not read as corrugated metal past ~20 m.** The bay's infill
   panels read as pink-tan masonry, not ribbed sheet — the ribs do not survive
   distance. `render/textures.js`, materials owner. Kept anyway: the warm hue is
   doing useful separation work against the cool concrete frame.
6. **The hostile's face is a pale unshaded patch** between goggle band and jaw.
7. **Enemies are statically posed** — no aim, walk, or breathing; the rig only
   leans and kicks.
8. **The ADS receiver deck still carries one broad soft specular lobe**, because
   its top is a single flat plane. Needs chamfer geometry, not more shader.
9. **DONE in Phase 4 — clouds and a sun disc now exist** and read correctly in
   `shots/sky1/overlook.png`. Horizon haze already existed (luma 123 mid-frame vs
   172.5 at horizon) and was built on, not replaced. **One open sub-item: the sky
   is not byte-reproducible across runs** (8,538 sampled px differ) because the
   drift clock inherits the loop's frame-count nondeterminism. Fix is the virtual
   clock in the harness section — not a sky-shader change.
10. **Combat visuals have never been captured — and now the reason is known.**
    It is a harness defect, not an art gap: `settle(n)` does not advance a
    deterministic tick count, so a ~2–3 tick muzzle flash cannot be framed
    reproducibly. See the harness section for the designed three-part fix.
    Muzzle flash, tracers, decals, hand motion, enemy collapse and
    TAA-under-motion all remain unverified.

### Accepted limitations — deliberately not "fixed"

- **The hostile holds the carbine with both hands at the receiver**, not one on the
  handguard. A support arm reaching the handguard at `z ≈ -0.60` would sit ~0.24 m
  outside `AGENT_R`. Honest hitboxes are a hard project rule: the visible body may
  not exceed what the raycast can hit. Fixing this properly means re-posing the
  carbine rearward/canted, not stretching the arm.
- Sun shadows use one stabilized map. **True cascaded shadow maps and SSR do not
  exist and must not be claimed.**
- The viewmodel pass runs after TAA and GTAO, so the weapon gets neither temporal
  AA nor ambient occlusion — only the trailing FXAA. Keep new viewmodel detail at
  ~1 cm spatial frequency or coarser or it will alias.
- `VM_FOV = 66` in `weapons/tuning.js` is a **dead contract**: `ViewmodelPass` in
  `render/pipeline.js` renders with `rc.camera` on layer 2, so there is no separate
  viewmodel camera and the viewmodel's apparent size does swing with world FOV.
  Either add the VM camera or stop claiming it exists. Unresolved.

### On the critic loop — read this before trusting a critic report

A read-only critic pass ran against `shots/accept1/`. It caught one real defect
everything else had missed (the shipping debug readout). **Three of its six ranked
defects did not survive measurement** and were correctly not acted on:

- *"Shadowed and lit surfaces sit close in value"* — false, and this was its
  claimed **highest-leverage correction**. A luma profile across the container
  shadow boundary in `hero.png` at `y = 445` gives shadowed ground **luma ≈ 56** vs
  sunlit **≈ 100**: a ~2.7:1 linear illumination ratio with a correct cool shift in
  shadow (R50 G56 B68) against warm sun (R111 G103 B103). Ambient is somewhat
  generous versus a real clear day (~5:1), but this is not the root defect.
- *"The right-wall recess crushes to solid black"* — false. Mean luma 71.3, min
  35.9, same mean as the lit wall beside it.
- *"No horizon haze"* — false, see defect 9.

**Measure before acting on a critic claim about light or value.** Pixel sampling is
cheap and settles these arguments in one call:

```powershell
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap("shots\<dir>\<shot>.png")
$p = $b.GetPixel($x, $y)   # average over a patch; scan a line to find an edge
```

## Exact next command

```powershell
cd C:\Users\bornt\Desktop\Arcade\fps
npm test        # expect 44/44
npm run build
```

**Do the harness virtual-clock fix FIRST** (designed in the Phase 4 section
above, three parts, none of them applied). It is the gate on two separate
things — the sky's byte-reproducibility and *all* combat-visual verification
(defect #10) — and it is the only remaining item that blocks other work rather
than merely looking imperfect.

Budget a full re-baseline with it: a virtual clock changes the tick count behind
every existing shot in `shots/`, so expect to rebuild and recapture the
acceptance set and compare deliberately. **Do not start it without room to
finish it** — landing it half-verified is the failure mode this project has
already paid for twice.

After that, in order: the crushed ground band (defect #2's remainder — measure
with GTAO off first), then the character work in `src/ai/**` (defects #4, #6, #7)
which is **completely unstarted**, then the breach warm-fill (defect #1).

## Verification harness

```powershell
npm test
npm run build
node tools/capture.mjs --out shots/<name> --shots <poses> --w 1280 --h 720 --port <unique>
```

Capture builds to an isolated `.dist-cap-<port>` and previews it, so parallel
agents cannot corrupt each other's dist or fight over a port. `?headless` halts
normal rAF and `__GAME__.settle(n)` advances review frames; `?stats` re-enables the
frame-time readout. Capture runs headless Chromium on SwiftShader — it is slow
(minutes) and its fps number is meaningless; judge cost by draw calls, triangles
and pass count.

Always inspect the PNGs, `console.log`, and `perf.json`. **A successful bundle is
not proof of a valid frame, and this session proved it: the build compiled cleanly
and the suite passed 40/40 for an entire prior session while the game could not
boot at all.**

Poses in `level.poses`: `hero`, `corridor`, `ads`, `overlook`, `enemy`,
`enemyClose` (3.2 m off the catwalk hostile — the only framing that resolves
anatomy), `gate` (mid-yard, straight down the gate axis at the breach),
`gateIn` (inside the sally port), `diagLeft`, `wallW` (west wall at 8.4 m — the
perimeter trim's acceptance frame, and deliberately the shadowed case), `bay`
(the south-yard masses from the spawn approach).

**A 34 m framing cannot verify 0.5 m detail** — at that range a cornice is 6 px.
Phase 3 added `wallW` for exactly this reason. Add a pose rather than squint.

**Projecting world points into a pose beats guessing pixel rectangles.** Mirror
`controller.pose()`: `PerspectiveCamera(80, w/h, ...)`, position `pos + eye 1.58`,
`Euler(pitch, yaw, 0, 'YXZ')`, then `Vector3.project(camera)`. Validate it against
a landmark you can already see in a shipped frame before trusting it — Phase 3
checked the crate at `(-15.5, 9)` → px(1009, 457) first. This is the same lesson
as the crush map, applied to placement instead of sampling.

`diagLeft` was marked "delete once the void is fixed" — **kept deliberately**. It
frames the gateway obliquely, which is the angle most likely to expose a sealing
regression, and it is the direct before/after against `shots/diag-left/`. Note
that `gate` sits at `x = 2.4`: `x = 0.5` is exactly the OPS-01 block's `+x` face
and puts the camera inside geometry.

## Agent orchestration notes

- Cap of three sub-agents alongside the lead worked well. Enforce the ownership
  table in `CLAUDE.md` strictly — one agent per subsystem, disjoint files, and a
  distinct capture port and `shots/` prefix per agent so concurrent verification
  cannot collide. Ports used this session: 4331/4332 (round 1), 4351/4352/4353
  (round 2), 4340/4341/4360 (lead).
- Require every implementation agent to capture **and read its own PNGs back**.
  Both round-1 agents did; both caught things in their own frames that they then
  fixed. An agent that only builds will report success on a black screen.
- Critic agents must stay read-only, and the lead must independently verify any
  claim before acting on it. See the critic section above for why.
