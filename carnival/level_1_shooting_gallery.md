# Level 1 — Shooting Gallery (Rifle)

**Skill:** lead moving targets while compensating for bullet drop + wind drift.
**Input:** mouse aim (pointer-lock), LMB fire, scoped zoom RMB. Rifle = slow bullet (visible travel), not hit-scan.

## Physics
- Bullet: pooled sphere, ballistic. `v += (g + drag)*dt; p += v*dt`, `dt=1/60`.
- Gravity `g=(0,-9.81,0)`. Drop over range creates hold-over skill.
- Wind: constant lateral `w`; drag `F=-k·(v-w)·|v-w|` (crosswind pushes bullet). `k` = dragCoef.
- Muzzle speed `vMuzzle` along camera forward. Hit = swept segment (prev→cur bullet pos) vs target sphere/plate each substep (no tunneling).
- Targets: plates on rails, sinusoidal lateral motion `x=A·sin(ωt+φ)`, deterministic (φ seeded).

## Scoring
- Ring value by radial hit error: bull `≤rBull`→100, mid→50, outer→25, edge→10, miss→0.
- Combo multiplier ×(1+0.1·streak). Timer per round. No luck: value purely = impact radius.

## 5 Tiers (variables)
| Tier | vMuzzle (m/s) | dragCoef k | wind w (m/s) | target R (m) | target speed A·ω | rBull (m) | round s |
|---|---|---|---|---|---|---|---|
| 1 | 120 | 0.0 | 0 | 0.40 | 0 (static) | 0.12 | 60 |
| 2 | 110 | 0.004 | ±1.0 gust | 0.32 | 0.6 | 0.09 | 50 |
| 3 | 100 | 0.008 | ±2.5 shift | 0.24 | 1.2 | 0.06 | 45 |
| 4 | 92  | 0.014 | ±4.0 shift | 0.18 | 2.0 | 0.045 | 40 |
| 5 | 85  | 0.020 | ±6.0 swirl | 0.12 | 3.2 | **0.03** | 35 |

- **Gusts:** wind steps on a seeded schedule (value+time known, not random-per-shot). T5 swirl = slow rotating wind vector.
- **T5 limit-push:** razor `rBull=3cm` at range + heavy drop + high crosswind + fast small targets. Solvable with correct hold-over; unforgiving of error.

## Visuals (uncanny)
- Booth: hyper-real worn wood + peeling paint (procedural), plates slightly ovoid (skew). Fluorescent white key, sickly-green neon trim. Hard shadows on back wall.
- Reticle: thin clinical crosshair; scope = vignette + slight CA.

## Audio (tunnel vision)
- Ambient midway drone → LP ~400Hz, low gain.
- Crisp SFX (dry, spatial): rifle crack (bright transient + tail), bullet whistle (panned along flight), plate `ping`/`clang` at hit pos, wind gust hiss rising with |w|.

## Determinism check
- Fixed input log (aim angles + fire times) → identical hit ring sequence + score hash across runs.
- Unit: bullet drop at range matches `y0 - ½g t²` within eps (k=0).

## Reuse
`physics.integrate`, `sweptSphereSeg` hit, pool bullets, InstancedMesh plates, `tiers.applyTier`, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`.
