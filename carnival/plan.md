# Uncanny Carnival — Master Plan v2: Kinetic Overhaul (M11–M15)

**Type:** browser 3D carnival skill-suite · Three.js (WebGL) · Vite/npm · custom deterministic physics · Web Audio.
**Philosophy:** true skill > rigged. Deterministic, zero-RNG-rigging. Every miss is the player's, every make earned.
**This document is the immutable execution blueprint** for the kinetic overhaul. Downstream models execute it
milestone-by-milestone without further architectural decisions. Plan v1 (M0–M10: scaffold → core → all 6 booths →
polish pass) is **complete** — live state in `handoff.md`. Read `claude.md` (style/determinism/aesthetic rules)
before touching any file.

## §0 Vision & decided foundations (locked 2026-07-11, user-approved)

Transform the suite from meter-and-click mechanics into a **kinetic, velocity-sensitive sports package**: mouse
flicks and drag-to-arc gestures carry real hand velocity into honest physics; keyboard modifies spin/stance/breath;
a central store persists high scores, tickets, and trophies.

- **Keep the Three.js 3D base.** No 2D-canvas pivot. 2D projectile formulas map to the vertical shot plane.
- **Keep the uncanny-valley aesthetic** (clinical key + sickly neon, `uncannySkew`, lowpassed ambient). Kinetic
  sports DNA lives in controls + physics feel, never in art direction.
- **Hybrid cursor model:** pointer-lock stays for aiming booths (Plinker, Dart); visible-cursor click-drag-flick
  for throwing booths (Ring Toss, Basketball, Skee-Ball, Anchor Smash).
- **Renames:** L1 `SHOOTING GALLERY` → `TARGET PLINKER` (tag `RIFLE · LANES · TORQUE`); L2 `HIGH STRIKER` is
  **deleted**, replaced by `ANCHOR SMASH` (tag `RHYTHM · FLICK · IMPULSE`).
- **Model intent** (§8 run-lists): core math/systems → Opus-class; UI/graphics/audio → Sonnet-class; mechanical
  plumbing/refactors → Haiku/codegen-class. All work is executable by one agent sequentially; the split is intent.

## §1 Non-negotiable invariants (carried from v1 + one new)

- **Fixed 60 Hz physics substep.** Render decoupled + interpolated (`alpha`). Same inputs → identical outcome.
- **Zero `Math.random` in any physics/scoring path.** Variation = seeded `mulberry32`, seed documented per game.
- **One runtime dep: `three`.** No physics/audio libs. All SFX synthesized, all textures procedural. No asset files.
- **Reuse core; per-game files hold only game logic.** No copy-paste physics. New solvers → `physics.js` + a test.
- **Honest difficulty only.** Never fudge hitboxes/scores to help or punish. Difficulty = physics constants.
- **NEW — InputFrame determinism:** all input enters physics via the per-substep immutable `input.frame` record
  (§3.1). No game or solver may read DOM events, wall-clock, or raw mouse deltas. Determinism is defined as:
  *same InputFrame log ⇒ same result*; replay/certification = frame-log replay (`packFrame`/`hashFrames`).
- **Token-dense docs, short vars, comment only the math.** Update `handoff.md` at the end of every work chunk.

## §2 Module map (new + changed)

```
src/core/kinetics.js  NEW   PURE, imports nothing — gesture math, flick estimator, drag FSM, InputFrame snapshot
src/core/store.js     NEW   PURE, imports nothing — persistence, tickets, trophies (injectable backend)
src/core/fx.js        NEW   three-side — pooled particle bursts (generalizes dart shards) + trajectory line
src/core/input.js     REWRITE  thin DOM adapter feeding kinetics; legacy shim (fireQueue/pressQueue/…) until M15
src/core/physics.js   EXTEND  +ballStep +tracePath +trackImpact +hingeKick +hingeStep +aeroPitch; −railImpulse −railApex (M13)
src/core/audio.js     EXTEND  +slam +crowd +tick +ticket +chime +scrape voices; PROFILES highstriker→anchor; ramped ambientProfile
src/core/hud.js       EXTEND  +tickets(n) +toast(title,sub) +ribbon(x0,y0,x1,y1|null) +rhythm(seq,idx,hot)
src/core/decor.js     EXTEND  +boothBackdrop(THREE,scene,{theme,depth}) — procedural parallax silhouettes, render-side
src/core/engine.js    EXTEND  +attachInput(input): step callback = input.snap() → active.step(dt)
src/main.js           CHANGE  ctx.store · end(title,body,result) · engine.attachInput · GAMES row swap · setMode('cursor') on menu
index.html            EXTEND  #hTickets row · #toasts stack · #ribbon div · #rhythm lane · ANCHOR SMASH menu card
src/games/anchor.js   NEW    replaces highstriker.js (DELETED at M13)
test/                 NEW    kinetics.test.mjs store.test.mjs anchor.test.mjs shooting.test.mjs; extend dart/ringtoss/basketball/skeeball
```

## §3 Core systems

### §3.1 Kinetic input layer — `core/kinetics.js` (pure) + `core/input.js` (DOM adapter)

