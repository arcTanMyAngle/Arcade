# Level 5 — Basketball Free-Throw

**Skill:** parabolic arc into the hoop; rim collision + backspin decide the "shooter's roll."
**Input:** drag-flick (down→up swipe sets power+arc) or aim+power+spin meter. Up-flick length = backspin.

## State
- Ball = sphere: `p`, `v`, mass `m`, radius `bR`, spin `ω` (backspin about lateral axis).
- Hoop = torus rim: center, ring radius `rimR`, tube `rimTube`, plane horizontal at `rimH`. Backboard = plane. Net = visual only.

## Physics (custom, deterministic)
- Flight: `integrate(ball, g, dt)`. Optional light air drag `kB` at high tiers. **Magnus** from backspin gives subtle lift/steeper drop: `F_m = cM·(ω × v)` (small).
- **Rim collision = sphere↔torus:** closest point on rim circle → normal; resolve restitution `e`
  (bouncy rim) + tangential friction. **Backspin bonus:** tangential friction impulse from `ω`
  redirects a rim clip toward the center → the "shooter's roll" (skill-rewarding, not random):
  `Δv_t += μ·|Jn|·dir(spin)`.
- **Backboard:** sphere↔plane restitution `eB`; bank shots viable.
- Make = ball center passes down through rim plane inside `rimR−bR` with `v.y<0`. Swept check vs rim plane to avoid fast pass-through.
- Deterministic: no random; spin + arc fully determine bounces.

## Scoring
- Swish (no rim contact) > make (rim touched) > miss. Streak multiplier; "money ball" markers at back tiers.

## 5 Tiers (variables)
| Tier | distance (m) | rimR (m) | rim e | backboard eB | drag kB | Magnus cM | window (rimR−bR) |
|---|---|---|---|---|---|---|---|
| 1 | 4.0 | 0.240 | 0.55 | 0.50 | 0.0 | 0.15 | 0.120 |
| 2 | 4.6 | 0.230 | 0.62 | 0.55 | 0.002 | 0.15 | 0.107 |
| 3 | 5.2 | 0.225 | 0.70 | 0.60 | 0.004 | 0.12 | 0.098 |
| 4 | 5.8 | 0.220 | 0.78 | 0.65 | 0.007 | 0.10 | 0.092 |
| 5 | 6.4 | **0.216** | **0.86** | 0.70 | 0.011 | 0.08 | **0.086** |

- Standard ball `bR≈0.12`. Higher tier: farther line, tighter rim, **bouncier rim** (clips punished unless backspin saves), less Magnus help. `rimR` → NBA-tight at T5.
- **T5 limit-push:** 6.4m, near-real 0.216m rim, high restitution → only a clean high-arc shot with correct backspin drops. Rim-outs are earned, not rigged.

## Visuals (uncanny)
- Ball: hyper-real pebbled leather, slightly non-spherical (skew), seams off. Backboard too glossy; rim thin. Clinical white gym glare + magenta neon key lines, hard shadows. Net barely moves (unsettling stiffness).

## Audio (tunnel vision)
- Ambient gym → LP muffled.
- Crisp spatial SFX: **release** whiff, ball **bounce** (dry thud, pitch by speed) at contact, **rim clang** (bright metallic) at rim point, backboard **bank** knock, **swish** (soft net hiss) on clean make — all panned to event position.

## Determinism check
- Fixed (power, arc, spin) → identical make/miss + bounce path hash.
- Unit: arc apex/range vs closed-form (drag off); rim-out vs make boundary stable across runs.

## Reuse
`physics.integrate`, `sphereTorus` (rim), `spherePlane` (board/floor), Magnus helper, pooled ball, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`.
