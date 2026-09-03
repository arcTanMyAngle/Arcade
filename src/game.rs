//! game.rs — Milestone 6: the top-level game-flow state machine.
//!
//! M1–M5 built a playable race+combat *loop*; this wraps it in an actual *game*:
//!
//! ```text
//!   Menu ──► ClassSelect ──► Race ──► Results ──► Menu
//! ```
//!
//! [`Game`] owns everything that used to live as locals in `main`: the world, the
//! whole simulation (karts/race/combat/particles), the CPU-side meshes, and the
//! fixed-step accumulator. It is **fully headless** — `Game::new` and
//! [`Game::update`] touch no GPU and no window, so the entire flow (and the
//! class→kart-0 propagation) is unit-testable. The only things that stay in
//! `main` are the GPU [`Shaders`](crate::shaders) and the `draw_*` calls.
//!
//! ## How it honors the engine invariants
//! * The 60 Hz fixed-step loop ([`run_substeps`](Game::run_substeps)) is the same
//!   one from `main`, relocated verbatim onto `self.*` fields — gameplay logic
//!   still only runs inside the `FIXED_DT` accumulator and rendering interpolates
//!   via [`Game::alpha`].
//! * Pause freezes the sim by simply running **zero** substeps and holding the
//!   accumulator at 0, so resuming never fast-forwards.
//! * Transitions (committing a class, restarting) may allocate — they are *not*
//!   the gameplay loop. Steady-state ticks reuse the same pre-sized buffers as
//!   before; nothing new is allocated per tick.

use macroquad::models::Mesh;
use macroquad::prelude::*;

use crate::audio::{Sfx, SfxQueue, MASTER_VOLUME};
use crate::combat::{ChassisClass, Combat};
use crate::mesh_gen::{
    build_accel_strip_mesh, build_ammo_crate_mesh, build_boost_pad_mesh, build_kart_mesh,
    build_projectile_meshes, build_wheel_mesh, KART_PALETTE,
};
use crate::physics::{
    compute_ai_inputs, step_all, Input, KartState, ParticleSystem, SparkStage, FIXED_DT,
};
use crate::race::{Phase, RaceDirector, TOTAL_LAPS};
use crate::track_3d::TrackSpline;

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

/// Player (index 0) + 7 AI. Single source of truth for the grid size — `main`
/// imports this so its fixed-size standings buffer stays in sync.
pub const NUM_KARTS: usize = 8;
const NUM_AMMO_CRATES: usize = 12;
const PARTICLE_CAPACITY: usize = 1024;

// --- juice (Milestone 9) ---
/// Substeps the whole sim freezes for on a heavy hit (the player being spun out),
/// for impact emphasis. Time still passes (the accumulator drains), so the fixed
/// clock catches up afterward with no drift. ≤ 3 per the milestone DoD.
const HITSTOP_SUBSTEPS: u32 = 3;
/// Camera-shake ceiling and decay rate. `SHAKE_DECAY = 3.0` ⇒ a full 1.0 shake
/// falls to 0 in ~0.33 s (< 0.4 s).
const SHAKE_MAX: f32 = 1.0;
const SHAKE_DECAY: f32 = 3.0;
/// A one-tick position jump beyond this (m²) is treated as a teleport (OOB respawn),
/// and the render-interpolation `prev` is snapped so it doesn't streak. A normal
/// tick moves under ~1 m, so this never trips in ordinary play.
const RESPAWN_SNAP_DIST2: f32 = 30.0 * 30.0;

/// The four chassis classes in class-select order. Index 0 (Warden) is the
/// forgiving default, matching [`ChassisClass::for_index(0)`]. The class cursor
/// indexes this array, and `preview_meshes` is built parallel to it.
pub const CLASS_ORDER: [ChassisClass; 4] = [
    ChassisClass::Warden,
    ChassisClass::Stinger,
    ChassisClass::Juggernaut,
    ChassisClass::Phantom,
];

/// The selectable circuits, in track-select order. Parallel to [`TRACK_NAMES`];
/// the track cursor indexes both. Each entry is a constructor so a fresh spline
/// (with its own boost pads) is built only when a track is actually chosen.
pub const TRACK_ORDER: [fn() -> TrackSpline; 3] =
    [TrackSpline::demo_circuit, TrackSpline::speedway, TrackSpline::serpentine];
pub const TRACK_NAMES: [&str; 3] = ["CIRCUIT", "SPEEDWAY", "SERPENTINE"];

// --- settings (Milestone 11) ---
/// Fewest karts a race can run (the player plus one AI). The most is [`NUM_KARTS`]
/// — buffers are sized to that, so a smaller field simply simulates/renders fewer.
pub const MIN_KARTS: usize = 2;
/// Lap-target bounds for the race.
pub const MIN_LAPS: u8 = 1;
pub const MAX_LAPS: u8 = 9;
/// Chase-camera base-FOV bounds (radians) + adjust step; the default matches
/// `main::BASE_FOV`. The speed/boost swell adds on top of this at run time.
pub const FOV_MIN: f32 = 0.75;
pub const FOV_MAX: f32 = 1.35;
pub const FOV_STEP: f32 = 0.05;
pub const DEFAULT_FOV: f32 = 1.0;
/// Master-volume adjust step, shared by the Settings screen and the `[` / `]` keys.
pub const VOLUME_STEP: f32 = 0.05;
/// Adjustable rows on the Settings screen, in display order:
/// VOLUME · RACERS · LAPS · TRACK · FOV.
pub const SETTINGS_ROWS: usize = 5;

