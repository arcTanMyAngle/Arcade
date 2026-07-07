# Level 6 — Skee-Ball

**Skill:** meter a roll up the lane so the ball climbs the ramp, launches off the lip, and
drops into a scoring ring. Incline physics + rolling friction + lip-jump trajectory.
**Input:** swipe-flick up the lane (length/speed = launch speed; small lateral = aim). Optional power meter.

## Geometry (lane)
- Flat run → **incline ramp** (angle `θ`) → **lip** (small step at ramp top) → gap → **target plane** with concentric scoring **rings** (holes) at heights: 10 (front) … 100 (back corners).
- Ball = sphere `bR`, mass `m`. Side rails constrain lateral (soft walls, restitution `eW`).

## Physics (custom, deterministic)
- **Rolling on flat/ramp:** `sphereIncline` — along-surface accel `a = -g·sinθ - μr·g·cosθ` (μr = rolling friction). Normal `N = m·g·cosθ`. Ball decelerates climbing.
- **Lip-jump (the edge-case):** ball leaves the surface when normal force `N ≤ 0` (crest of lip) →
  becomes projectile: `integrate(ball, g, dt)`. Launch angle ≈ ramp `θ`; launch speed = speed at
  lip. **This parabola is the whole skill** — too slow → falls short (low ring), too fast → overshoots.
- **Ring landing:** ball must drop into a ring aperture — sphere center passes the target plane
  inside ring radius `ringR[i]` with downward `v`. Rims = `sphereTorus` bounce (`e`) → can rattle
  out or funnel in. Back corner 100-holes need a **precise** apex + lateral.
- Rolling friction bleeds energy on the flat before the ramp too — full-lane skill.
- Deterministic: outcome = pure function of (launch speed, lateral). No random.

## Scoring
- Ring value by where it drops: 10/20/30/40/50, back corners 100. Combo for consecutive high rings; "hundo" streak bonus.

## 5 Tiers (variables)
| Tier | ramp θ | rolling μr | lip height (m) | flat μr | ring radii scale | 100-hole aperture | rail eW |
|---|---|---|---|---|---|---|---|
| 1 | 26° | 0.020 | 0.02 | 0.015 | 1.00 | wide | 0.3 |
| 2 | 29° | 0.024 | 0.03 | 0.018 | 0.92 | open | 0.3 |
| 3 | 32° | 0.028 | 0.04 | 0.022 | 0.84 | med | 0.35 |
| 4 | 35° | 0.033 | 0.05 | 0.026 | 0.76 | tight | 0.4 |
| 5 | 38° | 0.040 | 0.06 | 0.030 | **0.68** | **razor** | 0.45 |

- Steeper ramp + higher friction = narrower speed band that clears the lip cleanly; smaller
  rings + higher lip demand a precise launch parabola; bouncier rails punish sloppy lateral.
- **T5 limit-push:** razor 100-apertures, steep high-friction ramp, tall lip → only a tightly
  metered launch speed + exact lateral lands the corner hole. Physically solvable, extremely strict.

## Visuals (uncanny)
- Lane: hyper-real worn maple + lacquer, rings too perfectly round yet faintly warped (skew),
  numerals off-font. Clinical overhead white + sickly-green neon ring outlines, hard shadows.
  Ball roll spin visualized (`ω` from surface speed).

## Audio (tunnel vision)
- Ambient arcade → LP muffled.
- Crisp spatial SFX: **roll rumble** (low filtered noise, pitch by speed, panned along lane),
  **lip launch** tick, air whoosh mid-jump, **drop thunk** into ring at landing point, rim
  rattle (torus bounce), 100-hole = bright chime.

## Determinism check
- Fixed (launchSpeed, lateral) → identical landing ring every run.
- Unit: lip-launch speed vs energy `½mv0² − mg·Δh − friction·work` matches; parabola range from lip matches closed-form for that speed/θ.

## Reuse
`physics.integrate`, `sphereIncline` (+lip launch), `sphereTorus` (ring rims), `spherePlane`,
rail impulse, pooled ball, InstancedMesh rings, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`.
