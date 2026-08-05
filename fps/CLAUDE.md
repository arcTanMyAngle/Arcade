# BREACHPOINT — self-instructions (fps/)

Fifth project in the Arcade repo. **Scope: `Arcade/fps/` only.** Never touch root
`plan.md`/`handoff.md`/`src/*.rs` (Wii Kart), `carnival/`, or `galaga/`.

Goal: a Three.js FPS pushed to the ceiling of what browser 3D can do — CoD-tier
*technique and feel*. We will not match CoD asset density; we can match its
rendering pipeline, movement values, and weapon feel.

## Hard rules (inherited from repo CLAUDE.md)
- **Procedural assets only.** No binary art or audio files, ever. Textures are
  synthesized in `render/materials.js`; audio is Web Audio synthesis.
- **Deterministic sim.** Fixed 128 Hz tick (`core/loop.js`). No `Math.random`, no
  wall-clock, no frame-rate coupling in any sim/scoring path. Seeded
  `mulberry32` only. Sim reads input ONLY via the per-tick `InputFrame`.
- **Honest physics.** Never fudge hitboxes, spread, or damage to flatter the player.
- Token-dense code, short vars (`v`,`p`,`dt`,`n`), comment only non-obvious math.
- Pool everything. No per-frame heap growth. Dispose on teardown.

## Module contract — DO NOT CHANGE THESE SIGNATURES
`src/main.js` is the integration root and is owned by the lead only. Subsystems
**must not import each other**; they talk through `ctx` handles + the event bus.

```
createMaterialLibrary({ renderer, rng })      -> { get(name), env, sunDir, list(), dispose() }
createSky({ scene, sunDir })                  -> { update(camera), uniforms, dispose() }
createLighting({ scene, sunDir, quality })    -> { sun, hemi, update(targetVec3), dispose() }
createLevel({ scene, rng, mats })             -> { collide(p,r,h), raycast(o,d,max), brushes, spawns, poses, step(dt), dispose() }
createPipeline({ rc, scene, quality })        -> { render(alpha), resize(w,h), params, dispose() }
createPlayer({ level, camera, bus, rng })     -> { step(dt,frame), pose(alpha), state, teleport(p,yaw,pitch), dispose() }
createWeapons({ scene, camera, bus, rng, player, level }) -> { step(dt,frame), render(alpha), state, setState(), dispose() }
createFX({ scene, camera, bus, rng, mats })   -> { step(dt), render(alpha), dispose() }
createAI({ scene, level, bus, rng, player })  -> { step(dt), agents, dispose() }
createAudio({ bus, camera })                  -> { step(dt), resume(), dispose() }
createHUD({ root, bus })                      -> { step(dt, ctx), dispose() }
```

If you genuinely need a `main.js` change, **do not edit it** — state the required
change in your final report and the lead will apply it.

## File ownership (strict — never edit another agent's files)
| Area | Files |
|---|---|
| render/post | `src/render/pipeline.js`, `renderer.js`, `sky.js`, `lighting.js`, `src/render/passes/**` |
| materials | `src/render/materials.js`, `src/render/textures.js` |
| level | `src/world/**` |
| weapons | `src/weapons/**` |
| player feel | `src/player/**` |
| fx | `src/fx/**` |
| ai | `src/ai/**` |
| audio | `src/audio/**` |
| hud | `src/ui/**` |
| shared core | `src/core/**` — read-only for agents; request changes via report |

## Event bus vocabulary
Emitters own their names. Existing: `player:jump`, `player:land`, `player:footstep`.
Weapons should emit `weapon:fire`, `weapon:reload`, `weapon:impact`, `weapon:shell`.
AI: `ai:hit`, `ai:death`, `ai:fire`. Consumers must tolerate unknown fields.

## Verify your work — required before reporting done
```
npx vite build                                   # must succeed
node tools/capture.mjs --out shots/<yourname> --shots hero,overlook --w 1280 --h 720
```
Capture runs headless Chromium on SwiftShader (software GL). It is SLOW (minutes)
and exits non-zero on any page error. **Look at the PNGs you produced** — read them
back with the Read tool. A build that compiles but renders a black screen is a
failure. `perf.json` next to the shots has draw calls / triangle counts.

Add new named camera poses to `level.poses` (level agent) if you need a specific
framing to review your work.

## Perf gates
60 fps at 1080p on integrated GPU hardware, `q=high`. Budget: < 900 draw calls,
< 1.6 M triangles. Software-GL capture fps is meaningless — judge cost by draw
calls, triangle count, and pass count, not by the headless fps number.
