```
    _    ____   ____    _    ____  _____
   / \  |  _ \ / ___|  / \  |  _ \| ____|
  / _ \ | |_) | |     / _ \ | | | |  _|
 / ___ \|  _ <| |___ / ___ \| |_| | |___
/_/   \_\_| \_\\____/_/   \_\____/|_____|

        >>>>  I N S E R T   C O I N  <<<<
```

# ARCADE

> A single cabinet, many machines. Hand-built retro and neo-retro games across
> **Rust**, **C++**, and the **browser** — each one from-scratch, asset-light,
> and deterministic. No engines-as-a-service, no store pages, just source you
> can build and play.

```
==================================================================
  #   TITLE                 GENRE            TECH            RUN
==================================================================
  1   WII KART              3D kart racer    Rust/macroquad  cargo
  2   UNCANNY CARNIVAL      3D skill suite   Three.js/Vite   npm
  3   GALAGA (x2)           Shoot 'em up     C++ & Rust      raylib
  4   THE HTML CABINET      5 classics       Vanilla JS      browser
==================================================================
```

---

## PRESS START — Quick Play

The fastest coin in the slot. Pick a machine:

```
> Just want to click and play?  ......  open any *.html file  (Cabinet #4)
> Have Node installed?  ...............  cd carnival && npm i && npm run dev
> Have Rust installed?  ...............  cargo run --release   (Wii Kart)
```

---

## PLAYER PREREQS

Install only what the machine you want needs.

| Machine | Needs |
|---------|-------|
| The HTML Cabinet | A modern web browser. Nothing else. |
| Uncanny Carnival | [Node.js](https://nodejs.org) 18+ and npm |
| Wii Kart | [Rust](https://rustup.rs) 1.82+ (repo builds on 1.96) |
| Galaga (Rust) | Rust + **CMake** + MSVC toolchain + **LLVM/libclang** |
| Galaga (C++) | **Visual Studio 2022** (C++ workload) + **CMake** |

> Galaga's raylib backend compiles from source on first build — expect a slow,
> one-time warm-up, then instant rebuilds.

---

## CABINET #1 — WII KART
`./` (repo root) · Rust + macroquad

A procedurally-generated, third-person **3D kart racer** with that Mario-Kart-Wii
"speed juice": drift charge → mini-turbo boost, a chase cam that widens its FOV as
you accelerate, and a fixed **60 Hz** simulation for stutter-free, reproducible runs.

```
cargo run --release
```

The aggressive release profile (fat LTO, `codegen-units = 1`, `target-cpu=native`
via `.cargo/config.toml`) makes the first build slow but the binary fast. For quick
iteration use plain `cargo run` (deps stay optimized, your crate builds fast).

```
+----------------------------------------------------+
|  CONTROLS                                          |
+----------------------------------------------------+
|  Up / W .................. throttle                |
|  Down / S ................ brake / reverse         |
|  Left  / A ............... steer left              |
|  Right / D ............... steer right             |
|  Space / L-Shift ......... drift  (hold to charge) |
|  L-Ctrl / F .............. fire item               |
|  Enter ................... confirm / start         |
|  [  ] .................... cycle (debug)           |
+----------------------------------------------------+
```

---

## CABINET #2 — UNCANNY CARNIVAL
`carnival/` · Three.js + Vite

A browser **3D carnival skill-suite** — 6 games across 5 difficulty tiers, with a
custom deterministic physics kernel, procedural Web-Audio SFX, and a deliberate
uncanny-valley art direction (hyper-real PBR on subtly *wrong* geometry, clinical
fluorescent light, sickly neon rims). **Zero RNG rigging** — every score is honest.

```
cd carnival
npm install          # first time only
npm run dev          # dev server with hot reload  ->  http://localhost:5173
```

Other scripts:

```
npm run build        # production bundle -> carnival/dist/
npm run preview      # serve the built bundle
npm test             # node --test on the physics kernel
```

The lineup: Shooting Gallery · High Striker · Balloon Dart · Ring Toss ·
Basketball · Skee-Ball. Design notes live in `carnival/level_*.md`.

---

## CABINET #3 — GALAGA  (built TWICE)
`galaga/` · raylib, in both C++ and Rust

The same faithful Galaga shooter implemented **1:1 in two languages** — identical
files, constants, update order, and fixed timestep — rendered through the same
**raylib** so the only variable measured is language + runtime. Press **V** in
either build to uncap the frame rate and read each one's headroom off the HUD.

**Rust build:**
```
galaga\build-rust.bat        REM sets LIBCLANG_PATH, then cargo run --release
```
or manually:
```
set LIBCLANG_PATH=C:\Program Files\LLVM\bin
cd galaga\rust
cargo run --release
```

**C++ build (MSVC):**
```
galaga\build-cpp.bat
galaga\cpp\build\Release\galaga_cpp.exe
```
or from a *x64 Native Tools Command Prompt*:
```
cmake -S galaga\cpp -B galaga\cpp\build -G "Visual Studio 17 2022" -A x64
cmake --build galaga\cpp\build --config Release
```

```
+----------------------------------------------------+
|  CONTROLS                                          |
+----------------------------------------------------+
|  Left / Right  (or A / D) ... move                 |
|  Space (or L-Ctrl) .......... fire                 |
|  Enter ...................... start / restart      |
|  V .......................... uncap FPS (60 <-> ∞) |
|  H .......................... toggle perf HUD      |
|  Esc ........................ quit                 |
+----------------------------------------------------+
```

Full write-up (HUD readout, capture mechanic, challenging stages): `galaga/README.md`.

---

## CABINET #4 — THE HTML CABINET
`./*.html` · vanilla JavaScript, single file each

Five self-contained classics. **No build, no server, no dependencies** — double-click
the file or open it in a browser and play.

```
+-------------------+------------------------------------------+
|  FILE             |  GAME                                    |
+-------------------+------------------------------------------+
|  mario.html       |  Super Mario World                       |
|  tetris.html      |  Tetris                                  |
|  dk64.html        |  DK64 — Jungle Japes Slice               |
|  kaboom.html      |  Kaboom!  (Activision homage)            |
|  stacker.html     |  Stacker                                 |
+-------------------+------------------------------------------+
```

On-screen instructions in each game cover the controls.

---

## CABINET LAYOUT

```
Arcade/
├── src/                 Wii Kart — Rust source (main, physics, race, mesh_gen…)
├── Cargo.toml           Wii Kart crate + release profile
├── .cargo/config.toml   target-cpu=native tuning
│
├── carnival/            Uncanny Carnival — Three.js + Vite
│   ├── src/               game modules + physics/audio core
│   ├── test/              node --test suites
│   └── package.json
│
├── galaga/              Galaga — C++ vs Rust, same design twice
│   ├── cpp/                MSVC + raylib (CMake FetchContent)
│   ├── rust/               raylib-rs crate
│   ├── build-cpp.bat
│   └── build-rust.bat
│
├── *.html               The HTML Cabinet (5 single-file games)
└── LICENSE
```

---

## HOUSE RULES

Every machine here follows the same maker's code:

- **Deterministic.** Fixed-timestep simulation, seeded RNG. Same inputs, same run.
- **Honest.** No rigged hitboxes or fudged scores — difficulty is real physics.
- **Asset-light.** Art and audio are procedural/synthesized; almost no binary files.
- **From scratch.** Custom physics, custom rendering paths, no game-engine crutches.

---

## LICENSE

See [LICENSE](LICENSE).

```
              GAME OVER?  PRESS ENTER TO CONTINUE
                   . . . . . . . . . . . .
```