/// Session-persistent race configuration, edited on the M11 Settings screen and
/// applied at race start. It is a plain `Copy` value — nothing here touches the
/// gameplay loop; a smaller `active_karts` only shrinks the working sub-slices, so
/// there is never a per-tick reallocation (buffers stay sized to [`NUM_KARTS`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Master audio volume, 0..1. `main` mirrors this into the `AudioBank` each frame.
    pub master_volume: f32,
    /// Karts that race (player + AI), in `MIN_KARTS..=NUM_KARTS`.
    pub active_karts: usize,
    /// Laps to finish, in `MIN_LAPS..=MAX_LAPS`.
    pub lap_count: u8,
    /// Remembered circuit (indexes [`TRACK_ORDER`]); seeds `track_cursor` when the
    /// player enters TrackSelect, and is updated to whatever they actually race.
    pub default_track: usize,
    /// Chase-camera base FOV in radians; the run-time speed/boost swell adds on top.
    pub fov: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            master_volume: MASTER_VOLUME,
            active_karts: NUM_KARTS,
            lap_count: TOTAL_LAPS,
            default_track: 0,
            fov: DEFAULT_FOV,
        }
    }
}

// ----------------------------------------------------------------------------
// Flow types
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameState {
    /// Front-end: title + prompt over a slow-orbit backdrop.
    Menu,
    /// Pick the chassis that drives kart 0 (live 3D preview + stat panel).
    ClassSelect,
    /// Pick the circuit (overhead preview + length/pad readout). Sits between
    /// class-select and the race (M8).
    TrackSelect,
    /// Session options: volume, field size, laps, default track, FOV (M11).
    /// Reached from the Menu; changes persist for the session.
    Settings,
    /// The race is live (or paused, or counting down — see [`RaceDirector`]).
    Race,
    /// The finish board; the sim is frozen behind it.
    Results,
}

/// Returned by [`Game::update`]; `Quit` asks `main` to leave the loop.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flow {
    Continue,
    Quit,
}

/// One frame's high-level intents, sampled from raw keys in `main` and injected
/// as a plain value — that's what lets the state machine run without a window.
/// `confirm`/`cancel`/`restart`/`nav` are edge-triggered; `player` is the held
/// driving input, used only while racing.
#[derive(Clone, Copy, Default)]
pub struct FrameInput {
    pub confirm: bool, // Enter
    pub cancel: bool,  // Esc (context-dependent: quit / back / pause / resume)
    pub restart: bool, // R
    pub nav: i8,       // -1 / +1 horizontal cursor / value adjust (Left / Right)
    pub nav_v: i8,     // -1 / +1 vertical cursor (Up / Down): menu + settings rows (M11)
    pub player: Input, // driving (Race only)
}

// ----------------------------------------------------------------------------
// The game
// ----------------------------------------------------------------------------

/// Owns the whole game: flow state plus all simulation and CPU-mesh resources.
/// Fields are `pub` so `main`'s render layer can read them, matching the
/// pub-field style of [`RaceDirector`] and [`Combat`].
pub struct Game {
    // -- flow --
    pub state: GameState,
    pub paused: bool,
    pub class_cursor: usize,
    /// Session options (M11), persisted across races and applied at `start_race`.
    pub settings: Settings,
    /// Highlighted item on the main menu: 0 = START, 1 = SETTINGS (M11).
    pub menu_cursor: usize,
    /// Highlighted row on the Settings screen (indexes the [`SETTINGS_ROWS`] rows).
    pub settings_cursor: usize,
    /// Karts actually racing this session, snapshotted from `settings.active_karts`
    /// at `start_race` (in `MIN_KARTS..=NUM_KARTS`). The sim + render operate on the
    /// leading `active_karts` slice of the (full-capacity) buffers — M11 field size.
    pub active_karts: usize,
    /// Highlighted circuit on the track-select screen (indexes [`TRACK_ORDER`]).
    pub track_cursor: usize,
    /// Set when [`start_race`](Game::start_race) rebuilds `track`, so `main` knows
    /// to regenerate its GPU road meshes. `main` clears it after rebuilding.
    pub track_dirty: bool,
    /// Substeps run during the last [`update`](Game::update) (0 while paused /
    /// outside Race) — the pause-freeze assertion reads this.
    pub last_substeps: u32,
    /// Substeps *skipped* by hit-stop during the last [`update`](Game::update) (M9).
    pub last_skipped: u32,
    /// Remaining hit-stop substeps: while > 0 the sim freezes (time still drains).
    pub hitstop: u32,
    /// Camera-shake intensity in `0..SHAKE_MAX` (M9). Fed by `combat.trauma` +
    /// player-spinout kicks, decays each substep; `main` reads it for the camera.
    pub shake: f32,
    /// Render interpolation factor for the current frame, in `[0, 1]`.
    pub alpha: f32,
    /// One-shot audio events recorded this frame (combat hits, boosts, countdown
    /// cues, flow transitions). Cleared at the top of [`update`](Game::update) and
    /// drained by `main` right after — the sim itself stays device-free.
    pub events: SfxQueue,

