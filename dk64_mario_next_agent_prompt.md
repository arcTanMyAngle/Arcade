# Next Agent Prompt: Rebuild the HTML Cabinet's DK64 and Super Mario World Games

You are working in `C:\Users\bornt\Desktop\Arcade` on two independent, single-file browser games:

- `dk64.html`: a procedural Three.js Donkey Kong 64 homage.
- `mario.html`: a procedural Canvas 2D Super Mario World homage.

Do not touch the Rust racer, `fps/`, `carnival/`, or `galaga/`. Read `CLAUDE.md` first. Preserve unrelated working-tree changes. The two games must remain distinct and must not share mechanics, presentation, or state.

Your job is to turn both proofs of concept into small, coherent multi-level campaigns that feel mechanically and structurally much closer to their named originals. Implement and verify the work; do not stop at another plan. Favor accurate game feel and complete progression loops over raw content volume. Do not copy ROM data, ripped sprites, music, textures, level maps, or other proprietary binary assets. Keep visuals and audio procedural/original, consistent with this repository's asset-light rules.

## What Exists Now

### `dk64.html` audit

The current file is a playable but very shallow Jungle Japes scene:

- One global Three.js scene, one static island, one playable Donkey Kong, one camera.
- 17 undifferentiated bananas, including one golden-colored banana; all 17 must be collected to win.
- Three simple patrolling Kremlings, one barrel cannon, jump, and ground slam.
- Top-surface-only platform collision through `groundAt()`; no wall, ceiling, slope, water, climb, or camera collision.
- Four hit points with immediate full reset, but no checkpoints, pause/status screen, save data, shops, character unlocks, tag barrels, portals, bosses, or world transitions.
- Rendering relies on Three.js r128 from a CDN. Simulation mixes frame scaling, `performance.now()`, `Math.random()`, and a `setInterval` death animation.
- At 16:9 the colorful primitive art reads as a generic low-poly obstacle course, not DK64's moody N64 4:3 presentation.

Important locations in the current file:

- Scene/renderer and procedural helpers: lines 33-65.
- Static Jungle Japes terrain: lines 66-142.
- DK model: lines 143-172.
- Bananas and three enemies: lines 174-208.
- Cannon: lines 209-231.
- Player state and physics: lines 233-250 and 311-358.
- Collection/enemy logic and win condition: lines 306-309 and 390-418.

### `mario.html` audit

The title says Super Mario World, but the game is currently much closer to a rough Super Mario Bros. 1 imitation:

- Exactly one generated `200 x 15` tile level and one flagpole ending.
- SMB-style HUD (`MARIO`, `WORLD 1-1`, score, coins, time), palette, brick layout, Goombas, and end staircase.
- Only small, big, and fire states. No cape, Yoshi, spin jump, P-meter, reserve item, carried objects, goal tape, Dragon Coins, midpoint gate, secret exits, or overworld.
- Only Goomba and Koopa enemies. Pipes are drawn and the start screen advertises pipe entry, but there is no pipe-entry implementation.
- Simulation is frame-rate-dependent: most movement is applied per animation frame while only timers use `dt`.
- The Fire Flower growth transition is broken at lines 616-619: state becomes `fire` before checking whether Mario was small, leaving a fire sprite with a small collision height.
- Block-hit particles are created with `timer/maxTimer` at line 322 but updated as `life/maxLife` at lines 661-665, producing `NaN` and never expiring correctly.
- Brick debris uses unseeded `Math.random()`.
- Ducking is visual state only, world text is effectively hard-coded, and state transitions are duplicated.

Important locations in the current file:

- Fixed 800x480 presentation and SMB HUD: lines 6-46.
- Single level generator: lines 106-194.
- Input mapping: lines 215-231.
- Collision and frame-based physics: lines 233-288.
- Loop/state transitions: lines 366-450.
- Mario movement: lines 452-503.
- Enemy/power-up logic: lines 514-659.
- Flagpole win condition: lines 682-691.

## Source-of-Truth Behavior

Use these references as behavioral specifications, not as sources of copyrighted assets:

