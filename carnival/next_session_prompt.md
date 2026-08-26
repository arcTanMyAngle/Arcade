# Next Session — Resume Prompt (Uncanny Carnival)

Paste the block below to start the next session.

---

Act as Principal Game Engine Architect. Max token efficiency: no filler, short vars, comment only the math. Continue the **Uncanny Carnival** project. This session = **M13 Kinetic Power Engine**: delete High Striker, build **ANCHOR SMASH** per plan §5. ONE milestone, executed in §8 order (Opus core math → Sonnet visuals/audio → Haiku plumbing); implement → determinism check → perf check → tests+build ONCE at the end → update handoff → **stop for user playtest**. Do not gold-plate; do not start M14.

**Where:** `Arcade/carnival/` (Vite + npm, single runtime dep `three`). SEPARATE from the root Rust kart game — never touch root `plan.md`/`handoff.md`/`src/*.rs`.

**Read first, in order:** `carnival/claude.md` (self-rules) → `carnival/plan.md` **§5 (full Anchor Smash spec), §3.3 (audio/fx/hud/decor surfaces), §7 M13 row (gates), §8 run-lists** → `carnival/handoff.md` (live state — read the **M12.5 as-built** section AND the **⚠ playtest-feedback block**).

**State:** M0–M12 + **M12.5 polish** done. **58/58 tests**, clean **36-module** build, dev boots. L1 Plinker / L3 Dart / L4 Ring Toss are on the kinetic layer (read only `input.frame`). **L2 High Striker (delete target)**, L5 Basketball, L6 Skee-Ball still run on the legacy shim. **Reusable primitives already built — do not re-invent:** `kinetics.beatAcc`/`wristQ` (timing kernel), `flickToLaunch`, `DPHASE`/`K`/`KEYMAP`, `packFrame`/`hashFrames`; `hud.rhythm(seq,idx,hot)`; `fx.makeBurst` (wired into 3 booths in M12.5); the **render-only camera-kick pattern** (save the clean base in `step`, re-derive the wobble in `render` — copy it verbatim from shooting/dart/ringtoss; it must never touch input/scoring so the replay hash holds).

**Task — build ANCHOR SMASH (`games/anchor.js`), replaces High Striker (§5).** Side-view booth, **cursor mode**, `N_SMASH=5` attempts, **zero RNG in outcome** (the L-key pattern seed is logged; the score is a pure fn of key/flick InputFrames). Two phases:
1. **CHARGE (rhythm):** seeded pattern of `L` keys from {A,S,D,F} via `mulberry32(0xA7C4 ^ tier·2654435761)`, one key/beat; beat `i` at substep `i·round(3600/bpm)` (pure substep math, no wall-clock). `hud.rhythm` shows the lane (current glyph hot); `tick` each beat, `clack` on a hit. Correct key's `keyPress` bit within ±`win` substeps ⇒ `E += E_HIT·beatAcc(err,win)`; wrong key or missed beat ⇒ `E *= 0.85`. Flywheel spins ∝ E; `hud.striker` = `E/E_MAX`, `E_MAX = L·E_HIT`.
2. **RELEASE (flick):** after the last beat a **90-substep** capture window opens (hammer hoisted). On the frame with `dphase===RELEASE` & `flickVY < −0.4`: `align = 1 − clamp(|flickVX|/|flickVY|,0,1)` (pure vertical = 1); `vf = 1.8·min(−flickVY, 3.5)`. No flick in the window ⇒ limp release (`vf=0, align=0`).

