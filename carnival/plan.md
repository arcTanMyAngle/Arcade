# Uncanny Carnival — Master Plan

**Type:** browser 3D carnival skill-suite · Three.js (WebGL) · Vite/npm · custom deterministic physics · Web Audio.
**Philosophy:** true skill > rigged. Deterministic, zero-RNG-rigging. Every miss is the player's, every make earned.

## Non-negotiable invariants
- **Fixed 60Hz physics substep.** Render decoupled + interpolated. Same inputs → identical outcome.
- **Zero `Math.random` in any physics/scoring path.** Variation = seeded PRNG (`mulberry32`), documented per game.
- **One runtime dep: `three`.** No physics/audio libs. All SFX synthesized, all textures procedural.
- **Reuse core; per-game files hold only game logic.** No copy-paste physics.
- **Token-dense docs, short vars, comment only the math.**

## Milestones
| # | Name | Scope | DoD |
|---|---|---|---|
| **M0** | Scaffold | Vite, `three`, dir tree, empty core stubs, menu shell | `npm run dev` serves blank menu |
| **M1** | Core engine | `engine`+`loop` fixed-step, `input`, `hud`, resize, pooling | spinning test cube, 60fps, HUD |
| **M2** | Physics kernel | `physics.js` integrators + collision solvers + PRNG + headless tests | `node` test asserts drop/collision |
| **M3** | Audio + materials | LP ambient bus, spatial crisp SFX bus, uncanny PBR + clinical lights | muffled bed + crisp panned ping |
| **M4** | **Level 1 Shooting Gallery** | full game + 5 tiers, scoring, wind, targets | playable T1–T5, deterministic |
| **M5** | Level 2 High Striker | mallet impulse, rail, power window | playable, 5 tiers |
| **M6** | Level 3 Balloon Dart | sniper trajectory, thin hitboxes | playable, 5 tiers |
| **M7** | Level 4 Ring Toss | swept torus↔peg, friction/restitution | playable, no tunneling T5 |
| **M8** | Level 5 Basketball | arc, rim, backspin | playable, 5 tiers |
| **M9** | Level 6 Skee-Ball | incline, rolling friction, lip-jump | playable, 5 tiers |
| **M10** | Polish | post FX flag, ghost/replay, persistence, perf pass | 60fps all games |

**Gate:** after M4 (Level 1) → human playtest before M5+. After each level → determinism + perf check.

## Model allocation (brief intent; current models)
- **Sonnet-class** → Three.js render, WebGL/shaders, physics kernel, loop optimization.
- **Opus-class** → aesthetic/uncanny shader concepts, narrative, these markdown docs.
- **Haiku-class** → boilerplate config, mechanical refactors.
- Legacy 3.5/3.7·3-Opus·3-Haiku in brief are superseded (Opus 4.8 / Sonnet 5 / Haiku 4.5). Intent preserved; all work executed by one agent.

## Dir tree
```
carnival/
  index.html  package.json  vite.config.js
  src/
    main.js                     # menu router + lifecycle
    core/ engine loop input physics audio materials hud tiers .js
    games/ shooting highstriker dart ringtoss basketball skeeball .js
  test/ physics.test.mjs        # headless determinism/solver asserts
  *.md                          # this + handoff/skills/claude/level_*
```

## Verification (per level)
1. `npm run dev` → menu → level loads, playable.
2. Determinism: replay fixed input log → identical score/trajectory hash.
3. Physics sanity vs closed form (drop `y=y0+v0t-½gt²`; no tunneling T5).
4. Audio: ambient muffled; crisp SFX panned to emitter.
5. Perf: 60fps, no per-frame heap growth (instanced props, pooled projectiles).

## Status
- [x] Architecture + all Phase-1/2 docs approved
- [x] **M0** scaffold · **M1** core engine · **M2** physics kernel (6/6 tests) · **M3** audio+materials
- [x] **M4 Level 1 Shooting Gallery** — built, 5 tiers, **playtested & approved** in-browser
- [ ] **M5 Level 2 High Striker** ◄ next · then M6–M9 (dart, ring toss, basketball, skee-ball) · M10 polish
- See `handoff.md` for live state + the "Adding a game" pattern.