- Official DK64 manual: https://www.nintendo.com/eu/media/downloads/games_8/emanuals/nintendo_8/Manual_Nintendo64_DonkeyKong64_EN.pdf
- DK64 reverse-engineering project: https://github.com/0xGlitchbyte/dk64re (the active project is linked from its README).
- Official Super Mario World manual: https://www.nintendo.co.jp/clvs/manuals/common/pdf/CLV-P-SAAAE.pdf
- Commented SMW disassembly: https://github.com/gnaghi/SMWDisC
- SMW RAM map: https://media.smwcentral.net/Iceguy/ram.htm
- SMW mechanics/RAM reference: https://tasvideos.org/GameResources/SNES/SuperMarioWorld

Important facts to preserve in a compact adaptation:

### DK64 identity

- The base move set includes analog-like walk/run, variable-height jump, attack, running attack, aerial attack, crouch, backflip, long jump, climbing, and swimming.
- Simian Slam is jump then crouch/slam while airborne; it is not simply a separate generic smash button.
- The original uses a hub/lobby/level structure. DK Portals enter worlds; Tag Barrels change Kongs and heal; paired numbered Bananaport pads create fast-travel links.
- The five Kongs are not skins. Donkey, Diddy, Tiny, Lanky, and Chunky have distinct proportions, movement feel, pads/barrels, weapons, instruments, and progression abilities.
- Collectibles have jobs: Golden Bananas gate progress; colored bananas and coins belong to a Kong; coins buy moves/weapons/instruments; oranges are explosives; crystal coconuts power transformations; blueprints come from color-coded Kasplats; melons are health.
- A full original world contains 100 colored bananas per Kong; 75 earns that Kong's medal. Singles, bunches, and balloons should make exact totals practical.
- Troff n' Scoff consume colored bananas to open the world boss. Bosses award keys. World access is gated by total Golden Bananas.
- The original sequence is Kong Isle hub, Jungle Japes, Angry Aztec, Frantic Factory, Gloomy Galleon, Fungi Forest, Crystal Caves, Creepy Castle, and Hideout Helm. A compact game need not reproduce all content, but its data model must support this sequence.
- Camera controls include recenter/hold-behind, orbit, multiple zoom levels, and first-person aiming. Camera obstruction handling is essential in a browser recreation.

### Super Mario World identity

- Simulate at a fixed 60 Hz. The original stores signed X/Y speed separately from pixel/subpixel position; preserve subpixel movement so acceleration and braking are stable. In the original RAM map, X speed is `$7E007B`, Y speed is `$7E007D`, position and subpixel accumulators are separate, and the P-meter is `$7E13E4`.
- The disassembly caps the P-meter at `$70`. It fills while sustained high-speed running and enables cape takeoff. Do not fake this with a generic sprint toggle.
- X/Y (keyboard run/action) accelerates Mario and lets him hold/kick objects. B performs the normal jump. A performs the spin jump and dismounts Yoshi. The spin jump must have distinct bounce/break/enemy interaction rules.
- Mario's jump impulse and gravity behavior depend on horizontal speed and jump-button hold/release. Turning has more braking than same-direction acceleration. Momentum carries into the air.
- Cape Mario can cape-spin, run to fill the P-meter, take off, dive, pull up, and slow-fall. Ship a controllable, simplified but real flight state machine, not unlimited upward movement.
- Yoshi can be mounted/dismounted, run and jump with Mario, eat enemies/berries, hold or spit shells, and run away when hit. At minimum, implement green Yoshi plus shell holding/spitting and red-shell fire behavior.
- The item reserve box stores the displaced power-up and releases it on command or after damage. The HUD also tracks lives, coins, score, timer, Dragon Coins, and goal stars.
- Midway gates set a restart point and grow Small Mario. The moving goal tape awards stars based on height. A key carried to a keyhole completes a secret exit.
- An overworld graph, animated path reveal, normal exits, secret exits, persistent course completion, and returning to the map after a clear are defining systems, not optional menu polish.
- Use a 256x224 logical playfield and 16x16 logical tiles, then scale with nearest-neighbor rendering. A 512x448 canvas is a reasonable 2x backing representation. Do not keep the current stretched 800x480 logical coordinate system.

## Shared Engineering Requirements

Apply these to both files before multiplying content:

