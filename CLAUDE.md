# Arcade — repo orientation

Four independent projects share this repo. **Load only the docs for the project you're touching.**

| Project | Where | Read first | Build / test |
|---|---|---|---|
| Wii Kart (Rust/macroquad 3D racer) | `src/`, `Cargo.toml` (repo root) | `handoff.md` then `plan.md` (both root, kart-only) | `cargo run --release` · `cargo test` |
| Uncanny Carnival (Three.js skill suite) | `carnival/` | `carnival/claude.md` then `carnival/handoff.md` | `cd carnival && npm run dev` · `npm test` |
| Galaga ×2 (C++ & Rust benchmark twins) | `galaga/` | `galaga/README.md` | `galaga/build-cpp.bat` · `build-rust.bat` |
| HTML Cabinet (5 single-file games) | `*.html` at root | the one file | open in a browser |

Hard rules that cross projects:

- Root `handoff.md`/`plan.md`/`src/*.rs` belong to **Wii Kart only**; `carnival/*.md` to carnival only. Never mix them.
- Galaga: any gameplay change goes into **both** `galaga/cpp` and `galaga/rust`, same constants and update order — the project is a 1:1 language comparison.
- House style everywhere: deterministic fixed-timestep sim, seeded RNG (HTML cabinet is exempt), procedural assets (no binary art/audio files), honest physics (never fudge hitboxes or scores).
- Wii Kart and Carnival each define non-negotiable invariants + perf gates in their handoff docs — read them before editing, update them after every work chunk.
- Completion goals + remaining roadmap per project: see `arcade-completion-goals` in Claude's project memory (approved 2026-07-08).
