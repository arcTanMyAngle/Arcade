# Skills — Technical Prerequisites, Physics Edge-Cases, Optimizations

## Prereqs
- Three.js: `WebGLRenderer`, `PerspectiveCamera`, `InstancedMesh`, `BufferGeometry`, raycaster, `Quaternion`/`Euler`, PBR (`MeshStandardMesh`), tone mapping (ACES), shadow maps.
- Web Audio: `AudioContext`, `GainNode`, `BiquadFilterNode`(lowpass), `PannerNode`(HRTF), `OscillatorNode`, `AudioBufferSourceNode` (noise), envelopes via `setValueAtTime`/`linearRampToValueAtTime`.
- Math: semi-implicit Euler, quaternion rotation, ray/analytic intersection, restitution & Coulomb friction, moment/torque for backspin, closed-form ballistics.

## Determinism rules
- Physics reads only: prior state, fixed `dt`, input snapshot, seeded PRNG. **No `performance.now`, no `Math.random`, no frame-rate coupling.**
- `mulberry32(seed)` for any spread; seed logged per attempt → replayable.
- Accumulate in fixed order; avoid NaN via clamps. Snapshot input once per substep.

## Physics edge-cases (handle explicitly)
- **Ring Toss clipping/tunneling:** thin torus + fast ring can pass the peg between frames.
  → **Swept test:** treat ring center path as a segment each substep; find closest approach
  to peg axis; if within `ringInner` while descending, resolve capture; else torus↔cylinder
  contact with restitution. Substep further (`micro=4`) when speed×dt > ringThickness.
- **Ring settle jitter:** near-rest bodies oscillate → apply `sleepEps` velocity clamp + high
  friction at low speed; snap to peg axis when captured & |v|<eps.
- **Basketball rim:** sphere↔torus(rim) → radial contact; **backspin** adds tangential
  friction impulse `Δv_t = -μ·|J_n|·sign(spin)` → "shooter's roll". Soft-rim restitution.
- **Skee-ball lip-jump:** ball crossing the ramp lip becomes a projectile (leave surface when
  normal force ≤ 0) → parabolic to ring plane. Detect launch by `v·n>0` at lip edge.
- **High striker:** impulsive contact, not continuous. `J = m·Δv` from mallet head speed;
  puck 1-D up rail vs gravity + rail friction; win = peak height ≥ tier bell.
- **Shooting/dart drop:** wind as drag `F=-k·(v-w)|v-w|`; small `k`, exact enough at 60Hz.
- **Restitution/friction thresholds:** per-material `{e, μs, μk}`; slide vs stick decided by
  tangential vs `μs·N`. Explicit — no engine defaults.
- **Grazing/degenerate:** guard divide-by-zero on normals; clamp `dot` to [-1,1] before `acos`.

## Collision solver menu (in `physics.js`)
| Solver | Used by | Note |
|---|---|---|
| `integrate(s,F,dt)` | all | semi-implicit Euler |
| `raySphere` / `rayCircle` | shooting, dart | instant hit-scan option per tier |
| `sphereePlane(s,plane,mat)` | basketball, skee, ring floor | restitution+friction |
| `sweptSphereSegVsPeg` | ring toss | anti-tunnel capture test |
| `sphereTorus(s,torus,mat)` | ring toss, basketball rim | radial contact |
| `sphereIncline(s,ramp,mat)` | skee-ball | rolling friction + lip launch |
| `railImpulse(puck,J,rail)` | high striker | 1-D constrained |

## Three.js optimizations
- **InstancedMesh** for balloons, pins, targets, rings (one draw call; per-instance matrix/color).
- **Geometry merge** static scenery (booths, walls) → few draws.
- **Object pool** projectiles (bullets/darts/balls); never alloc in loop.
- Reuse scratch `Vector3`/`Quaternion`/`Matrix4` (module-level temps) — zero per-frame GC.
- Shadow map only on hero lights; cap pixel ratio ≤2; frustum-cull default.
- Render decoupled from physics; interpolate transforms with `alpha`.
- Dispose geometries/materials/textures on `teardown()` to avoid leaks between games.

## Audio "tunnel vision" recipe
- Ambient bed (looped synth noise/crowd) → `lowpass ~400Hz, Q low` → gain ~0.25.
- Critical SFX → dry → `PannerNode`(HRTF) at emitter world pos → gain ~1.0. Distinct spectral band from ambient so they cut through.
- Synth voices: impact=filtered noise burst + click; wind=brown noise + slow LP sweep; breath=band-passed noise env; mallet=low sine thump + metallic partials; glass/pop=short bright transient.

## Testing
- Headless `test/physics.test.mjs` (node, no three): assert drop closed-form, restitution
  energy loss, ring capture vs bounce boundary, determinism (two runs same seed → equal hash).