**Split:** every piece of math and state lives in pure `kinetics.js` (node-testable with synthetic event streams);
`input.js` only registers listeners, normalizes coordinates, forwards `(type, x, y, t)` into a kinetics instance.

**Determinism model (load-bearing).** Wall-clock exists only on the capture side:
1. DOM events (with `e.timeStamp`) append to kinetics' internal buffers. Nothing in a game reads them.
2. Once per substep, **before** `active.step(dt)`, engine calls `input.snap()` → `kinSnap(kin, frame)`: folds all
   buffered events since the last snap into one immutable **InputFrame** of plain numbers — edges counted, deltas
   summed, flick velocity **pre-computed into floats** — then clears buffers.
3. Games read **only** `input.frame`. Wall-clock's sole influence is *which substep an event lands in* — which is
   the input itself, exactly like today's fire queue. Replay = frame log, not raw events.

**InputFrame** (double-buffered plain object; `packFrame` flattens to 24 floats):
```js
frame = {
  n,                        // substep index since attach
  mode,                     // 0=lock 1=cursor
  yaw, pitch,               // absolute aim (lock mode), rad
  cx, cy,                   // cursor NDC, +y up (cursor mode)
  dx, dy,                   // summed raw mouse delta this substep (NDC units)
  lmb, rmb,                 // held (0/1)
  press, release,           // LMB edge counts this substep
  rmbPress, rmbRelease,
  dphase,                   // DPHASE.IDLE|PRESS|DRAG|RELEASE (RELEASE valid exactly one frame)
  dragX0, dragY0,           // drag origin NDC
  dragDX, dragDY,           // origin→current vector NDC
  dragT,                    // drag length in substeps
  flickVX, flickVY,         // release-velocity estimate, screen-heights/s (valid when dphase===RELEASE)
  keys, keyPress            // bitmask held / edge — K.{A:1,D:2,W:4,S:8,SPACE:16,F:32,SHIFT:64,R:128}
}
```
All screen coords are **NDC normalized by canvas rect** (`nx=(px-left)/w*2-1`, `ny=-((py-top)/h*2-1)`); flick
velocity is in **screen-heights/second** — resolution-independent, so a frame log replays identically at any window
size. `input.js` caches `canvas.getBoundingClientRect()`, refreshes on `resize`.

**Flick estimator** — ring buffer of last 32 move samples `{dx,dy,t}` (NDC, `e.timeStamp`); at LMB-up compute a
windowed mean over the trailing `FLICK_WIN=100` ms (exactly reproducible, robust to event coalescing — beats EMA):
```js
export function flickFromSamples(buf, head, n, tRel, winMs, out) {
  let sx = 0, sy = 0, tOld = tRel;
  for (let i = 0; i < n; i++) {
    const j = ((head - i) % 32 + 32) % 32, t = buf[j*3+2];
    if (tRel - t > winMs) break;
    sx += buf[j*3]; sy += buf[j*3+1]; tOld = t;
  }
  const span = Math.max(tRel - tOld, 8);      // ms clamp: kills div-blowup on 1-sample flicks
  out.vx = sx / span * 1000; out.vy = sy / span * 1000; return out;
}
```
Optional fidelity upgrade (flagged, not required): unpack `e.getCoalescedEvents()` into the same buffer.

**Drag FSM** (data in the kin instance; `kinSnap` surfaces `dphase`, auto-advances RELEASE→IDLE next snap):
```
IDLE --lmb-down--> PRESS(origin) --moved > DEAD=0.012 NDC--> DRAG
PRESS --lmb-up (< DEAD)--> IDLE           (still emits press/release edges: it's a click)
DRAG  --lmb-up--> RELEASE (flickVX/VY computed; one snap only) --> IDLE
DRAG  --rmb-down or Escape--> IDLE        (cancelled; no RELEASE frame)
```

**Mode switching + guards.** `input.setMode('lock'|'cursor')` called by each game in `create()` (main.js sets
`'cursor'` on menu). Lock mode: click requests pointer lock (as today); movementX/Y folds into `yaw/pitch` *and*
NDC deltas. Cursor mode: never requests lock (exits if held), tracks clientX/Y, drag machine armed, DOM
`cursor:crosshair`, `hud.reticle(false)`. **After any `pointerlockchange` or `setMode`: swallow edges for
`SWALLOW=8` substeps** (drag machine reset, edge counters zeroed) — kills phantom clicks/flings on transitions.
Keys map via `KEYMAP = {KeyA:1, KeyD:2, KeyW:4, KeyS:8, Space:16, KeyF:32, ShiftLeft:64, KeyR:128}`;
`preventDefault` on mapped codes + arrows while HUD is active.

**Legacy shim (M11–M14 only):** `fireQueue/pressQueue/releaseQueue/lmb/scope/yaw/pitch/keys` stay synthesized from
the same event stream so unmigrated games run untouched. Deleted at M15 (grep gate: `pressQueue` absent from
`src/games/`).

