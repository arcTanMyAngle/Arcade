# Next Session — Resume Prompt (Uncanny Carnival)

Paste the block below to start the next session.

---

Act as Principal Game Engine Architect. Max token efficiency: no filler, short vars, comment only the math. Continue the **Uncanny Carnival** project.

**Where:** `Arcade/carnival/` (Vite + npm, single runtime dep `three`). This is SEPARATE from the Rust kart game at `Arcade/` root — never touch root `plan.md`/`handoff.md`/`src/*.rs`.

**Read first:** `carnival/handoff.md` (live state + "Adding a game" pattern + Level 2 build notes), `carnival/claude.md` (self-rules), `carnival/level_2_high_striker.md` (tier tables + physics).

**Done:** M0–M4 — shared core (`src/core/`: engine, loop@60Hz fixed-step, input pointer-lock, physics [pure/node-tested], audio, materials, hud, tiers) + `src/games/shooting.js` (Level 1, all 5 tiers). 6/6 headless tests pass, clean build, Level 1 playtested & approved.

**Task this session: implement M5 = Level 2 High Striker** per `level_2_high_striker.md`, reusing the core:
- `games/highstriker.js` exports `create(ctx)` → `{ step, render, teardown }`.
- Charge (hold LMB) + release-timing vs sweet-spot window → mallet head speed `sH`; impulse
  `Δv=(1+e)·mH/(mH+mP)·sH`; puck 1-D up rail vs `g+μg`; peak `H=v0²/(2(g+μg))`; win if `H≥bellHeight`.
- Add hold+release events to `core/input.js` (currently edge-fire only); charge/timing bar to `hud.js`;
  mallet-thud + bell-ding voices to `core/audio.js`.
- Wire it into `src/main.js` GAMES (`on:true` + `load:()=>import('./games/highstriker.js')`).
- Add ≥1 headless test in `test/` asserting `H=v0²/(2(g+μg))` matches the sim, plus determinism.

**Invariants (hard):** fixed 60Hz step; **no `Math.random` in `step`** (seed via `mulberry32`);
`physics.js` imports nothing; pool/instance props; true skill > rigged (honest physics only).
**Aesthetic:** weaponized uncanny valley (hyper-real PBR on slightly-wrong geo, clinical white +
off-color neon, hard shadows). **Audio:** muffled LP ambient bed + dry crisp spatial SFX.

**Verify:** `cd carnival && npm test` (green), `npm run build` (clean), `npm run dev` (boots) →
then pause for human playtest before Level 3. Update `carnival/handoff.md` at the end.

---

## Quick reference
- Run: `cd carnival && npm run dev` → click a lit booth → pick tier → click canvas to pointer-lock.
- Test: `npm test` · Build: `npm run build`.
- Remaining after L2: Level 3 Balloon Dart, Level 4 Ring Toss (hardest — swept torus↔peg),
  Level 5 Basketball, Level 6 Skee-Ball, then M10 polish. Blueprints in `level_*.md`.