    // -- world (immutable after build) --
    pub track: TrackSpline,
    pub kart_meshes: Vec<Mesh>,
    pub wheel_mesh: Mesh,
    pub crate_mesh: Mesh,
    pub proj_meshes: Vec<Mesh>,
    /// Single boost-pad mesh, instanced at every pad on the current track (M8).
    pub pad_mesh: Mesh,
    /// Single accel-strip mesh, instanced at every strip on the current track (M14).
    pub accel_strip_mesh: Mesh,
    /// One spinning-preview kart per [`CLASS_ORDER`] entry (class-select screen).
    pub preview_meshes: Vec<Mesh>,

    // -- simulation (reused buffers; zero per-tick allocation) --
    pub karts: Vec<KartState>,
    pub prev_karts: Vec<KartState>,
    pub inputs: Vec<Input>,
    pub places: Vec<u8>,
    /// Per-kart gap behind the leader (rank-key units), refilled each substep and
    /// fed to the AI passes for M10 rubber-band catch-up. Parallel to `karts`.
    pub gaps: Vec<f32>,
    pub skills: Vec<f32>,
    pub particles: ParticleSystem,
    pub race: RaceDirector,
    pub combat: Combat,
    pub classes: Vec<ChassisClass>,

    /// Last countdown banner we beeped on (persisted across frames so the very
    /// first "3" cues; reset on every grid respawn).
    prev_countdown_label: &'static str,
    accumulator: f32,
}

impl Game {
    /// Build the world and seed the simulation; start at the menu. Headless —
    /// no GPU, no window (meshes are CPU vertex data, spawn uses no RNG).
    pub fn new() -> Self {
        let track = TrackSpline::demo_circuit();

        let classes: Vec<ChassisClass> = (0..NUM_KARTS).map(ChassisClass::for_index).collect();
        let kart_meshes: Vec<Mesh> = (0..NUM_KARTS)
            .map(|i| {
                let (body, accent) = KART_PALETTE[i % KART_PALETTE.len()];
                build_kart_mesh(body, accent, classes[i])
            })
            .collect();
        // A preview kart per class, painted in its signature color so the four
        // archetypes read at a glance on the select screen.
        let preview_meshes: Vec<Mesh> = CLASS_ORDER
            .iter()
            .map(|&c| build_kart_mesh(shade(c.color(), 0.55), c.color(), c))
            .collect();

        let karts: Vec<KartState> = (0..NUM_KARTS).map(|i| KartState::spawn(&track, i)).collect();
        let prev_karts = karts.clone();
        let inputs = vec![Input::default(); NUM_KARTS];
        let places = vec![1u8; NUM_KARTS];
        let gaps = vec![0.0f32; NUM_KARTS];
        let skills: Vec<f32> = (0..NUM_KARTS).map(|i| 0.55 + (i as f32 * 0.07) % 0.45).collect();
        let particles = ParticleSystem::with_capacity(PARTICLE_CAPACITY);

        let race = RaceDirector::new(&track, &karts);
        let combat = Combat::new(&track, &classes, NUM_AMMO_CRATES);

        Self {
            state: GameState::Menu,
            paused: false,
            class_cursor: 0,
            settings: Settings::default(),
            menu_cursor: 0,
            settings_cursor: 0,
            active_karts: NUM_KARTS,
            track_cursor: 0,
            track_dirty: false,
            last_substeps: 0,
            last_skipped: 0,
            hitstop: 0,
            shake: 0.0,
            alpha: 0.0,
            events: SfxQueue::new(),
            track,
            kart_meshes,
            wheel_mesh: build_wheel_mesh(),
            crate_mesh: build_ammo_crate_mesh(),
            proj_meshes: build_projectile_meshes(),
            pad_mesh: build_boost_pad_mesh(),
            accel_strip_mesh: build_accel_strip_mesh(),
            preview_meshes,
            karts,
            prev_karts,
            inputs,
            places,
            gaps,
            skills,
            particles,
            race,
            combat,
            classes,
            prev_countdown_label: "",
            accumulator: 0.0,
        }
    }

    /// The class currently highlighted on the select screen.
    #[inline]
    pub fn selected_class(&self) -> ChassisClass {
        CLASS_ORDER[self.class_cursor]
    }