**kinetics.js exports:**
```js
export const K, KEYMAP, DPHASE;
export function makeKin(cfg={dead:0.012, win:100})     // -> kin instance (plain object)
export function kinPointer(kin, nx, ny, dnx, dny, t)   // move sample
export function kinButton(kin, btn, down, nx, ny, t)   // 0=LMB 2=RMB
export function kinKey(kin, bit, down)
export function kinReset(kin)                          // mode/lock change
export function kinSnap(kin, frame)                    // fold + clear -> frame
export function flickFromSamples(buf, head, n, tRel, winMs, out)
export function dragToShot(dx, dy, cfg, out)           // §6.1
export function flickToLaunch(vx, vy, cfg, out)        // §4 ringtoss/skeeball
export const wristQ  = (err, win) => err > win ? 0 : 1 - err / (win + 1);
export const beatAcc = wristQ;                         // same shape, named per use
export function packFrame(f, f64, i) / unpackFrame(f64, i, f)   // 24 floats
export function hashFrames(f64, n)                     // FNV-1a -> uint32 (determinism gates)
```

**Record/replay dev harness** (main.js, behind `?dev=1`): F9 starts recording packed frames; F10 replays the log by
substituting `snap()`'s source; final score + `hashFrames` printed via `hud.pop` + console. This is the in-browser
determinism certification tool for M11/M15 gates.

### §3.2 State + persistence — `core/store.js` (pure, injectable backend)

Backend = `{getItem(k), setItem(k,v)}` (localStorage-compatible); `null` → in-memory map (private mode, tests).
No `Date.now()` anywhere — trophy unlock order is recorded as a play index.

```js
export const SCHEMA_V = 1, SAVE_KEY = 'uncanny-carnival';
// persisted state:
{ v:1, tickets:0, best:{ [gameId]:{ [tier]:int } }, plays:{ [gameId]:int }, totalPlays:0, trophies:{ [id]:playIdx } }

export function makeStore(backend) -> {
  state, session,                            // session = {score, runs:[]} — NEVER serialized
  load(),                                    // parse -> migrate -> state (never throws)
  save(),                                    // JSON.stringify under SAVE_KEY
  best(gameId, tier) -> int,                 // 0 if none
  finishRun(gameId, tier, score, stats) -> { earned, newBest, prevBest, unlocked:[trophy] },
  reset()
}
export function migrate(raw) -> state        // unknown v / junk / corrupt -> fresh defaults
export function ticketsFor(score, tier, newBest) -> int
export const TROPHIES, TROPHY_BONUS = 25;
```
**Tickets:** `ticketsFor = floor(score/100)·tier + (newBest ? floor(score/200)·tier : 0)`; +`TROPHY_BONUS` flat per
trophy unlocked. **finishRun:** bump plays/totalPlays → compare/record best → compute earned → evaluate every
unowned trophy `when({gameId,tier,score,stats,newBest}, state)` → add bonuses → `save()` → return result.

**Trophy table (17, concrete):**

| id | name | predicate |
|---|---|---|
| `first_light` | FIRST LIGHT | any run score > 0 |
| `full_circuit` | FULL CIRCUIT | plays has all 6 game ids |
| `paper_trail` | PAPER TRAIL | tickets ≥ 1000 |
| `nights_house` | HOUSE'S NIGHTMARE | any tier-5 best ≥ 500 |
| `clinical` | CLINICAL | best at tier ≥ 3 recorded for all 6 games |
| `gallery_deadeye` | DEAD EYE | plinker: stats.bulls ≥ 5 in one round |
| `gallery_ironwork` | IRONWORK | plinker: stats.heavies ≥ 3 knockdowns |
| `anchor_resonant` | RESONANT | anchor: stats.maxMult ≥ 2.9 |
| `anchor_chain` | CHAIN GANG | anchor: stats.fullChain === true |
| `dart_cluster` | SHRAPNEL | dart: stats.clusters ≥ 1 |
| `dart_windproof` | WINDPROOF | dart: tier ≥ 4 && score ≥ 1500 |
| `ring_backpeg` | LONG IRON | ringtoss: stats.backPeg === true |
| `ring_triple` | TRIPLE CROWN | ringtoss: stats.maxStreak ≥ 3 |
| `bball_pure` | PURE | basketball: stats.swishStreak ≥ 3 |
| `bball_allnet` | ALL NET | basketball: stats.makes ≥ 8 |
| `skee_hundo` | HUNDO | skeeball: stats.hundos ≥ 1 |
| `skee_500` | LANE KING | skeeball: score ≥ 500 |

**Contract changes:** main.js builds `makeStore(window.localStorage ?? null)`, `load()` at boot, injects
`ctx.store`. **`end(title, body, result)`** where `result = {score:int, stats:object}` (3rd arg optional during
migration; all 6 games pass it by their milestone). main.js `end` wrapper: `finishRun(g.id, tierSel, score, stats)`
→ append `BEST {best} · +{earned} TICKETS` (accent `NEW BEST`) to the banner body → `hud.toast(name, desc)` per
unlock → `hud.tickets(state.tickets)`.

### §3.3 FX / engine / HUD / decor / audio

- **`fx.makeBurst(THREE, scene, {n=128, size=0.035})`** → `{spawn(pos,count,rng,speed,color), step(dt), teardown()}` —
  one InstancedMesh of tetrahedra, ring-allocated; spawned only from the caller's seeded rng; stepped in game
  `step` (deterministic, visual-only). dart.js migrates its shard pool to it. Used for impact shockwaves,
  high-score/trophy bursts.
