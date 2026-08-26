# Next-session prompt — BREACHPOINT (Arcade/fps/) — Phase 5

Paste the block below into a fresh session.

---

Continue building **BREACHPOINT**, the Three.js FPS at `c:\Users\bornt\Desktop\Arcade\fps`.
Goal: CoD-tier rendering technique and game feel in a browser.

**Read first, in order:** `fps/CLAUDE.md` (hard rules, frozen module contract,
per-agent file ownership) then `fps/handoff.md` (current state, ranked defects).
Do NOT load the other four Arcade projects — root `plan.md`/`handoff.md`/`src/*.rs`
are Wii Kart's; `carnival/` and `galaga/` are separate.

Four roles, held by you unless a task genuinely needs parallel file-disjoint work:
**Architect** (`src/main.js`, `src/core/**`), **Graphics Engineer**
(`src/render/**`, `src/fx/**`), **Physics/Input Coder** (`src/player/**`,
`src/weapons/**`, `src/world/collision.js`), **QA Critic** (harsh, **read-only**,
and **must measure before claiming anything about light or value**).

**Iteration budget: a MAXIMUM of 2 revision loops per component.** If it is not
right after two, ship the best version, revert anything measured as a regression,
and flag it in `handoff.md` for human review. Never loop infinitely.

## Where it stands

Phases 1–3 are done and verified. **Phase 4 was cut short — three parallel agents
were killed mid-flight by a spend limit.** The lead verified what they left rather
than trusting it. Read the Phase 4 section of `handoff.md` for the numbers.

- `npm test` → **44/44**. Production Vite build passes. Both re-verified post-Phase 4.
- Shipped acceptance captures: **`shots/amb2/`** (ambient) and **`shots/sky1/`** (sky).
- Whole-frame perf: **387 draws / 257,382 tris / 69 programs**, `q=ultra`, against
  gates of **900 draws / 1.6 M triangles**. **Perf is not the constraint; art
  direction is.**
- **Do not judge a level edit by the whole-frame draw/triangle count.** It swung
  353 / 369 / 387 across three Phase 3 captures with no level change between two
  of them — that is AI agents surviving frustum culling differently. Count the
  level's own merged batches (currently 14).

**What Phase 4 actually closed:** the shadowed-surface blue cast. Root cause was a
**double-count** — three sums `getIBLIrradiance()` (the PMREM sky, scaled
`PI * envMapIntensity`) into the *same* irradiance accumulator the hemisphere
light writes to, so every shadowed surface got two stacked blue fills. Rebalanced
(`envMapIntensity` 1.7 → 1.0, hemi 0.95 → 0.72 with a warmer ground term, bounce
0.55 → 0.95 and warmed). Measured on `wallW`: shadowed wall **B−R +17 → −1.4**,
luma 71.7 → 78.5. Also landed: a procedural cloud deck and sun disc in `sky.js`.

## Phase 5 — your task, in this order

### 1. The harness virtual-clock fix — DO THIS FIRST

This is the only remaining item that **blocks other work** rather than merely
looking imperfect. It gates two separate things.

`core/loop.js` is wall-clock driven (`now = () => performance.now()`, accumulator,
`MAX_STEPS = 8`). Under SwiftShader a render frame costs hundreds of ms, so the
accumulator runs **up to 8 sim ticks per render frame, varying with real frame
time**. Therefore **`__GAME__.settle(n)` does not advance a deterministic number
of sim ticks.** Static poses hide it; anything time-varying breaks.

Consequences, both now measured:
- The new sky drifts between runs — two independent captures of `overlook` differ
  in **8,538 sampled sky pixels**. The sky module correctly avoids wall-clock and
  drives `uTime` off a call count; the nondeterminism is inherited from the loop.