    /// The circuit name currently highlighted on the track-select screen.
    #[inline]
    pub fn selected_track_name(&self) -> &'static str {
        TRACK_NAMES[self.track_cursor]
    }

    /// Advance the flow one frame. `real_dt` is the wall-clock frame time; the
    /// sim is stepped only in `Race` while unpaused. Returns [`Flow::Quit`] when
    /// the player exits from the menu.
    pub fn update(&mut self, fi: &FrameInput, real_dt: f32) -> Flow {
        self.last_substeps = 0;
        self.last_skipped = 0;
        self.events.clear(); // a fresh queue each frame; `main` drains it after this
        match self.state {
            GameState::Menu => {
                if fi.cancel {
                    return Flow::Quit;
                }
                // Two items (START / SETTINGS); either arrow axis moves between them.
                let mv = if fi.nav_v != 0 { fi.nav_v } else { fi.nav };
                if mv != 0 {
                    self.menu_cursor = (self.menu_cursor as i32 + mv as i32).rem_euclid(2) as usize;
                    self.events.push(Sfx::MenuMove);
                }
                if fi.confirm {
                    if self.menu_cursor == 0 {
                        self.state = GameState::ClassSelect;
                    } else {
                        self.settings_cursor = 0;
                        self.state = GameState::Settings;
                    }
                    self.events.push(Sfx::MenuConfirm);
                }
            }
            GameState::Settings => {
                // Esc or Enter both leave (options persist on the `Game`).
                if fi.cancel || fi.confirm {
                    self.state = GameState::Menu;
                    self.events.push(Sfx::MenuBack);
                } else {
                    if fi.nav_v != 0 {
                        self.settings_cursor = (self.settings_cursor as i32 + fi.nav_v as i32)
                            .rem_euclid(SETTINGS_ROWS as i32)
                            as usize;
                        self.events.push(Sfx::MenuMove);
                    }
                    if fi.nav != 0 {
                        self.adjust_setting(self.settings_cursor, fi.nav);
                        self.events.push(Sfx::MenuMove);
                    }
                }
            }
            GameState::ClassSelect => {
                if fi.cancel {
                    self.state = GameState::Menu;
                    self.events.push(Sfx::MenuBack);
                } else {
                    if fi.nav != 0 {
                        let n = CLASS_ORDER.len() as i32;
                        self.class_cursor =
                            (self.class_cursor as i32 + fi.nav as i32).rem_euclid(n) as usize;
                        self.events.push(Sfx::MenuMove);
                    }
                    if fi.confirm {
                        // Enter TrackSelect at the remembered default circuit (M11).
                        self.track_cursor = self.settings.default_track.min(TRACK_ORDER.len() - 1);
                        self.state = GameState::TrackSelect; // pick the circuit next
                        self.events.push(Sfx::MenuConfirm);
                    }
                }
            }
            GameState::TrackSelect => {
                if fi.cancel {
                    self.state = GameState::ClassSelect;
                    self.events.push(Sfx::MenuBack);
                } else {
                    if fi.nav != 0 {
                        let n = TRACK_ORDER.len() as i32;
                        self.track_cursor =
                            (self.track_cursor as i32 + fi.nav as i32).rem_euclid(n) as usize;
                        self.events.push(Sfx::MenuMove);
                    }
                    if fi.confirm {
                        self.start_race(); // commits class + builds the chosen track
                        self.events.push(Sfx::MenuConfirm);
                    }
                }
            }
            GameState::Race => {
                if fi.restart {
                    self.restart_race();
                } else if self.paused {
                    if fi.cancel {
                        self.paused = false;
                        self.events.push(Sfx::MenuBack); // resume
                    } else if fi.confirm {
                        self.to_menu();
                        self.events.push(Sfx::MenuBack);
                    }
                    self.accumulator = 0.0; // never bank time while paused
                } else if fi.cancel {
                    self.paused = true;
                    self.events.push(Sfx::MenuBack); // pause
                    self.accumulator = 0.0;
                } else {
                    self.last_substeps = self.run_substeps(fi.player, real_dt);
                    // The board pops the instant the human player finishes.
                    if self.race.phase == Phase::Finished {
                        self.state = GameState::Results;
                    }
                }
            }
            GameState::Results => {
                if fi.confirm {
                    self.to_menu();
                    self.events.push(Sfx::MenuConfirm);
                } else if fi.restart {
                    self.restart_race();
                }
            }
        }
        Flow::Continue
    }

    // -- settings -----------------------------------------------------------

    /// Adjust the settings `row` by `dir` (−1 / +1), each within its documented
    /// range. Pure state edit — nothing here allocates or touches the sim. The
    /// Settings screen calls this on a Left/Right press for the highlighted row.
    fn adjust_setting(&mut self, row: usize, dir: i8) {
        let s = &mut self.settings;
        match row {
            0 => s.master_volume = (s.master_volume + dir as f32 * VOLUME_STEP).clamp(0.0, 1.0),
            1 => {
                s.active_karts = (s.active_karts as i32 + dir as i32)
                    .clamp(MIN_KARTS as i32, NUM_KARTS as i32) as usize
            }
            2 => {
                s.lap_count = (s.lap_count as i32 + dir as i32)
                    .clamp(MIN_LAPS as i32, MAX_LAPS as i32) as u8
            }
            3 => {
                let n = TRACK_ORDER.len() as i32;
                s.default_track = (s.default_track as i32 + dir as i32).rem_euclid(n) as usize;
            }
            4 => s.fov = (s.fov + dir as f32 * FOV_STEP).clamp(FOV_MIN, FOV_MAX),
            _ => {}
        }
    }

    // -- transitions --------------------------------------------------------

    /// Commit the highlighted class **and circuit**, then drop into a fresh race.
    /// Rebuilds kart 0's mesh (it wears the class cannon), the selected track (with
    /// its boost pads), and the combat manager (its grid + crates are sized to the
    /// track); AI keep their round-robin classes. `main` rebuilds the GPU road
    /// meshes when it sees `track_dirty`.
    fn start_race(&mut self) {
        let class = self.selected_class();
        self.classes[0] = class;
        let (body, accent) = KART_PALETTE[0];
        self.kart_meshes[0] = build_kart_mesh(body, accent, class);
        // Apply the session settings (M11): lock in the field size + lap target,
        // and remember the circuit we're about to race as the new default.
        self.active_karts = self.settings.active_karts.clamp(MIN_KARTS, NUM_KARTS);
        self.race.laps = self.settings.lap_count.clamp(MIN_LAPS, MAX_LAPS);
        self.settings.default_track = self.track_cursor;
        self.track = TRACK_ORDER[self.track_cursor]();
        self.track_dirty = true;
        self.combat = Combat::new(&self.track, &self.classes, NUM_AMMO_CRATES);
        self.respawn_grid();
        self.paused = false;
        self.state = GameState::Race;
    }

    /// Re-run the same race (the `R` key). Keeps every kart's class —
    /// [`Combat::reset`] re-arms in place, so no reallocation.
    fn restart_race(&mut self) {
        self.combat.reset();
        self.respawn_grid();
        self.paused = false;
        self.state = GameState::Race;
    }

    /// Return to the front-end, tidying the grid so the menu backdrop looks fresh.
    fn to_menu(&mut self) {
        self.respawn_grid();
        self.paused = false;
        self.state = GameState::Menu;
    }

    /// Re-spawn every kart onto the starting grid and re-arm the countdown.
    fn respawn_grid(&mut self) {
        for (i, k) in self.karts.iter_mut().enumerate() {
            *k = KartState::spawn(&self.track, i);
        }
        self.prev_karts.copy_from_slice(&self.karts);
        // The race (and thus every downstream `_into` buffer) is sized to the active
        // field only (M11) — parked karts beyond `active_karts` never enter standings.
        self.race.reset(&self.track, &self.karts[..self.active_karts]);
        self.accumulator = 0.0;
        self.alpha = 0.0;
        self.hitstop = 0;
        self.shake = 0.0;
        self.prev_countdown_label = ""; // so the next "3" beeps
    }

    // -- fixed-step simulation ---------------------------------------------

    /// The 60 Hz fixed-step loop (relocated from `main`). Drains `real_dt` into
    /// the accumulator and runs whole substeps; sets [`Game::alpha`] for the
    /// renderer and returns how many substeps ran this frame.
    fn run_substeps(&mut self, player: Input, real_dt: f32) -> u32 {
        self.accumulator += real_dt.min(0.25); // clamp to dodge the spiral-of-death
        let mut n = 0;
        let mut skipped = 0;
        let mut first = true;
        // Everything below operates on the leading `active_karts` slice of the
        // (full-capacity) buffers (M11) — a smaller field just does less work; the
        // parked tail is never read. Rayon parallelizes over the slice, so fewer
        // karts is strictly faster (0 new allocation either way).
        let m = self.active_karts;

        while self.accumulator >= FIXED_DT {
            // Drain time first so a hit-stop still advances the fixed clock.
            self.accumulator -= FIXED_DT;

            // Hit-stop (M9): freeze the whole sim for a few substeps after a heavy
            // hit. Time already drained above, so the clock catches up — no drift.
            if self.hitstop > 0 {
                self.hitstop -= 1;
                skipped += 1;
                continue;
            }

            // Gap-behind-leader for every kart, so trailing AI get an honest
            // rubber-band lift to their driving skill and drift-farm aggression (M10).
            self.race.gaps_into(&mut self.gaps[..m]);
            // AI for everyone (cheap), then stamp the player's input on slot 0.
            compute_ai_inputs(
                &self.karts[..m],
                &self.skills[..m],
                &self.gaps[..m],
                &self.track,
                &mut self.inputs[..m],
            );
            self.inputs[0] = player;
            if !first {
                // Edge-triggered actions fire only on the first substep of a frame.
                self.inputs[0].drift_pressed = false;
                self.inputs[0].trick_pressed = false;
                self.inputs[0].use_item = false;
            }
            // Combat AI nudges the AI karts' driving (dodge / aim / catch-up drift).
            if self.race.phase == Phase::Racing {
                self.race.places_into(&mut self.places[..m]);
                self.combat
                    .plan_ai(&self.karts[..m], &self.places[..m], &self.gaps[..m], &mut self.inputs[..m]);
            }
            // Freeze the grid during "3..2..1" and after the finish.
            if self.race.inputs_locked() {
                for inp in self.inputs[..m].iter_mut() {
                    *inp = Input::default();
                }
            }
            // A spun-out kart loses control until its stun expires.
            for i in 0..m {
                if self.combat.stunned(i) {
                    self.inputs[i] = Input::default();
                }
            }

            self.prev_karts[..m].copy_from_slice(&self.karts[..m]);
            // `combat.draft` carries the previous substep's slipstream factors
            // (M5.1) — a parallel array fed in like `inputs`. Disjoint fields, so
            // the borrow checker allows the `&mut karts` + `&combat.draft` overlap.
            step_all(
                &mut self.karts[..m],
                &self.inputs[..m],
                &self.combat.draft[..m],
                &self.track,
                FIXED_DT,
            );

            // An OOB respawn inside `step_all` teleports a kart; snap its render
            // `prev` so the interpolation doesn't streak across the map (M9).
            for i in 0..m {
                if self.karts[i].position.distance_squared(self.prev_karts[i].position)
                    > RESPAWN_SNAP_DIST2
                {
                    self.prev_karts[i] = self.karts[i];
                }
            }

            // Race-state diffs → audio cues (single-threaded, post-step).
            let prev_phase = self.race.phase;
            let prev_lap0 = self.race.progress[0].lap;
            self.race.update(&self.karts[..m], FIXED_DT);
            self.emit_race_audio(prev_phase, prev_lap0);

            let was_stunned = self.combat.stunned(0);
            self.combat.step(
                &mut self.karts[..m],
                &self.inputs[..m],
                &self.track,
                &mut self.particles,
                &mut self.events,
                &self.places[..m],
                self.race.phase == Phase::Racing,
                FIXED_DT,
            );

            // Player boost edge (drift mini-turbo or trick landing). `prev_karts`
            // holds this substep's pre-`step_all` state, so this is a true edge.
            if !self.prev_karts[0].is_boosting() && self.karts[0].is_boosting() {
                self.events.push(Sfx::Boost);
            }

            // M9 juice: a fresh player spin-out kicks a full shake + a hit-stop
            // (the impact "lands" before the freeze, which begins next substep).
            if !was_stunned && self.combat.stunned(0) {
                self.hitstop = HITSTOP_SUBSTEPS;
                self.shake = SHAKE_MAX;
            }
            // Fold this substep's combat trauma (nearby blasts / hard player bumps)
            // into the camera shake, then decay it — bounded, falls to 0 in < 0.4 s.
            self.shake = (self.shake + self.combat.trauma).min(SHAKE_MAX);
            self.shake = (self.shake - SHAKE_DECAY * FIXED_DT).max(0.0);

            // Emit particles (cheap, main thread), integrate them in parallel.
            for k in &self.karts[..m] {
                if k.spark_stage() != SparkStage::None {
                    self.particles.emit_drift_sparks(k);
                }
                if k.is_boosting() {
                    self.particles.emit_exhaust(k);
                }
            }
            self.particles.update(FIXED_DT);

            first = false;
            n += 1;
        }
        self.last_skipped = skipped;
        self.alpha = (self.accumulator / FIXED_DT).clamp(0.0, 1.0);
        n
    }

    /// Translate this substep's race-state change into audio cues: the 3-2-1
    /// countdown beeps (banner text changing), the GO chime (grid release), and
    /// the player's lap milestones (a chime per lap, a jingle on the final one).
    fn emit_race_audio(&mut self, prev_phase: Phase, prev_lap0: u8) {
        let label = self.race.countdown_label();
        if label != self.prev_countdown_label && !label.is_empty() {
            self.events.push(Sfx::CountdownBeep);
        }
        self.prev_countdown_label = label;
        if prev_phase == Phase::Countdown && self.race.phase == Phase::Racing {
            self.events.push(Sfx::CountdownGo);
        }

        let lap0 = self.race.progress[0].lap;
        if lap0 > prev_lap0 {
            // A finishing crossing flips the phase to Finished (see RaceDirector).
            if self.race.phase == Phase::Finished {
                self.events.push(Sfx::FinishJingle);
            } else {
                self.events.push(Sfx::LapChime);
            }
        }
    }
}

