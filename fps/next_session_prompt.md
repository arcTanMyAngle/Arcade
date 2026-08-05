# Next-session prompt — BREACHPOINT (Arcade/fps/)

Paste the block below into a fresh session.

---

Continue building **BREACHPOINT**, the Three.js FPS at `c:\Users\bornt\Desktop\Arcade\fps`.
Goal: CoD-tier rendering technique and game feel in a browser.

**Read first, in order:** `fps/CLAUDE.md` (hard rules, module contract, strict
per-agent file ownership) then `fps/handoff.md` (current state, the four silent
bugs already fixed, next steps in leverage order). Do NOT load the other four
Arcade projects — root `plan.md`/`handoff.md`/`src/*.rs` are Wii Kart's,
`carnival/` and `galaga/` are separate. `fps/critic.md` defines the visual-review
rubric and what the critic may and may not claim.

## Where it stands
Foundation is solid and verified: 128 Hz deterministic loop, per-tick immutable
InputFrame, correct color management (linear lighting → ACES → sRGB), analytic sky
+ PMREM IBL, 16 procedural PBR materials with AO/ORM packing, blockout level with
unified visual+collision authoring, full movement controller (slide, mantle,
step-up, uncrouch-blocking), headless screenshot harness. `npm test` = 35 passing.

It renders **correctly** but is **not art-directed**: still a grey-box courtyard.
No weapon, no enemies, no HUD, no TAA. Perf budget is wide open — 60 draw calls and
2.4 K triangles against a 900 / 1.6 M gate.

## The blocker last session
Nine parallel subagents were launched and **all were killed within minutes by an
account monthly spend limit**, not by any fault in the work. Before dying, several
wrote files that nothing imports yet. `render/textures.js` was complete and has
been reviewed and wired in. These remain **orphaned and unverified** — review each
before trusting it, they were written by agents that died mid-task:

- `src/world/collision.js` (10 KB)
- `src/ai/nav.js` (12 KB)
- `src/audio/dsp.js` (23 KB)
- `src/weapons/tuning.js` (6 KB)

**First action: check whether the spend limit was raised.** If yes, re-run the
fan-out — `fps/CLAUDE.md` already pins the module contract and file-ownership table,
and `tools/capture.mjs` gives each agent an isolated build dir + port so they can
verify concurrently. If no, work inline and do not spawn agents; they will die the
same way.

## Next, in leverage order
1. **Level art + geometric density** — the single biggest remaining gap to a AAA
   read. Trim, props, verticality, interior/exterior, signage, debris. Instance
   aggressively. Preserve the `box()` helper's property that render mesh and
   collider are authored from one call.
2. **Macro-variation breakup** on tiling walls — `concreteWall`'s form-tie pattern
   repeats very visibly at distance. `textures.js` already exports
   `macroVariation()`; it needs shader-side blending.
3. **Weapon viewmodel** — the most-looked-at object in an FPS, currently a stub.
   Separate render pass so it can't clip world geometry.
4. **TAA + cascaded shadow maps** — only FXAA today; one 2048 map over a 40 m
   radius gives mushy contact shadows.
5. Wire the orphaned modules above, reviewing each first.

## Verification — required, non-negotiable
```
cd c:\Users\bornt\Desktop\Arcade\fps
npm test
node tools/capture.mjs --out shots/<name> --shots hero,overlook --w 1280 --h 720 --port <unique>
```
Then **read the PNGs back with the Read tool and judge them**. A build that
compiles but renders black is a failure — last session produced exactly that, three
times, with a clean build and no console error. Headless runs on SwiftShader and
takes minutes; its `fps` number is meaningless, judge cost by draw calls /
triangles in `perf.json`. `tools/diag.mjs` boots once and screenshots several
render variants — use it to test multiple hypotheses per boot instead of one
capture per guess.

## Gotchas already paid for (don't rediscover)
- Playwright `waitForFunction(fn, arg, options)` — options is the **third** param.
- The capture harness must remove the title overlay or it occludes every shot.
- An animating canvas never reaches screenshot-stability on software GL;
  `?headless` halts the loop and `__GAME__.settle(n)` runs n frames then stops.
- Procedural texture gen is CPU-bound: non-integer lattice periods and
  all-octaves-skipped both produce NaN, which `Uint8Array` coerces to 0 — a
  perfectly silent pure-black material. `test/textures.test.mjs` guards both.
- `src/main.js` is the integration root and lead-only. Subsystems never import each
  other; they talk via `ctx` handles + the `core/events.js` bus.

Nothing has been committed — `fps/` is entirely untracked. Commit only if asked.