1. Use a fixed 60 Hz accumulator with a bounded catch-up count. Rendering may interpolate, but gameplay must not depend on display refresh rate.
2. Keep simulation state independent from DOM/render objects. Define explicit game modes and explicit enter/exit functions for title, hub/map, level, pause, death, clear, and game over.
3. Replace simulation-relevant `Math.random()`, `Date.now()`, `performance.now()`, and timers with a seeded PRNG and simulation ticks. Cosmetic animation may read an interpolated simulation clock.
4. Reset keyboard state on `blur` and `visibilitychange`. Use edge-triggered actions for jump, interact, pause, firing, and menu selection.
5. Use data-driven level/world definitions. Never duplicate a whole update/render loop per level.
6. Add versioned `localStorage` save data with a New Game/reset option. Validate loaded data and fall back safely if it is missing or corrupt.
7. Keep the pages playable from a direct file open. Do not add a build step, package manager, server-only fetch, or runtime asset download. If the existing Three.js CDN dependency cannot be removed in scope, fail visibly and explain the network requirement instead of leaving a blank page.
8. Generate visuals and Web Audio sound effects/music in code. Do not import Nintendo/Rare art, audio, maps, ROM data, or fan rips.
9. Make the UI responsive without altering the logical gameplay aspect ratio. No clipped HUD text or overlapping controls at 1280x720, 800x600, and 390x844.
10. Expose a small debug/test API on `window` for deterministic smoke tests: current mode, level ID, player position/velocity/state, inventory/progress, load-level helper, and advance-fixed-ticks helper.
11. Avoid giant unstructured additions. Even inside one HTML file, use clear sections and small modules/classes for input, simulation, collision, world data, rendering, audio, and persistence.
12. Preserve a stable 60 FPS on an ordinary desktop browser. Pool frequently spawned effects and dispose Three.js geometries/materials/render targets when unloading a DK64 world.

## Workstream A: `dk64.html`

### Required campaign slice

Build a compact campaign with at least these playable spaces:

1. Kong Isle hub: DK's treehouse/start area, three gated level portals, visible Crocodile Isle threat, K. Lumsy/key feedback, and a status/pause screen.
2. Jungle Japes: humid outdoor canyon/jungle, tunnels or mine area, Diddy's rescue objective, Tag Barrel, one Bananaport pair, Cranky/Funky interactions, and an Army Dillo-style boss encounter.
3. Angry Aztec: desert/sandstorm palette, temple interior, character-specific switches/pads, Tiny and Lanky rescue objectives, and a distinct traversal puzzle.
4. Frantic Factory: multi-floor industrial/toy-factory space, moving machinery/hazards, Chunky rescue objective, a timed or arcade-like challenge, and a boss or major Golden Banana finale.

Each world must be a genuine separate world definition with its own geometry, spawn point, lighting/fog, hazards, objectives, collectibles, enemies, portals, music layer, and saved completion state. A recolor of the same obstacle course does not count.

### Required DK64 systems

- Implement solid collision with floors, walls, ceilings, steps, moving platforms, kill volumes, and sweep/substep protection against tunneling. Add camera collision and a reset/recenter button.
- Implement variable jump, attack combo or single ground attack, running attack, aerial attack, crouch, backflip, long jump, climbing, swimming, and Simian Slam.
- Rescue and make all five Kongs selectable by the end of Frantic Factory. Each must have visibly different size/speed/jump/animation and at least one functional signature ability:
  - Donkey: lever strength or Strong Kong/Baboon Blast interaction.
  - Diddy: Chimpy Charge and a limited Rocketbarrel section.
  - Tiny: Pony Tail Twirl and Mini-Monkey route.
  - Lanky: OrangStand/handstand movement and Baboon Balloon route.
  - Chunky: Primate Punch and Hunky Chunky route.
- Tag Barrels must switch only to rescued Kongs, heal the player, update HUD identity/colors, and preserve world state.
- Implement compact but faithful collectible categories: per-Kong colored bananas/coins, Golden Bananas tied to named objectives, oranges, ammo, crystal coconuts, health melons, one blueprint/Kasplat route per world, and boss keys.
- Use logical banana values of 1/5/10 and show `current/100` for the active Kong. Award a medal at 75. Content may use fewer displayed objects by relying on bunches/balloons.
- Add world Golden Banana requirements at portals, Troff n' Scoff boss requirements, and persistent boss-key progression. Do not use "collect every object to win".
- Add at least one shooter/first-person aiming implementation and one instrument/pad interaction. Architecture must map the five weapons/instruments even if only a subset is used in this campaign.
- Add enemy state machines with idle/patrol/notice/chase/attack/hurt/defeat states. Include at least Gnawty/Kritter, Klaptrap, and Kasplat behaviors with readable attack anticipation.
- Add a pause/status screen summarizing each world and Kong: Golden Bananas, colored bananas, medal, blueprint, boss key, coins, moves, weapon, and instrument.
- Add procedural Web Audio feedback for jump, collect, attack, damage, barrel/portal, purchase, Golden Banana, and boss clear. Include per-world ambient/music motifs that do not reproduce the original compositions.