impl Default for Game {
    fn default() -> Self {
        Self::new()
    }
}

/// Scale an RGB color toward black (alpha preserved). Used to darken a class's
/// signature color into a preview kart body.
fn shade(c: Color, f: f32) -> Color {
    Color::new(c.r * f, c.g * f, c.b * f, c.a)
}

// ----------------------------------------------------------------------------
// Tests — the whole flow drives headlessly (no window, no GPU).
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Menu → ClassSelect → Race → Results → Menu with crafted intents. The
    /// finish condition is forced (not raced) so the test is fast + deterministic.
    #[test]
    fn flow_cycle_menu_to_results_to_menu() {
        let mut g = Game::new();
        assert_eq!(g.state, GameState::Menu);

        let confirm = FrameInput { confirm: true, ..Default::default() };
        g.update(&confirm, FIXED_DT);
        assert_eq!(g.state, GameState::ClassSelect);

        g.update(&confirm, FIXED_DT);
        assert_eq!(g.state, GameState::TrackSelect); // M8: circuit picker

        g.update(&confirm, FIXED_DT);
        assert_eq!(g.state, GameState::Race);

        // The flow watches for the player crossing the final line.
        g.race.phase = Phase::Finished;
        g.update(&FrameInput::default(), FIXED_DT);
        assert_eq!(g.state, GameState::Results);

        g.update(&confirm, FIXED_DT);
        assert_eq!(g.state, GameState::Menu);
    }

    /// Every class is selectable and the choice reaches both the class table and
    /// the combat manager that drives kart 0 (the DoD propagation requirement).
    #[test]
    fn class_selection_propagates_to_combat() {
        for cursor in 0..CLASS_ORDER.len() {
            let mut g = Game::new();
            g.state = GameState::ClassSelect;
            g.class_cursor = cursor;
            g.start_race();

            assert_eq!(g.state, GameState::Race);
            assert_eq!(g.classes[0], CLASS_ORDER[cursor]);
            assert_eq!(
                g.combat.karts[0].class,
                CLASS_ORDER[cursor],
                "selected class must drive kart 0"
            );
        }
    }

    /// Each selectable circuit flows through `start_race` into a distinct,
    /// valid track that the sim runs on (the M8 "track choice flows through Game"
    /// DoD). Distinct lengths prove the three layouts really differ.
    #[test]
    fn track_selection_builds_distinct_tracks() {
        let mut lengths = Vec::new();
        for cursor in 0..TRACK_ORDER.len() {
            let mut g = Game::new();
            g.state = GameState::TrackSelect;
            g.track_cursor = cursor;
            g.start_race();

            assert_eq!(g.state, GameState::Race);
            assert!(g.track.total_length() > 100.0);
            assert!(g.track.boost_pads().len() >= 4, "race track needs >=4 pads");
            assert!(g.track_dirty, "start_race must flag the GPU meshes stale");
            lengths.push(g.track.total_length());
        }
        // No two circuits share a length → they're genuinely different layouts.
        for i in 0..lengths.len() {
            for j in (i + 1)..lengths.len() {
                assert!((lengths[i] - lengths[j]).abs() > 1.0, "tracks {i},{j} too alike");
            }
        }
    }

    /// Hit-stop (M9) freezes the sim for exactly `hitstop` substeps, then resumes —
    /// and because time still drains, the fixed clock catches up (no long-term drift).
    #[test]
    fn hit_stop_skips_exactly_n_substeps_then_resumes() {
        let mut g = Game::new();
        g.state = GameState::ClassSelect;
        g.start_race();

        let drive = FrameInput {
            player: Input { throttle: 1.0, ..Default::default() },
            ..Default::default()
        };
        // Warm past the countdown so the sim is live and the accumulator is ~drained.
        for _ in 0..400 {
            g.update(&drive, FIXED_DT);
        }
        assert!(g.last_substeps > 0, "race should be ticking before the freeze");

        // Silence combat so no fresh spin-out re-arms the hit-stop mid-measurement.
        for kc in &mut g.combat.karts {
            kc.ammo = 0;
        }
        for p in &mut g.combat.projectiles {
            p.life = 0.0;
        }

        // Force a 3-substep freeze, then feed enough time for 5 substeps.
        g.hitstop = 3;
        g.update(&drive, FIXED_DT * 5.0);
        assert_eq!(g.last_skipped, 3, "should skip exactly the hit-stop substeps");
        assert!(g.last_substeps >= 1, "should resume real substeps after the freeze");
        assert_eq!(g.hitstop, 0, "hit-stop should be fully spent");
        assert!(g.accumulator < FIXED_DT, "fixed clock should catch up — no drift");
    }

    /// Screen-shake (M9) stays bounded by `SHAKE_MAX` and decays to ~0 within 0.4 s
    /// once no new trauma arrives.
    #[test]
    fn screen_shake_is_bounded_and_decays() {
        let mut g = Game::new();
        g.state = GameState::ClassSelect;
        g.start_race();

        let drive = FrameInput {
            player: Input { throttle: 1.0, ..Default::default() },
            ..Default::default()
        };
        for _ in 0..240 {
            g.update(&drive, FIXED_DT);
        }

        // Isolate the player: silence cannons and lift the field away so nothing
        // injects fresh trauma (fires or bumps) during the decay window.
        for kc in &mut g.combat.karts {
            kc.ammo = 0;
        }
        for p in &mut g.combat.projectiles {
            p.life = 0.0;
        }
        for i in 1..g.karts.len() {
            g.karts[i].position.y += 500.0;
        }

        // Kick the shake to the ceiling, then let it decay with no new trauma.
        g.shake = SHAKE_MAX;
        let mut peak = g.shake;
        for _ in 0..24 {
            g.update(&drive, FIXED_DT);
            peak = peak.max(g.shake);
        }
        assert!(peak <= SHAKE_MAX + 1e-6, "shake must stay bounded, peaked at {peak}");
        assert!(g.shake < 0.05, "shake should decay to ~0 within 0.4 s, got {}", g.shake);
    }

    /// Esc pauses the race: zero substeps run and no kart moves; resuming ticks
    /// again. Exercises the freeze invariant the DoD calls out.
    #[test]
    fn pause_freezes_sim() {
        let mut g = Game::new();
        g.state = GameState::ClassSelect;
        g.start_race();

        // Run past the countdown so the sim is actually moving karts.
        let drive = FrameInput {
            player: Input { throttle: 1.0, ..Default::default() },
            ..Default::default()
        };
        for _ in 0..400 {
            g.update(&drive, FIXED_DT);
        }
        assert!(g.last_substeps > 0, "race should be ticking before we pause");

        // Pause (Esc).
        g.update(&FrameInput { cancel: true, ..Default::default() }, FIXED_DT);
        assert!(g.paused);
        let frozen = g.karts[0].position;

        // A whole simulated second while paused must change nothing.
        g.update(&FrameInput::default(), 1.0);
        assert_eq!(g.last_substeps, 0, "paused sim must run zero substeps");
        assert_eq!(g.karts[0].position, frozen, "paused sim must not move karts");

        // Resume (Esc) and confirm it ticks again.
        g.update(&FrameInput { cancel: true, ..Default::default() }, FIXED_DT);
        assert!(!g.paused);
        g.update(&drive, FIXED_DT * 2.0);
        assert!(g.last_substeps > 0, "resumed sim must run substeps again");
    }

    /// M11 DoD: the chosen lap target and field size flow through `start_race`
    /// into the running race, for a few combinations.
    #[test]
    fn settings_propagate_into_race() {
        for &(laps, racers) in &[(1u8, 2usize), (5, 6), (MAX_LAPS, NUM_KARTS)] {
            let mut g = Game::new();
            g.settings.lap_count = laps;
            g.settings.active_karts = racers;
            g.state = GameState::TrackSelect;
            g.start_race();

            assert_eq!(g.state, GameState::Race);
            assert_eq!(g.race.laps, laps, "chosen lap target must reach the director");
            assert_eq!(g.active_karts, racers, "chosen field size must be locked in");
            assert_eq!(g.race.progress.len(), racers, "only the chosen field races");
        }
    }

    /// The Settings screen is reachable from the Menu and back, and an edit made
    /// there survives leaving the screen (session persistence).
    #[test]
    fn settings_reachable_from_menu_and_back() {
        let mut g = Game::new();
        // Down highlights SETTINGS (item 1); Enter opens it.
        g.update(&FrameInput { nav_v: 1, ..Default::default() }, FIXED_DT);
        assert_eq!(g.menu_cursor, 1);
        g.update(&FrameInput { confirm: true, ..Default::default() }, FIXED_DT);
        assert_eq!(g.state, GameState::Settings);

        // Move to the RACERS row (row 1) and nudge the field size down.
        let before = g.settings.active_karts;
        g.update(&FrameInput { nav_v: 1, ..Default::default() }, FIXED_DT);
        g.update(&FrameInput { nav: -1, ..Default::default() }, FIXED_DT);
        assert_eq!(g.settings.active_karts, before - 1);

        // Esc returns to the menu; the edit persists.
        g.update(&FrameInput { cancel: true, ..Default::default() }, FIXED_DT);
        assert_eq!(g.state, GameState::Menu);
        assert_eq!(g.settings.active_karts, before - 1, "settings persist for the session");
    }

    /// Value clamps hold at both ends of every adjustable row.
    #[test]
    fn settings_adjust_clamps_at_bounds() {
        let mut g = Game::new();
        // Field size: drive it far past both limits.
        for _ in 0..20 {
            g.adjust_setting(1, -1);
        }
        assert_eq!(g.settings.active_karts, MIN_KARTS);
        for _ in 0..20 {
            g.adjust_setting(1, 1);
        }
        assert_eq!(g.settings.active_karts, NUM_KARTS);
        // Laps.
        for _ in 0..20 {
            g.adjust_setting(2, -1);
        }
        assert_eq!(g.settings.lap_count, MIN_LAPS);
        for _ in 0..20 {
            g.adjust_setting(2, 1);
        }
        assert_eq!(g.settings.lap_count, MAX_LAPS);
        // Volume stays in [0, 1].
        for _ in 0..40 {
            g.adjust_setting(0, 1);
        }
        assert!(g.settings.master_volume <= 1.0 + 1e-6);
        for _ in 0..40 {
            g.adjust_setting(0, -1);
        }
        assert!(g.settings.master_volume >= -1e-6);
    }

    /// A smaller field really races fewer karts: standings cover exactly the field,
    /// and a parked kart (index ≥ `active_karts`) is never simulated. Also proves
    /// the options survive a full return-to-menu-and-race-again cycle.
    #[test]
    fn parked_karts_stay_out_and_options_persist() {
        let mut g = Game::new();
        g.settings.lap_count = 2;
        g.settings.active_karts = 3;
        g.state = GameState::TrackSelect;
        g.start_race();

        let parked = g.karts[5].position; // well beyond the 3-kart field
        let drive = FrameInput {
            player: Input { throttle: 1.0, ..Default::default() },
            ..Default::default()
        };
        for _ in 0..400 {
            g.update(&drive, FIXED_DT);
        }
        assert_eq!(g.race.progress.len(), 3, "standings only cover the active field");
        assert_eq!(g.karts[5].position, parked, "a parked kart is never simulated");
        assert!(g.race.player_position() as usize <= 3, "position can't exceed the field");

        // Return to the menu and race again with no re-entry to Settings.
        g.to_menu();
        assert_eq!(g.settings.lap_count, 2, "options survive returning to the menu");
        assert_eq!(g.settings.active_karts, 3);
        g.state = GameState::TrackSelect;
        g.start_race();
        assert_eq!(g.race.laps, 2);
        assert_eq!(g.race.progress.len(), 3);
    }

    /// AI weapons stay cold for the first beat after the lights go out, so the
    /// front-row player isn't point-blank shelled at the line. Regression for the
    /// "immediately shot as the race starts" report.
    #[test]
    fn ai_weapons_hold_at_the_start() {
        let mut g = Game::new();
        g.state = GameState::TrackSelect;
        g.start_race();
        // Drive off the line but never fire (player input has fire = false).
        let drive = FrameInput {
            player: Input { throttle: 1.0, ..Default::default() },
            ..Default::default()
        };
        // Run through the 3.5 s countdown and ~0.5 s into the race.
        for _ in 0..240 {
            g.update(&drive, FIXED_DT);
        }
        assert_eq!(g.race.phase, Phase::Racing, "should be racing by now");
        let live = g.combat.projectiles.iter().filter(|p| p.alive()).count();
        assert_eq!(live, 0, "no AI shots should fly in the opening moments after GO");
    }
}