- **`fx.makeTrajLine(THREE, scene, {n=64, color=0x8fffe0})`** → `{set(flatF32,count), show(on), teardown()}` —
  preallocated BufferGeometry + LineBasicMaterial, `setDrawRange`, positions written from the pure-sim buffer.
- **engine.js:** `attachInput(input)`; step callback becomes `(dt) => { input?.snap(); active?.step(dt); }`.
  loop.js unchanged. Resize path already covers composer/bloom/grade; input's cached rect covers the canvas.
- **hud.js + index.html:** `tickets(n)` (top-left under score, `#hTickets`); `toast(title,sub)` (queued 2.5 s,
  `#toasts` top-center stack, CSS-animated); `ribbon(x0,y0,x1,y1|null)` (drag vector as a 1 px neon rotated div,
  `#ribbon`); `rhythm(seq, idx, hot)` (key-glyph beat lane for Anchor, `#rhythm`).
- **decor.js:** `boothBackdrop(THREE, scene, {theme, depth})` — 2–3 procedural-canvas silhouette planes (tent
  ridgelines, dead ferris wheel) behind the back wall, dim emissive; render-side parallax
  `plane.position.x = -yaw·kDepth`. Visual only.
- **audio.js:** new `VOICES`: `slam` (sub sine 55→28 Hz + noise crack + 1.2 s inharmonic ring), `crowd` (3
  band-passed noise swells, 1.4 s rise), `tick` (2 ms dry click, metronome), `ticket` (rapid zipper clicks ×n),
  `chime` (3 ascending pure sines, trophy), `scrape` (filtered-noise ring-on-peg grind). `PROFILES`: delete
  `highstriker`, add `anchor:[320,0.20,41]`. `ambientProfile` transitions become `setTargetAtTime(…,0.4)` ramps.

## §4 Per-game work packages (M12 + M14; §5–§6 cover anchor + basketball)

### L1 → TARGET PLINKER (`games/shooting.js` rework; pointer-lock kept) — M12
- **Z-lanes:** plates on 3 depths `LANES=[{z:-10,mul:1},{z:-16,mul:2},{z:-22,mul:3}]`, lateral drift per lane
  (seeded amp/omega). Hit test = existing `segCrossPlaneZ` per lane + nearest-plate radial check.
- **Hinged knock-down plates (honest torque).** New pure solvers in physics.js:
  `hingeKick(J, h, m, H)` → `ω = J·h / (m·H²/3)` (J = bullet momentum `mB·|v|` at impact, h = hit height above
  hinge, H = plate height); `hingeStep(st, m, H, damp, dt)` → gravity torque `α = (3g/(2H))·sinθ` past tipping,
  restoring before it; θ≥π/2 = fallen flat → dead, timed respawn rise. Score on **knockdown**, not ring value.
  Target classes `TYPES = { tin:{m:0.4,H:0.30,pts:20}, iron:{m:2.2,H:0.34,pts:60}, gong:{m:5.0,H:0.40,pts:150} }` —
  heavy plates demand center-mass velocity *and* a high hit point. Bull ring kept as `stats.bulls` (max torque arm
  near top edge).
