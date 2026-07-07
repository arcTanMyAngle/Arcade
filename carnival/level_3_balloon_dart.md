# Level 3 — Balloon Dart Gallery (FPS Sniper)

**Skill:** precise trajectory mapping — pop small balloons with a gravity-affected dart; thin hitboxes reward exact aim.
**Input:** pointer-lock aim, RMB scope (zoom + steadied sway), LMB throw. Dart = slow projectile arc (not hit-scan), so hold-over + lead matter.

## Physics
- Dart: pointed projectile, mass `mD`, ballistic `v += (g+drag)*dt; p += v*dt`. Light drag `kD`.
- Throw speed `vThrow` along aim; arc drop scales with distance → skill.
- **Hitbox = balloon sphere** radius `rB` (thin margin — dart tip must enter). Swept segment (prev→cur tip) vs balloon sphere per substep. Pop only if tip crosses surface, not body-overlap fudge.
- Balloons: grid on a board, some **drifting** laterally (seeded sine) at higher tiers; some behind cutouts (partial exposure) → true thin hitbox.
- **Scope sway:** deterministic Lissajous sway (seeded), reduced by "hold breath" (LMB-hold steadies, drains a meter). Breath = the crisp isolated audio cue.

## Scoring
- Pop = base × sizeBonus (smaller balloon = more). Chain bonus for consecutive pops. Cluster pops (dart clips two thin balloons) = combo.

## 5 Tiers (variables)
| Tier | vThrow (m/s) | kD drag | rB (m) | drift A·ω | sway amp | breath drain | exposure |
|---|---|---|---|---|---|---|---|
| 1 | 30 | 0.0 | 0.20 | 0 | 0.2° | slow | full |
| 2 | 27 | 0.003 | 0.15 | 0.4 | 0.5° | med | full |
| 3 | 24 | 0.006 | 0.11 | 0.9 | 0.9° | med | 70% |
| 4 | 21 | 0.010 | 0.08 | 1.6 | 1.4° | fast | 50% |
| 5 | 18 | 0.016 | **0.05** | 2.6 | 2.2° | **fast** | **35% (cutouts)** |

- **T5 limit-push:** 5cm balloons, only ~35% exposed behind cutouts, heavy arc drop, fast drift, aggressive sway with punishing breath drain. Demands perfect trajectory + timing the steady window.

## Visuals (uncanny)
- Balloons: hyper-real latex sheen, slightly egg-shaped / uneven inflation (skew), packed too regularly. Off-color neon backboard, clinical white key, hard shadows. Popped balloon = crisp shard burst (pooled particles), leaves wrinkled skin.
- Scope: vignette + faint CA + subtle lens breathing.

## Audio (tunnel vision)
- Ambient → LP muffled.
- Crisp spatial SFX: **breath** (band-passed noise, in/out, isolated) while steadying, dart whoosh (panned along arc), **balloon pop** (short bright transient + rubber snap) at pop position, near-miss thock on board.

## Determinism check
- Fixed aim/throw/breath log → identical pop set + score.
- Unit: dart apex/range matches closed-form for given `vThrow`,angle (kD=0).

## Reuse
`physics.integrate`, `sweptSphereSeg`, pool darts, InstancedMesh balloons, seeded `mulberry32` drift/sway, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`.
