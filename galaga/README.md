# Galaga — C++ vs Rust performance comparison

A faithful Galaga-style arcade shooter built **twice** from the same design: once in **C++** and
once in **Rust**, both rendering through **raylib** so the only thing the comparison measures is the
language/runtime + game logic, not the renderer.

```
galaga/
  cpp/    C++ build  (raylib via CMake FetchContent, MSVC)
  rust/   Rust build (raylib-rs crate)
  build-cpp.bat   one-shot MSVC build script for the C++ side
```

The two source trees are intentionally **1:1**: same files, same constants, same update order, same
fixed timestep. If you tweak gameplay, change both so the comparison stays fair.

## Controls
| Key | Action |
|-----|--------|
| ← → or A / D | move |
| Space (or Left-Ctrl) | fire |
| Enter | start / restart |
| **V** | toggle uncapped FPS (vsync 60 ↔ unlimited) |
| **H** | toggle the perf HUD |
| Esc | quit |

## The HUD (top-left)
`FPS`, `ms` (frame time), `ent` (live entity count), and the cap state (`VSYNC 60` / `UNCAPPED`).
To compare: get both into a similar on-screen state (e.g. a busy wave), press **V** in each, and read
the FPS / ms. Uncapped reveals each build's headroom; capped both should sit at a flat 60.

## Build & run

### Rust
```
galaga\build-rust.bat            REM sets LIBCLANG_PATH, then cargo run --release
```
or manually:
```
set LIBCLANG_PATH=C:\Program Files\LLVM\bin
cd galaga\rust
cargo run --release
```
First build compiles bundled raylib from source (slow, one-time). Requirements:
- **CMake** + the MSVC C toolchain (the default `x86_64-pc-windows-msvc` Rust host) to build raylib.
- **LLVM / libclang** — `raylib-sys` generates bindings with `bindgen`, which needs `libclang.dll`.
  Install once with `winget install LLVM.LLVM`. LLVM isn't added to PATH, so the build needs
  `LIBCLANG_PATH=C:\Program Files\LLVM\bin` (handled by `build-rust.bat`).

### C++ (MSVC)
`cl.exe` needs the Visual Studio dev environment; the script loads it via `vcvars64.bat`:
```
galaga\build-cpp.bat
galaga\cpp\build\Release\galaga_cpp.exe
```
Manual equivalent (from a *x64 Native Tools Command Prompt*):
```
cmake -S galaga\cpp -B galaga\cpp\build -G "Visual Studio 17 2022" -A x64
cmake --build galaga\cpp\build --config Release
```
First configure downloads + builds raylib via CMake `FetchContent` (slow, one-time).

## Gameplay (identical in both)
Formation fly-in along spline paths → swaying formation → enemies peel off in curved dive attacks
dropping bombs → boss **tractor-beam capture** (costs a life; shoot the captor to free your fighter
into a **dual fighter**) → **challenging stages** every 4th wave (fly-through, no attacks, bonus
hits) → lives, scoring, extra life at 20,000, high score, game-over/restart.

## Shared constants
Both builds define the same numbers in `entities.{hpp,rs}` — screen 600×760, fixed `DT = 1/60`,
player/bullet/bomb/enemy sizes & speeds, the 8×5 formation grid, scoring, etc. Keep them in sync.

## Notes
- Sprites are drawn procedurally as shapes — no asset files, so both render identical art.
- Audio is out of scope for this first pass.
- The RNG is a tiny deterministic LCG with the same seed in both, so runs are reproducible.