### DK64 presentation target

- Compose for a 4:3 gameplay view with responsive letterboxing, N64-like low-poly silhouettes, restrained texture-like procedural color variation, stronger depth fog, and readable landmark-based navigation.
- Jungle Japes should have vertical cliffs, cave mouths, streams/waterfalls, paths, mine/tunnel landmarks, and distant vistas. Do not leave it as a flat square lawn.
- Use contextual HUD display: active Kong portrait/color, melon health, bananas/coins/ammo when relevant, objective feedback, and a brief world title card.
- Keep camera behavior comfortable: acceleration-aware follow distance, obstruction push-in, pitch/zoom limits, recenter, and first-person aiming mode.

## Workstream B: `mario.html`

### Required campaign slice

Build a compact Dinosaur Land campaign with an overworld and at least seven courses:

1. Yoshi's House or equivalent safe starting node/tutorial space.
2. Grassland course introducing momentum, spin jumps, Koopas, and Dragon Coins.
3. Vertical/athletic course with moving platforms and a midpoint.
4. Cave course with slopes, carried shells, a key/keyhole secret exit, and an alternate map route.
5. Water course with swimming and a pipe sub-area.
6. Switch Palace whose completion persistently changes blocks in later levels.
7. Castle course with lava, crushing/moving hazards, checkpoint, boss door, and a simple Iggy-style arena; completing it ends the compact campaign.

Use original-inspired themes and teaching sequences, not pixel-for-pixel copies of Nintendo's maps. At least one course must have both a normal goal-tape exit and a keyhole secret exit. At least one pipe must lead to a separately defined sub-area and return correctly.

### Required SMW systems

- Replace the current physics with fixed-point/subpixel 60 Hz movement. Tune against recorded measurements in a debug HUD/test: time to walk speed, time to run speed, stopping distance, reversal distance, jump apex at low/high speed, and short-hop/full-hop height.
- Implement walk/run acceleration, momentum-preserving jumps, stronger turn braking, air control, variable jump height, crouch with real collision height, slope walking/sliding, normal jump, and spin jump.
- Implement small, Super, Fire, and Cape states with correct collision-height changes. Fix power-up transitions so growth/shrink never embeds Mario in terrain or mismatches sprite and hitbox.
- Implement the reserve item box and deterministic damage hierarchy. Preserve reserve and Yoshi state appropriately across level transitions and deaths.
- Implement cape spin, P-meter fill/drain, takeoff, flight dive/pull-up cycle, and slow fall. Add debug readouts for speed and P-meter while tuning, hidden in normal play.
- Implement green Yoshi: egg/hatch or block spawn, mount, dismount, tongue, enemy/shell eating, shell hold/spit, red-shell fire, hit/run-away, and carry to the next compatible course.
- Implement carryable/kickable shells, shell-on-enemy chains, blocks hit by shells, P-switch or equivalent temporary block/coin transformation, and springboards if time permits.
- Add at least these enemies/hazards with distinct behavior: green and red Koopas, Goomba/Galoomba behavior appropriate to SMW, Piranha Plant, Rex, Bullet Bill, Boo, fish, lava bubble, and castle hazard. Do not just recolor one walker.
- Add Dragon Coins (five per course), coins/100-coin life, 1-Ups, midpoint gates, goal tape with height-based stars, timer-to-score conversion, secret key/keyhole exits, and persistent exit completion.
- Implement an overworld graph with node locking, Mario movement along revealed paths, normal/secret path colors or animation, course replay, a switch-palace state, save data, and final castle completion.
- Replace the SMB-like HUD with an SMW-like in-canvas HUD: Mario/lives, Dragon Coin progress, goal stars, centered reserve box, timer, coins, and score. Course names should appear on entry from the map.
- Add procedural Web Audio for movement/action feedback and original short music loops per grass/cave/water/castle/map theme. Do not transcribe Nintendo melodies.