- **Combat visuals (defect #10) have never been capturable.** A muzzle flash lives
  ~2–3 ticks, so "fire then settle" lands on a different tick every run. This is a
  harness defect, not an art gap.

Three parts, all in lead-owned files:
1. **`main.js`** — in HEADLESS, pass a virtual clock to `createLoop`. The
   `createLoop({ step, render, now })` signature **already accepts `now`**;
   `main.js` simply never passes it. No contract change.
2. **`core/input.js`** — `createScriptedInput(script)` closes over the array with
   no setter and no way to reset `t`. Add `setScript(arr)`.
3. **`tools/capture.mjs`** — combat shot spec = pose + script + tick offset,
   driving the real `weapons.step` → `weapon:fire` → fx path, not a mock.

**Budget a full re-baseline.** A virtual clock changes the tick count behind every
existing shot in `shots/` — TAA convergence, AI and level state all advance less
per `settle` — so expect to recapture the acceptance set and compare deliberately.
**Do not start this without room to finish it.** Landing it half-verified is the
failure mode this project has already paid for twice.

Then capture combat for the first time: muzzle flash, tracer mid-flight, impact
decal and spark, reload mid-cycle, enemy hit reaction, death collapse, and TAA
under motion (the pass most likely to smear, and never once tested moving).

### 2. The crushed ground band — the remainder of defect #2

The 4 m band at the base of the perimeter walls is still luma **6.1–10, min 0**
in `wallW`. **Phase 4's ambient rebalance did not move it** (was 6.6–9.8), which
rules ambient out as the dominant term. Three multiplicative terms stack there:
the wall's cast shadow, occluded sky, and GTAO in the corner. **Measure with GTAO
disabled first** to find which one is the floor, then fix that one. The
un-shadow-mapped `bounce` light is the only fill term that still reaches it.

### 3. Character quality — COMPLETELY UNSTARTED (defects #4, #6, #7)

`src/ai/**` is untouched; its agent died before its first edit.
`shots/char1-before/` is a baseline. Uniform is one flat olive value at one
roughness (no camo or fabric variation), the face is a pale unshaded patch, and
enemies are statically posed — the rig only leans and kicks.

Implement camo/fabric **inside `body.js`** via `onBeforeCompile` procedural noise,
the way `src/weapons/` already solved the same problem. **Honest hitboxes are a
hard rule**: `AGENT_R` **0.36**, `AGENT_H` **1.78**, currently y 0.000–1.763 /
radius 0.338, enforced by tests measuring **true per-vertex radial distance**.
The both-hands-on-the-receiver grip is an **accepted limitation** — a support arm
at the handguard sits ~0.24 m outside `AGENT_R`. Do not stretch the arm; cant the
carbine rearward if you re-pose. `enemyClose` is the only framing that resolves
anatomy; check `hero`/`enemy` too, since camo that reads at 3 m can turn to mud
or to noise at 30 m.

### 4. The breach warm-fill — defect #1

**Phase 4 confirmed the prescription.** Rebalancing ambient globally moved the
breach separation not at all (breach centre luma 86.1 vs bulkhead 86.5), because a
global ambient change cannot separate two surfaces both carried by ambient. Use a
**local light** — a 5th point light beyond the bulkhead near `z ≈ -38` — or get
real sun onto the backdrop's `+z` face. A 5th point light adds no draw calls but
recompiles every program. Confirm the shadow-frustum question (`S = 40`,
player-centred, `lighting.js:18`) before assuming the sun route.
**Already measured as a regression, do not repeat:** swapping those exterior
masses to `brick` — breach-left fell 85.3 → 68.2 and stayed cool.

## Standing constraints on level work (both fail silently)

1. The test *"no standing sightline escapes the level below the horizon"* fires
   ~55 k rays from ~130 standing eye positions and asserts **no ray with
   `dir.y <= 0` leaves the world**. Rays that rise are fine. Keep it green.
2. **Check the nav grid.** Bounds derive from obstacle brushes; past the 9,000
   node cap the cell coarsens and AI pathing degrades with **no error**. It sits
   at cell 1.000, 71×76 = 5,396 nodes. Phase 3 added 68 brushes for zero nav cost
   by keeping every new mass *inward* of existing extents.

## Facts you will need

- `sunDir = (-0.42, 0.78, 0.46).normalize()` — `materials.js`. Sun is up/west/south,
  so **+z-facing surfaces are lit**.
- One stabilized shadow map, 40 m half-extent, player-centred. **True cascaded
  shadow maps and SSR do not exist and must not be claimed.**
- `scene.fog = FogExp2(0x8fa2b8, 0.0085)` — only ~11% at 40 m.
- Post: HDR world → GTAO → reprojected TAA → isolated layer-2 viewmodel → bloom →
  restrained grade → output transform → FXAA. **The viewmodel gets neither TAA nor
  GTAO** — keep new viewmodel detail at ~1 cm frequency or coarser or it aliases.
- `VM_FOV = 66` in `weapons/tuning.js` is a **dead contract** — `ViewmodelPass`
  renders with `rc.camera` on layer 2, so viewmodel size does swing with world FOV.
  Either add the VM camera or stop claiming it exists. Unresolved.
- Poses: `hero`, `corridor`, `ads`, `overlook`, `enemy`, `enemyClose`, `gate`,
  `gateIn`, `diagLeft`, `wallW`, `bay`. `gate` sits at `x = 2.4` — `x = 0.5` is
  exactly the OPS-01 block's `+x` face and puts the camera inside geometry.
- **A 34 m framing cannot verify 0.5 m detail** — at that range a cornice is 6 px.
  Add a pose rather than squint.

## Verification — required before reporting done

```powershell
cd C:\Users\bornt\Desktop\Arcade\fps
npm test
npm run build
node tools/capture.mjs --out shots/<name> --shots <poses> --w 1280 --h 720 --port <unique>
```

Use a **unique port and `shots/` prefix**. Taken: 4331/4332, 4340/4341, 4351–4353,
4360, 4361–4363, 4370, 4380/4381/4382. Capture runs headless Chromium on
SwiftShader — slow (minutes), exits non-zero on any page error, and **its fps
number is meaningless**. Judge cost by draw calls, triangles, pass and program count.

**Then read the PNGs back with the Read tool and look at them.** A build that
compiles but renders a black screen is a failure — the suite passed 40/40 for an
entire session while the game could not boot at all. Also check `console.log`
(clean apart from SwiftShader's `KHR_parallel_shader_compile` warning) and `perf.json`.

## Measure before you claim

Three of six ranked defects in an earlier critic pass did not survive measurement,
including its self-declared highest-leverage fix. Pixel sampling settles it:

```powershell
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap("shots\<dir>\<shot>.png")
$p = $b.GetPixel($x, $y)   # average over a patch; scan a line to find an edge
```

- **Crush map** for crushed blacks: copy the frame painting every pixel under
  luma 4 magenta, crop, upscale, read back. It is how Phase 2 found that two "too
  dark" rectangles were actually sampling the rifle, not the level.
- **Vertical luma profile**: step a patch-average down one column, print luma +
  RGB per row. It is how the blue shift and the crushed band were separated from
  the geometry, and how Phase 4 proved the blue fix took.
- **Compare the same pose across two capture dirs** — that is a clean A/B.
  Comparing across dirs captured in different phases confounds unrelated changes
  (Phase 4 hit this on `gate`: `gate-fix2` predates Phase 3 level work, so only
  the within-frame breach-vs-bulkhead gap was trustworthy).
- **Project world points into a pose rather than guessing pixel rectangles.**
  Mirror `controller.pose()`: `PerspectiveCamera(80, w/h, ...)`, position
  `pos + eye 1.58`, `Euler(pitch, yaw, 0, 'YXZ')`, `Vector3.project(camera)`.
  **Validate against a landmark you can already see** — Phase 3 checked the crate
  at `(-15.5, 9)` → px(1009, 457) first.

## Gotchas already paid for (don't rediscover)

- `?headless` halts normal rAF and `__GAME__.settle(n)` advances review frames.
  `?stats` re-enables the frame-time readout; it must stay off in acceptance shots.
- `mergeGeometries` returns **`null`** — it does not throw — for a bin mixing
  indexed and non-indexed geometry, and `Mesh(null)` only explodes at render time.
  `body.js` has a `push()` helper that flattens to non-indexed first.
- Procedural texture gen: non-integer lattice periods and all-octaves-skipped both
  produce NaN, which `Uint8Array` coerces to 0 — a silently pure-black material.
  `test/textures.test.mjs` guards both.
- Capture builds to an isolated `.dist-cap-<port>` and previews it, so parallel
  work cannot corrupt another run's dist or fight over a port.
- `src/main.js` is the integration root and **lead-only**. Subsystems never import
  each other; they talk via `ctx` handles + the `core/events.js` bus.
- Playwright `waitForFunction(fn, arg, options)` — options is the **third** param.

## Agent orchestration

Cap of three sub-agents alongside the lead. Enforce the ownership table strictly —
one agent per subsystem, disjoint files, and a **distinct capture port and
`shots/` prefix per agent**. Require every implementation agent to capture **and
read its own PNGs back**; an agent that only builds will report success on a black
screen. Critic agents stay read-only and the lead independently verifies any claim
before acting on it.

**Cost warning from Phase 4:** three concurrent agents on a large-context project
exhausted a monthly spend limit before any of them reported. If budget is tight,
run **one** agent at a time, or hold all four roles yourself. Also note that the
lead must not edit `main.js`, `core/**` or `tools/capture.mjs` while agents are
running — they all rebuild from the tree to verify, and changing the shared
harness under them corrupts their captures.

## Non-negotiables

Procedural assets only (no binary art or audio, ever). Deterministic 128 Hz sim,
seeded `mulberry32` only — no `Math.random`, no wall-clock, no frame-rate coupling
in any sim path. Honest hitboxes, spread and damage. Pool everything, no per-frame
heap growth, dispose on teardown.

**Update `fps/handoff.md` at the end of the work chunk**, including anything you
tried that failed and was reverted, with the measurement that condemned it.

Working tree is dirty and uncommitted. Commit only if asked.
**The numbers here describe that dirty tree, not `HEAD`** — `HEAD` predates
Phase 2. If anything is committed or amended before you start, re-derive the counts.