- **RMB scope wired** (FOV 58→30; `sens×0.4` already exists) + **Space = breathe/stabilize**: mild seeded Lissajous
  sway (dart's `aimDir` pattern; per-tier 0.15°→0.9°); holding Space ramps `steady→1` (RAMP 4/s), drains breath
  (per-tier `drain`), regen 0.5/s; reuse `hud.breath`.
- **TIERS shape:** `{vMuzzle, k, wind, round, laneAmp:[3], laneOmega:[3], sway, drain}`.
- **Tests (`test/shooting.test.mjs`, NEW):** `hingeKick torque math` · `hingeStep: super-threshold impulse reaches
  π/2, sub-threshold wobbles back` · `tin falls to a rim-speed hit, iron survives the same impulse` ·
  `determinism: seeded gusts + fixed fire log → identical knockdown set`.

### L3 BALLOON DART (`games/dart.js` extend; pointer-lock kept) — M12
- **Crosswind:** seeded gust-knot curve (shooting's pattern) fed into existing `windDrag`; show `hud.wind`.
  TIERS gain `wind: 0/0.6/1.2/2.0/3.0`.
- **Weight distribution → pitch-over (honest):** path stays point-mass, but the **swept tip** becomes
  `tip = p + L_TIP·dir(φ)` where orientation φ follows the velocity angle with aerodynamic righting
  `dφ/dt = kA·|v|·sin(θv − φ)`. New pure `aeroPitch(phi, thV, speed, kA, dt)` in physics.js. Per-tier `kA: 6→2`
  (cheap darts fishtail); lagging φ shifts the swept endpoint, so long lobs land tail-heavy and can shave a balloon
  the point-mass would have popped. Render pitches the dart from φ (now physical, not cosmetic).
- **Controls:** breath-steady moves to **Space** (matches Plinker); **LMB = throw** (press-release or flick, keep
  simple: release throws as today). RMB scope unchanged.
- **Tests (extend `dart.test.mjs`):** `aeroPitch converges to velocity angle; larger kA converges faster` ·
  `tip lag shifts swept segment endpoint`.

### L4 RING TOSS (`games/ringtoss.js` rework; cursor drag-flick) — M12
- **Input:** `setMode('cursor')`; drag shown via `hud.ribbon`; on `dphase===RELEASE` →
  `flickToLaunch(flickVX, flickVY, {k:2.2, vMin:2.0, vMax:4.6, azK:0.6, azMax:0.35})` → speed + azimuth; elevation
  from drag steepness mapped θ∈[0.35,0.95]; backspin ∝ flick speed (existing SPIN scale). **A/D held at release
  pre-tilts the ring plane ±8°** (initial `q` axis-angle about z) — deliberate edge-catch throws.
- **Physics:** `stepRing` untouched (micro-substep count keys on |v| only, ≤8 at MAXV 4.6 — spin is free).
  Wobble exposure: raise `sleepN` → 20; play `scrape` on `slide` events so near-miss rims audibly grind.
- **Stats:** `{backPeg, maxStreak}`. **Tests (extend `ringtoss.test.mjs`):** `flickToLaunch clamps + monotone`.

### L6 SKEE-BALL (`games/skeeball.js` rework; cursor drag-flick) — M14
- **Keep** `findV` auto-tune (MINV/MAXV per tier) and the predicted-landing marker — they are the booth's core.
- **Input:** `setMode('cursor')`; **drag up** to roll. During DRAG the marker live-updates each substep via
  `rollFly(speed(dragLen), lateral(dragDX))`; on RELEASE commit `rollSpeed = clamp(FLICK_K·flickVY, MINV, MAXV)`,
  lateral `= clamp(dragDX·LATK, ±RAIL)`, `LATK=0.55`. Ribbon shown while dragging.
- **Stats:** `{hundos}`. **Tests (extend `skeeball.test.mjs`):** `ring aperture: descending center inside r−0.4·bR
  scores; tube band produces sphereTorus contact` (replicates game formula on pure fns).

## §5 ANCHOR SMASH — full spec (`games/anchor.js`, replaces High Striker) — M13

Side-view booth, cursor mode, `N_SMASH=5` attempts, **zero RNG in outcome** (pattern seed is logged; outcome is a
pure function of key/flick InputFrames).

- **Phase CHARGE (rhythm):** seeded pattern of `L` keys from {A,S,D,F} via `mulberry32(0xA7C4 ^ tier·2654435761)`,
  one key per beat. Beat grid is pure substep math: beat `i` at substep `i·round(3600/bpm)`. `hud.rhythm` shows the
  lane, current glyph highlighted; `tick` voice each beat, `clack` on hits. Correct key's `keyPress` bit within
  ±`win` substeps: `E += E_HIT·beatAcc(err,win)`; wrong key or missed beat: `E *= 0.85`. Flywheel mesh spin ∝ E;
  `hud.striker` meter = `E/E_MAX`, `E_MAX = L·E_HIT`.
- **Phase RELEASE (flick):** after the last beat a **90-substep capture window** opens (hammer hoisted). On the
  frame with `dphase===RELEASE` and `flickVY < −FLICK_MIN(0.4)`:
  `align = 1 − clamp(|flickVX|/|flickVY|, 0, 1)` (pure vertical = 1);
  `vf = FLICK_TO_V·min(−flickVY, VCAP=3.5)`, `FLICK_TO_V = 1.8` m/s per screen-height/s.
  No flick inside the window ⇒ limp release (`vf=0, align=0`).
- **Hammer track physics** — new pure solver (replaces deleted `railImpulse`/`railApex`):
  ```js
  // impact speed of a driven hammer down a track: ½mv² = ½mvf² + mgH(1−μ) + E
  export function trackImpact(vf, E, mH, H, mu, g = 9.81) {
    return Math.sqrt(vf*vf + 2*(g*(1-mu) + E/(mH*H))*H);
  }
  ```
  `H_TRACK = 3.2` m; flywheel energy dumped as constant drive force over the run; Coulomb `μ` opposes.
- **Scoring:** `VIMP_REF = trackImpact(FLICK_TO_V·VCAP, E_MAX, mH, H_TRACK, μ)` at create (perfect play);
  `power = min(vImp/VIMP_REF, 1)`; `mult = 1 + 2·align²` (1×–3×); `pts = round(400·power²·mult)`.
  Stats `{maxMult, crits: count(mult≥2.5), fullChain: every beat hit}`.
- **TIERS `[bpm, L, win, μ, mH, E_HIT]`:** `{92,6,6,0.02,10,120} / {102,7,5,0.03,11,115} / {112,8,4,0.04,12,110} /
  {122,9,3,0.05,13,105} / {132,10,2,0.06,14,100}`. T5 = 132 bpm, 2-substep window: frame-tight, honest.
- **Visuals/audio:** tower base + guide rails (highstriker dressing pattern), flywheel disc (spins with E), hammer
  block on an anim track during the run (visual integration of the same closed form), anvil at base;
  `fx.makeBurst` shockwave scaled by power; camera-shake kick (render-only). Voices: `tick`/`clack` (charge),
  `whoosh` (drop), `slam` (impact), `crowd` on mult≥2.5; `audio.ambientProfile('anchor')`.
- **Deletion checklist (blast radius, verified):** delete `src/games/highstriker.js` + `test/highstriker.test.mjs`;
  remove `railImpulse`/`railApex` from physics.js; swap main.js GAMES row to
  `{id:'anchor', label:'ANCHOR SMASH', tag:'RHYTHM · FLICK · IMPULSE', on:true, load:()=>import('./games/anchor.js')}`;
  rename `PROFILES.highstriker→anchor`. **Keep** `hud.striker/sweet/charge` meter + `thud`/`ding` voices (shared by
  other booths). Gate: `grep railImpulse src/ test/` returns nothing.
- **Tests (`test/anchor.test.mjs`):** `trackImpact: E=0 reduces to √(vf²+2g(1−μ)H)` · `trackImpact monotone in E
  and vf` · `alignment mult: vertical flick 3×, 45° flick 1×` · `rhythm energy: perfect chain reaches E_MAX
  exactly; a miss decays 0.85×` · `determinism: fixed beat-frame log + flick numbers → identical score twice`.

## §6 BASKETBALL rebuild (priority) (`games/basketball.js`) — M14

Cursor mode; fixed camera behind the line (`camera.position.set(0,1.75,0.8)`, lookAt rim); ball rests on a tee.
Today's failure mode (do not reintroduce): blind aim + thin 46-frame power band + power/arc/spin on one scalar.

### §6.1 Drag-to-arc (pure `dragToShot` in kinetics.js)
Press anywhere, pull **down**; live preview re-renders every substep from the current drag vector; release commits.
```js
// D=(dx,dy) NDC(+y up); pulling down => dy<0. Three independent hand dimensions:
export function dragToShot(dx, dy, cfg, out) {
  const pull = Math.min(Math.hypot(dx, dy), cfg.pullMax);            // LENGTH  -> power
  out.v0 = cfg.vMin + (cfg.vMax - cfg.vMin) * (pull / cfg.pullMax);
  const steep = Math.atan2(Math.max(-dy, 1e-6), Math.abs(dx));       // STEEPNESS -> arc
  out.th = clamp(steep, cfg.thMin, cfg.thMax);
  out.az = clamp(-dx * cfg.azK, -cfg.azMax, cfg.azMax);              // X -> lateral (mirrored slingshot)
  out.pull = pull; return out;
}
```
`SHOT_CFG = { pullMax:0.5, vMin:5.5, vMax:10.5, thMin:0.61 /*35°*/, thMax:1.22 /*70°*/, azK:0.35, azMax:0.15 }`.
Launch: `vx = v0·cosθ·sin(az)`, `vy = v0·sinθ`, `vz = −v0·cosθ·cos(az)`.

### §6.2 Wrist-flick release window
On drag release the shot enters an **18-substep wind-up** (ball animates into the pocket; launch at `n0+18`).
Pressing **Space** at frame f: `err = |f − (n0+18−LEAD)|`, `LEAD=2`; `q = wristQ(err, T.win)`. Effect (declared
control model, honest — never a hitbox/score fudge): backspin `ω = SPIN_MIN + (SPIN_MAX−SPIN_MIN)·q` about the
lateral ⟂-shot axis, `SPIN_MIN=8, SPIN_MAX=42` rad/s; no snap ⇒ weak floaty spin. `hud.charge` reused as the
wind-up bar with `sweet(1 − (T.win+LEAD)/18)`.

### §6.3 Pure flight + preview (skeeball `findV`/`rollFly` pattern)
New in physics.js — **sim and preview call the same function**:
```js
export function ballStep(p, v, w, k, cM, dt)   // one substep: G + quadratic drag k + Magnus cM·(w×v); integrate
export function tracePath(p0, v0, w0, k, cM, dt, nMax, yStop, out)  // full arc into flat out[]; returns point count
```
`step()` drives the live ball with `ballStep`; the preview calls `tracePath(…, nMax=150, yStop=0)` into a
preallocated Float32Array → `fx.makeTrajLine.set` — identical curve by construction. Recompute only while
`dphase===DRAG` and the drag vector changed. Preview does **not** simulate rim contacts (it predicts the throw,
not the bounce — honest). Cost ≤150 steps, trivial.

### §6.4 Retune
- Magnus folded into per-tier `cM` (delete `MAG`): target lift `a = cM·|ω×v| ≈ 0.9 m/s²` at ω=40, v=7 ⇒
  `cM ≈ 0.0032`. Snapped high-arc shots visibly float; limp shots don't.
- Fixed `RIM_E = 0.75`, `BOARD_E = 0.60` across tiers (user spec). Floor/net constants unchanged.
- **TIERS `[dist, rimR, kB, cM, win]`:**
  `{4.0,0.240,0.000,0.0032,8} / {4.6,0.232,0.002,0.0030,6} / {5.2,0.226,0.004,0.0028,4} /
   {5.8,0.220,0.007,0.0026,3} / {6.6,0.215,0.011,0.0024,2}`.
- **Scoring:** swish 150 / bank 120 (board-touch make) / make 100; streak ×(1+streak·0.15) retained; 10 shots.
  Stats `{makes, swishes, swishStreak, banks}`.
- **Tests (extend `basketball.test.mjs`):** `ballStep: backspin lifts apex 0.1–0.5 m vs no-spin` ·
  `tracePath ≡ ballStep loop (identical point sequence)` · `dragToShot: v0 monotone in pull; θ/az clamp` (imports
  kinetics) · `rim e=0.75 / board e=0.60 never gain energy` · existing determinism test retained.

## §7 Milestones (M11–M15 = user Milestones 1–5) — execute strictly in order

| M | Name | Scope | Gates (all must pass) |
|---|---|---|---|
| **M11** | Foundational Framework | `kinetics.js` · input.js rewrite + legacy shim · `store.js` · `fx.js` · engine `attachInput` · hud/index.html additions · main.js ctx.store + `end(result)` wrapper | `kinetics.test.mjs` (≈10) + `store.test.mjs` (≈8) green; **all existing suites still green via shim**; all 6 old games playable untouched; `?dev=1` F9/F10 record→replay on shooting T1 ⇒ identical score + frame hash; reload persists tickets |
| **M12** | Targeting & Throwing Suite | L1 Plinker overhaul · L3 wind + aeroPitch + Space-breath · L4 drag-flick | new `shooting.test.mjs` (4) + dart (+2) + ringtoss (+1) green; manual: scope zoom, breathe damps sway, plates hinge/fall/respawn, dart pitch-over visible, ribbon renders, A/D tilt works |
| **M13** | Kinetic Power Engine | delete highstriker (full §5 checklist) · `anchor.js` · slam/crowd/tick voices · rhythm HUD | `anchor.test.mjs` (5) green; `physics.test.mjs` green post-deletion; `grep railImpulse` empty; menu card swapped; T1 & T5 playable; alignment mult visible |
| **M14** | Heavy Physics Showcase | basketball rebuild (§6) · skee-ball drag-flick · **ring toss → §6 drag-to-arc + live-arc preview** (M12 flick model missed the Wii-Sports feel — playtest 2026-07-12) | basketball (+4) + skeeball (+2) green; preview curve lands where the ball lands (frozen-drag check); swish floats visibly with snap; marker tracks drag; **ring toss: pull-back aim + visible landing arc, throw reads as a throw** |
| **M15** | Master Certification | remove legacy input shim · migrate stragglers to frame API · persistence e2e · soak | full suite (~40) green; record/replay hash equality on **all 6** games; corrupt-save injection boots fresh (migrate test + manual); 10-min soak: heap delta <5 MB, 60 fps; trophies/toasts fire end-to-end; `grep pressQueue src/games` empty; handoff.md updated |

**Per-milestone verify loop (unchanged house rule):** `npm test` green → `npm run build` clean → `npm run dev`
boots → determinism replay-hash → perf (60 fps, no per-frame heap growth) → update `handoff.md`.

## §8 Model run-lists (execute within each milestone in the order listed)

**Opus-class — core mathematics & systems:**
1. M11: `kinetics.js` (estimator, drag FSM, snapshot, pack/hash) + `kinetics.test.mjs`; `store.js` (schema,
   migrate, ticket/trophy engine) + `store.test.mjs`; input.js determinism review.
2. M12: physics.js `hingeKick`/`hingeStep`/`aeroPitch` + tests; L1/L3/L4 mechanic cores (lane hit flow, torque
   scoring, flick mappings).
3. M13: `trackImpact` + rail-fn deletion; anchor mechanic core (beat grid, energy model, scoring) + tests.
4. M14: `ballStep`/`tracePath`; `dragToShot` + wrist window; basketball/skeeball retunes + tests.
5. M15: record/replay certification, soak analysis, shim removal review.

**Sonnet-class — UI/UX, graphics, audio:**
1. M11: hud.js + index.html surfaces (tickets/toast/ribbon/rhythm, CSS); `fx.js` burst + trajectory line.
2. M12: plinker plate rigs + lane dressing; dart pitch-over render; ringtoss ribbon feel; `scrape` voice.
3. M13: anchor booth visuals (flywheel/hammer/anvil/shockwave, camera kick); `slam`/`crowd`/`tick` voices;
   rhythm lane styling; `boothBackdrop` parallax layers (all booths).
4. M14: trajectory preview rendering, wind-up bar feel, net/rim polish; `ticket`/`chime` voices + trophy bursts.
5. M15: toast/banner polish, ambient `setTargetAtTime` ramps.

**Haiku/codegen-class — mechanical plumbing:**
1. M11: main.js wiring (ctx.store, end wrapper, attachInput, menu `setMode('cursor')`); index.html DOM stubs.
2. M12: `setMode` calls + `end(…, result)` migration in shooting/dart/ringtoss; TIERS table entry.
3. M13: GAMES row swap, file deletions, `PROFILES` rename, test file removal.
4. M14: basketball/skeeball `end(result)` + `setMode` migration.
5. M15: legacy shim removal (grep-gated), doc sync (handoff.md, this file's Status), dead-constant sweep.

## §9 Risk register

1. **Flick determinism** — wall-clock lives only capture-side; flick floats pre-computed into the substep
   InputFrame; replay = frame log; enforced by M11/M15 record-replay hash gates.
2. **Pointer-lock↔cursor transitions** — async lock exit + phantom edges; mitigated by `SWALLOW=8` edge
   suppression + drag-machine reset on any lock/mode change; menu always resets to cursor mode.
3. **stepRing cost with flick spin** — micro-substeps bound on linear speed only (≤8 at MAXV 4.6); spin adds zero
   micro cost; keep MAXV ≤ 4.6.
4. **Preview per-frame cost** — 150-step `tracePath` is trivial; recompute only during DRAG on vector change;
   geometry written once per render.
5. **localStorage schema migration** — single versioned key; `migrate()` swallows junk → defaults (test-enforced,
   never throws); null backend → in-memory (private mode).
6. **Legacy-shim window** — old games must keep working M11–M14; shim synthesized from the same event stream;
   deleted only at M15 behind the grep gate.
7. **Browser key theft** — `preventDefault` on mapped codes (Space/arrows) while HUD active only; never on menu.

## Status
- [x] M0–M10 (plan v1): scaffold, core, physics kernel, audio/materials, all 6 booths, polish pass — **done**;
      28/28 tests, 33-module build. Live detail: `handoff.md`.
- [x] **M11-plan** — this blueprint authored & user-approved (2026-07-11).
- [x] **M11 Foundational Framework** — `kinetics.js`/`store.js`/`fx.js` built, `input.js` rewritten (shim intact),
      engine/hud/index.html/main.js wired; 50/50 tests, 35-module build, `?dev=1` record/replay harness. **Playtest passed** (user-confirmed 2026-07-11).
- [x] **M12 Targeting & Throwing Suite** — physics.js `hingeKick`/`hingeStep`/`aeroPitch`; L1 TARGET PLINKER
      (z-lanes + hinged torque plates + Space-breath, first frame-API booth), L3 dart crosswind + aeroPitch tip-lag +
      Space-breath, L4 ring toss cursor drag-flick + A/D tilt + scrape; `audio.scrape`; main.js label swap.
      57/57 tests (new `shooting.test.mjs` 4 + dart +2 + ringtoss +1), clean 35-module build, dev boots.
      **Played well, user-approved.**
- [x] **M12.5 Polish & Pacing pass** (feel/juice, render-only) — `fx.makeBurst` wired into all 3 M12 booths (dart's
      hand-rolled shard pool deleted → shared burst, plan §3.3); render-only impact camera kick (plinker/dart re-derive
      from clean base each render, ringtoss pivots off `camQ0` — none touch input/scoring, replay hash intact); ring toss
      pacing (new pure `ringSettle` early-capture + timeout 6→3.5 + sleepN 20→16); dart pacing (`N_DARTS` 25→18, low-tier
      v nudge) + legible fishtail (render-only `FISHTAIL_GAIN` exaggerates φ-lag, pop test stays true-φ); plinker hit-spark
      vs knockdown burst + round timers −15%. **58/58 tests** (+`ringSettle`), clean **36-module** build (fx now a shared
      chunk), dev boots. ◄ AWAITING PLAYTEST before M13.
- **Playtest 2026-07-12 (M12.5):** user verdict — **ring toss + basketball "not working anything like a sports
  simulation game like Wii Sports."** Root cause: basketball is still the pre-kinetic meter-and-click model (blind
  pointer-lock aim + thin power-timing bar — rebuild queued §6/M14); ring toss's M12 drag-flick is abstract (no ring
  to grab, **no trajectory preview**, gesture split flick→speed+az / drag-steepness→arc). The Wii-Sports lever both
  need = **pull-back-to-aim + a LIVE trajectory arc + a weighty throw into depth** (the §6 `dragToShot`+`tracePath`
  model, already user-approved for basketball). **Decision: stay on roadmap** (M13 next), but **M14 scope now also
  brings RING TOSS onto the §6 drag-to-arc + live-arc-preview model** (the M12 flick model is superseded; ring toss
  center-parabola preview via `integrate`→`fx.makeTrajLine`, peg bounces not previewed — honest, like §6.3).
- [x] **M13 Kinetic Power Engine** — **High Striker deleted** (`highstriker.js`/`.test`, `railImpulse`/`railApex`,
      `PROFILES.highstriker` — both grep gates empty) → **ANCHOR SMASH** (`games/anchor.js`): seeded A/S/D/F
      rhythm-charge (flywheel energy `E`, `beatAcc` timing) + downward wrist-flick release; new pure
      `physics.trackImpact` + `H_TRACK=3.2`; `power`/alignment-`mult`(1×–3×)/`pts` scoring; cursor mode, 5 smashes,
      zero-RNG outcome; `tick`/`slam`/`crowd` voices, `PROFILES.anchor`, ramped `ambientProfile`, render-only camera
      kick + flywheel/hammer/shockwave visuals; menu card swapped. `test/anchor.test.mjs` (5). **59/59 tests**, clean
      **36-module** build, dev boots. ◄ AWAITING PLAYTEST.
- [ ] **M14 Heavy Physics Showcase** ◄ next — basketball rebuild (§6) · skee-ball drag-flick · ring toss → §6
      drag-to-arc + live-arc preview (Wii-Sports feel fix) · then M15 per §7.