### SMW presentation target

- Render to a 256x224 logical coordinate system using 16x16 tiles and nearest-neighbor integer scaling where possible.
- Use layered parallax backgrounds, animated tiles, palette changes by theme, readable pixel-art silhouettes, and richer animation states for Mario, Yoshi, enemies, cape, goal, and map movement.
- Camera behavior should use look-ahead, controlled vertical bands, level bounds, pipe/sub-area transitions, and limited manual look when appropriate. Avoid centering Mario rigidly every frame.
- Preserve readable collision geometry. Decorative art must never look solid when it is not, or non-solid when it is.

## Recommended Implementation Order

Work in vertical slices and keep both games runnable after each stage:

1. Repair shared correctness problems: fixed timestep, input edges/blur reset, deterministic clock/RNG, mode transitions, save schema, debug API.
2. Rebuild Mario's physics/collision and DK64's collision/camera before adding levels.
3. Introduce data-driven world/level loading and prove transitions with placeholder geometry.
4. Complete one representative level end to end in each game, including save/return/progression.
5. Add the remaining required campaign spaces by composing reusable systems.
6. Add signature mechanics, bosses, audio, presentation, and final tuning.
7. Run automated and visual verification at all target viewports.

Do not build all maps first and postpone core mechanics. The project succeeds only if movement, collision, objectives, transitions, death/restart, and saving work as coherent loops.

## Verification and Acceptance Criteria

### Both files

- Open directly from disk in Chromium with no uncaught console/page errors.
- Run for five minutes without growing timers, event listeners, DOM nodes, or live Three.js resources on repeated world transitions.
- Same seeded input replay produces the same end state at 60 Hz, 120 Hz render, and throttled 30 Hz render.
- Pause freezes simulation; resume has no large delta jump. Losing focus cannot leave a movement key stuck.
- Save, reload, corrupt-save fallback, New Game, death, level retry, and game-over paths work.
- At 1280x720, 800x600, and 390x844, the gameplay view retains its aspect ratio and UI does not overlap or clip.

### DK64 minimum playthrough

- Start on Kong Isle, enter Jungle Japes, rescue Diddy, use a Tag Barrel, activate/use a Bananaport pair, earn a Golden Banana from an objective, feed Troff n' Scoff, defeat the boss, receive a key, return to the hub, and unlock Angry Aztec.
- Continue through the compact progression until all five Kongs are rescued and Frantic Factory's finale is complete.
- Each required Kong ability gates and completes at least one meaningful route; no collectible is permanently missable due to a one-way transition.
- Camera never passes through large walls during the critical path and never hides the player for more than a brief obstruction transition.

### SMW minimum playthrough

- Move from overworld to a course, clear a normal goal, watch the map path reveal, and enter the next course.
- Hit a midpoint, die, and restart at the midpoint with correct state.
- Carry a key to a keyhole, return to the map through a secret exit, and reveal a different path without falsely marking the normal exit.
- Acquire Fire and Cape power, use/reserve/release items, fill the P-meter and perform controlled cape flight.
- Mount Yoshi, eat and spit a shell, lose/recover or dismount Yoshi, and carry Yoshi across a compatible normal exit.
- Complete the Switch Palace, verify the changed blocks in a later course, finish the castle boss, and reach the compact campaign completion state.

### Regression checks for known current bugs

- Fire Mario gained from Small Mario has the correct large hitbox and does not clip into the block above.
- Block-hit effects expire and cannot accumulate indefinitely.
- Pipes advertised as enterable are actually enterable and have complete transitions.
- Gameplay distance and jump behavior do not change with monitor refresh rate.
- DK64 no longer requires collecting every banana-like item to trigger a global win.
- DK64 cannot fall through a platform because a single frame crossed its top plane.

## Final Handoff

When done, report:

- Which requirements shipped in each file and any consciously deferred stretch items.
- The exact controls for each game.
- Save schema/version and reset method.
- Verification commands, viewport screenshots, console status, and deterministic test results.
- Any remaining gameplay or performance risks with file/line references.

Do not claim completion based only on title screens or screenshots. Play the required end-to-end paths and provide evidence.
