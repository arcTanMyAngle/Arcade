# Level 4 — Ring Toss (Friction Tester) · PHYSICS SHOWCASE

**Skill:** toss a rigid ring so it lands over a peg and settles — governed by torus↔cylinder
collision, restitution, and friction thresholds. Hardest solver in the suite.
**Input:** drag-flick throw (mouse press→drag→release maps to launch vector + spin), or aim+power meter. Backspin from up-flick helps the ring "sit."

## State
- Ring = rigid torus: center `p`, velocity `v`, orientation quat `q`, angular vel `ω`. Params: major `R`, minor (thickness) `r`, mass `m`, inner radius `Ri=R−r`.
- Peg = vertical cylinder: base, axis `+y`, radius `pR`, height `pH`.

## Physics (custom, deterministic)
- Free flight: `integrate(ring, g, dt)`; `q` integrated from `ω` (quaternion derivative).
- **Anti-tunnel swept test (the edge-case):** thin ring + speed can pass the peg between frames.
  Each substep, sample ring-center segment `p_prev→p`; if the ring **plane** crosses the peg
  axis region and `Ri` encircles the axis while descending → **capture**. Else compute
  torus↔cylinder contact.
  - Adaptive micro-substeps: `micro = ceil(|v|·dt / (r))` (clamp 1..8) so displacement per
    micro-step < thickness. Prevents clip-through at high tiers.
- **Torus↔cylinder contact:** closest point between ring circle and peg axis → contact normal;
  resolve with restitution `e` (normal) + Coulomb friction (`μs` stick / `μk` slide) on tangential.
  Ring can bounce off peg top rim (torus↔circle) or shaft.
- **Capture & settle:** once encircling with |v| under `catchV`, ring slides down shaft;
  friction bleeds motion; when |v|<`sleepEps` snap to rest on peg (or on peg base). High
  friction at low speed kills jitter. **Miss** = ring hits board/ground, restitution bounce, rolls, sleeps.
- **Rolling on ground (miss):** ring can land on rim and roll (torus rolling) — pure friction, no random.

## Scoring
- Ringer (settles on peg) = full. Lean/rest-against-peg = partial. Multi-peg board: farther/thinner peg worth more. Streak multiplier.

## 5 Tiers (variables)
| Tier | peg pR (m) | ring Ri (m) | thickness r | e | μs / μk | catchV (m/s) | board tilt |
|---|---|---|---|---|---|---|---|
| 1 | 0.030 | 0.075 | 0.020 | 0.25 | 0.9 / 0.7 | 3.5 | 0° |
| 2 | 0.026 | 0.066 | 0.017 | 0.30 | 0.8 / 0.6 | 3.0 | 3° |
| 3 | 0.022 | 0.058 | 0.014 | 0.35 | 0.7 / 0.5 | 2.6 | 6° |
| 4 | 0.019 | 0.052 | 0.011 | 0.42 | 0.6 / 0.45 | 2.2 | 9° |
| 5 | 0.017 | **0.047** | **0.008** | 0.50 | 0.5 / 0.35 | **1.8** | 12° |

- Clearance `Ri−pR` shrinks: T1 45mm → **T5 30mm**. Higher `e` + lower friction → ring bounces off unless landed nearly flat & slow (backspin to kill velocity).
- **T5 limit-push:** razor clearance, thin high-restitution ring, low catch velocity, tilted slick board. Ringers require near-flat descent + controlled backspin — the engine's collision limit, still non-tunneling via swept/micro-substep.

## Visuals (uncanny)
- Rings: hyper-real lacquered wood/plastic, faintly non-circular (skew). Pegs too tall, too even. Clinical white glare + sickly-green neon board grid, hard shadows. Ring wobble/settle animated from physics `q`.

## Audio (tunnel vision)
- Ambient → LP muffled.
- Crisp spatial SFX: ring **whoosh** (spin-scaled), peg **clack** (torus↔cylinder, bright wooden knock) at contact point, **shaft slide** hiss on capture, settle "tock," ground clatter on miss.

## Determinism / correctness check
- Unit: swept test — fixed fast throw at peg → **no tunneling** (ring never passes without contact) at T5.
- Unit: capture vs bounce boundary — throws straddling `catchV`/clearance produce stable, repeatable ringer/miss classification.
- Determinism: fixed launch (vec+spin+seed) → identical final rest pose hash.

## Reuse
`physics.integrate` + quat integrate, `sweptSphereSegVsPeg`, `sphereTorus`, material consts, `mulberry32` (peg layout only), InstancedMesh pegs, pooled rings, `audio.playSpatial`, `materials.uncannySkew`+`clinicalLights`.
