# Level 2 — High Striker (Mallet)

**Skill:** time + power a mallet swing to transfer max impulse into the puck; hit the bell.
**Input:** hold LMB to wind up (charge), release to swing; mouse down-flick governs swing arc/timing. Optional timing bar for a "sweet-spot" contact frame.

## Physics
- **Mallet head** = mass `mH`, reaches contact speed `sH` from charge + flick: `sH = chargeGain·charge · flickAccuracy`. `charge∈[0,1]` (held time / max), `flickAccuracy∈[0,1]` = how close release aligns to sweet-spot frame.
- **Impulsive contact** (not continuous): puck gets `Δv = (1+e)·mH/(mH+mP)·sH` along rail (up). `e`=restitution of lever pad.
- **Puck** mass `mP` travels 1-D up rail vs gravity + rail friction: `v -= (g + μ·g)·dt` until `v≤0`; peak height `H = v0²/(2·(g+μg))`.
- Win = `H ≥ bellHeight`. Score = `H` (or bell hit + margin). Bell = ring bar at top.
- Deterministic: outcome = pure function of (charge, flickAccuracy). No random.

## Scoring
- Ring markers up the tower (like the real game). Score = highest ring reached; bell = max + bonus. Streak multiplier on consecutive bell hits.

## 5 Tiers (variables)
| Tier | chargeGain | sweet-spot window (frames) | mP (kg) | rail μ | bellHeight (rel) | e |
|---|---|---|---|---|---|---|
| 1 | 1.35 | 12 | 4 | 0.02 | 0.70 | 0.95 |
| 2 | 1.25 | 8 | 5 | 0.03 | 0.80 | 0.92 |
| 3 | 1.15 | 5 | 6 | 0.04 | 0.88 | 0.90 |
| 4 | 1.08 | 3 | 7 | 0.05 | 0.94 | 0.88 |
| 5 | 1.00 | **1** | 8 | 0.06 | **0.985** | 0.85 |

- Higher tier: heavier puck, more friction, taller bell, and a **narrower sweet-spot** → flickAccuracy collapses unless release is frame-perfect.
- **T5 limit-push:** 1-frame window + near-ceiling bell demands ~perfect charge AND timing simultaneously. Achievable, brutally strict.

## Visuals (uncanny)
- Tower: hyper-real scratched steel + rust; mallet head slightly too large (skew). Fluorescent overhead, magenta neon numerals. Puck glows off-color. Hard cast shadow of tower.
- Charge = tower base pulses; contact = brief hit-stop + screen kick.

## Audio (tunnel vision)
- Ambient → LP muffled.
- Crisp spatial SFX: mallet whoosh (charge-scaled brown-noise sweep), **impact thud** (low sine + metallic partials) at puck, puck-scrape rising with height, bell = bright clear ding at top (spatialized high).

## Determinism check
- Fixed (charge, releaseFrame) → identical peak height every run.
- Unit: `H = v0²/(2(g+μg))` matches sim integration within eps.

## Reuse
`physics.integrate` (1-D), `railImpulse`, `tiers.applyTier`, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`, hud power/timing bars.