**New pure solver + rail deletion (physics.js):** `export function trackImpact(vf,E,mH,H,mu,g=9.81){ return Math.sqrt(vf*vf + 2*(g*(1-mu)+E/(mH*H))*H); }`, `H_TRACK=3.2`. **Delete `railImpulse`/`railApex`** (High Striker's). Scoring: `VIMP_REF = trackImpact(1.8*3.5, E_MAX, mH, H_TRACK, μ)` at create (perfect play); `power = min(vImp/VIMP_REF, 1)`; `mult = 1 + 2·align²` (1×–3×); `pts = round(400·power²·mult)`. Stats `{maxMult, crits: count(mult≥2.5), fullChain: every beat hit}`.

**TIERS `[bpm, L, win, μ, mH, E_HIT]`:** `{92,6,6,0.02,10,120}/{102,7,5,0.03,11,115}/{112,8,4,0.04,12,110}/{122,9,3,0.05,13,105}/{132,10,2,0.06,14,100}` (T5 = 132 bpm, 2-substep window — frame-tight, honest).

**Visuals/audio (Sonnet-class):** tower base + guide rails (reuse High Striker's dressing pattern), flywheel disc (spins with E), hammer block on an anim track down the run (visual integration of the same closed form), anvil at base; `fx.makeBurst` shockwave scaled by `power`; **render-only camera kick** (reuse M12.5's pattern). New voices: `slam` (sub sine 55→28 Hz + noise crack + 1.2 s inharmonic ring), `crowd` (3 band-passed noise swells, 1.4 s rise), `tick` (2 ms dry click); `whoosh` on drop; `crowd` on mult≥2.5. **KEEP** `hud.striker/sweet/charge` + `thud`/`ding` (shared by other booths). `PROFILES`: delete `highstriker`, add `anchor:[320,0.20,41]`; `audio.ambientProfile('anchor')` (ramp via `setTargetAtTime`). *(Lower priority / defer if time-boxed: `decor.boothBackdrop` parallax layers.)*

**Feel bar = Wii Sports (user's standing note — the throw booths flagged M12.5).** Anchor's smash is itself a sports gesture: make the vertical **flick read as a real hammer swing** — flywheel spin-up during charge, hammer hoist during the capture window, a heavy `slam` + shockwave + camera kick scaled by `power` on impact, and the alignment mult visibly rewarding a clean vertical snap. Restraint = uncanny; juice serves dread, not cheer.

**Deletion checklist (blast radius verified in §5):** delete `src/games/highstriker.js` + `test/highstriker.test.mjs`; remove `railImpulse`/`railApex` from physics.js; swap `main.js` GAMES row to `{id:'anchor', label:'ANCHOR SMASH', tag:'RHYTHM · FLICK · IMPULSE', on:true, load:()=>import('./games/anchor.js')}`; rename `PROFILES.highstriker→anchor`. **Gate: `grep -r railImpulse src/ test/` and `grep -r highstriker src/ test/` both return nothing.**

**Tests (`test/anchor.test.mjs`, ~5):** `trackImpact: E=0 ⇒ √(vf²+2g(1−μ)H)` · `trackImpact monotone in E and vf` · `alignment mult: vertical flick 3×, 45° flick 1×` · `rhythm energy: perfect chain reaches E_MAX exactly; a miss decays 0.85×` · `determinism: fixed beat-frame log + flick numbers → identical score twice`.

**Gates (all before ending):** `npm test` green — new `anchor.test.mjs` (5) + all existing suites (physics.test green **after** the rail-fn deletion; the removed `highstriker.test.mjs` drops its count — don't assert a fixed total, just: everything green); `npm run build` clean; `npm run dev` boots; both greps empty; menu card swapped; **T1 & T5 playable, alignment mult visibly 1×–3×**; `?dev=1` F9/F10 on Anchor T1 ⇒ identical score + frame hash (beat-frame + flick log replays identically — the determinism cert). Then update `carnival/handoff.md` (new as-built + changelog) + tick `plan.md §Status`, and **stop for user playtest before M14**.

**Invariants (hard):** fixed 60 Hz step; physics/scoring read **only** `input.frame` (no DOM events/wall-clock/raw deltas); **no `Math.random` in any step/scoring path** — pattern seed logged, outcome a pure fn of key/flick frames; fx bursts spawn from the booth's seeded `mulberry32`; camera kick is render-only; `physics.js`/`kinetics.js`/`store.js` import nothing; one dep `three`; pool/instance/dispose. **Honest difficulty** = tune constants, never hitboxes/scores. **Aesthetic:** weaponized uncanny valley (clinical key + sickly neon, `uncannySkew`, lowpassed ambient). **Audio:** muffled LP bed + dry crisp spatial SFX, 100% synthesized. **Do not** touch L1/L3/L4 (M12.5-tuned — keep them green), L5/L6, or start M14.

---

## Quick reference
- Run: `cd carnival && npm run dev` → ANCHOR SMASH → tier. Test: `npm test` · Build: `npm run build`.
- `?dev=1` → F9 record / F10 replay a round (prints score + frame hash) — the determinism cert.
- **Deferred to M14 (do NOT touch this session):** the Wii-Sports throw rebuild — basketball §6 drag-to-arc + live `tracePath` preview, skee-ball drag-flick, **AND ring toss onto the same drag-to-arc + live-arc model** (its M12 flick model missed the feel; roadmap adjusted — see plan §7 M14 row + Status + the `carnival-throwing-feel` memory). Also revisit the M12.5 ring-toss camera kick then.
- Roadmap after M13: **M14** heavy-physics throw feel (above) → **M15** shim removal + persistence e2e + replay-hash cert on all 6 + soak (gates in §7, run-lists in §8).
