# BREACHPOINT — handoff

Living state doc. Update at the end of every work chunk.

## Architecture and invariants

BREACHPOINT is a procedural Three.js FPS pursuing modern-shooter rendering
technique and feel. `src/main.js` is the integration root; subsystem signatures
and ownership live in `CLAUDE.md`. Simulation is fixed at 128 Hz and reads only
immutable per-tick input frames.

Non-negotiable: no binary assets, seeded randomness only, honest hitboxes/spread,
visual and collision geometry authored together, fixed-size runtime pools, and no
per-frame heap growth in hot paths.

## Status (2026-08-04)

- The level is a batched exterior CQB yard with a playable catwalk/stairs,
  containers, HVAC, pipes, vehicle, pallets/crates, rubble, signage, railings,
  localized lights, and five review poses. The former surface doorway is now a
  traversable 2.5 m OPS-01 recess with a rear door, jambs, canopy, warm interior
  light, threshold, sign, conduit, and cable run. A powered breach-staging cluster
  and vehicle-recovery cluster add readable midground stories. Geometry still
  merges to one mesh per material; solid helpers author matching collision.
- `world/collision.js` uses a grid broadphase for movement and ballistic rays and
  returns material, hit point, and outward normal. Exact-ground contact and
  negative-direction slab normals are regression-tested.
- Eighteen procedural PBR materials retain correct sRGB/linear handling. Large
  masonry surfaces use macro luminance/roughness variation; concrete form ties
  and metal paint chips use physically plausible feature scales.
- Post is HDR world render -> GTAO -> camera-reprojected TAA -> isolated layer-2
  viewmodel -> bloom -> restrained grade -> output transform -> FXAA.
- The BP-15 keeps deterministic 750-rpm fire, truthful spread, recoil, ADS,
  tactical/empty reloads, and ballistics. Its refined procedural viewmodel has an
  extruded/bevelled receiver, ejection port, controls, octagonal M-LOK handguard,
  restrained rail, curved magazine, tactical gloves, and tapered sleeves. The
  open red-dot coordinates and centered ADS solve are unchanged. Rear stock and
  buffer hardware remain behind the virtual eye.
- FX is pooled. AI uses the nav graph for reaction, cover, peek/fire/duck,
  suppression, honest capsule zones, damage, and death collapse.
- `src/ai/body.js` now contains an unverified final visual rewrite with articulated
  limbs, boots, helmet/goggles, plate carrier, pouches, backpack, gloves, and a
  multi-part carbine. Six material families are baked into shared geometry, so
  the richer body remains six draws per agent. Living anatomy stays inside the
  tested 0.36 m × 1.78 m capsule; visual peek offset is only 1.4 cm.
- Audio remains fully synthesized. The Canvas HUD exposes true spread, hit/kill
  markers, health/ammo, compass, reload stage, hostiles, and diagnostics.

## Verification

- Node suite: **40/40 passes after the enemy rewrite**.
- Production Vite build passes through the verified weapon and level composition
  work. It has **not been rerun after the final enemy body rewrite**.
- Refined weapon frames: `shots/vm-refine2/`.
- Latest verified level frames: `shots/level-focal2/` (`hero`, `ads`, `overlook`).
- `level-focal2/console.log` is clean except SwiftShader's expected missing
  `KHR_parallel_shader_compile` warning.
- Latest verified ultra capture: **299 draw calls / 66,214 triangles**, 42
  programs, 69 textures, 93 geometries—well below the 900 / 1.6 M gates.
- Final enemy verification is pending. Run:

```powershell
npm run build
node tools/capture.mjs --out shots/enemy-refine1 --shots hero,ads,overlook,enemy --w 1280 --h 720 --port 4322
```

Inspect all four PNGs plus `console.log` and `perf.json` before accepting the pass.

## Honest visual assessment

Verdict remains **ITERATE**, not SHIP. The new hero frame has a much stronger
focal read: a warm recessed OPS-01 entrance against cool concrete, staging props,
and overhead service lines. The viewmodel no longer has the rear tube intrusion
or ADS rail staircase, and the optic remains open and centered. It still reads as
procedural under close inspection, especially the broad receiver top and glove
shapes. Overlook remains the weakest composition because the recovery cluster is
distant and much of the right yard is intentionally open. The enemy rewrite must
be visually judged before its quality can be claimed. Current sun shadows use one
stabilized map; true cascades and SSR do not exist.

Highest-leverage next work:

1. Build and capture `enemy-refine1`; inspect the dedicated `enemy.png`. Correct
   anatomy, equipment scale, stance, or capsule drift if the frame exposes it.
2. If the enemy passes, consider one restrained overlook composition pass that
   strengthens recovery silhouettes without filling every tactical lane.
3. Add scripted combat captures for impacts, deaths, and reload regression.
4. Only then consider true cascaded sun shadows. Preserve stable contact shadows
   and the 900-draw gate; do not claim CSM or SSR until implemented and captured.

## Verification harness

```powershell
npm test
npm run build
node tools/capture.mjs --out shots/<name> --shots hero,ads,overlook --w 1280 --h 720 --port <unique>
```

Capture builds to an isolated `.dist-cap-<port>`. `?headless` halts normal rAF and
`__GAME__.settle(n)` advances review frames. Always inspect PNGs, `console.log`,
and `perf.json`; a successful bundle is not proof of a valid frame.
