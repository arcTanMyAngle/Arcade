//! combat.rs — Milestone 2: the combat core of the Combat Grand Prix pivot.
//!
//! Replaces Mario-Kart "?" boxes with **ammo crates** (a shared currency) and
//! gives every chassis a *fixed, class-defined cannon*. Ammo is generic; how it
//! fires is your identity:
//!
//!   * [`Juggernaut`] — heavy arcing **Mortar** with a big blast radius.
//!   * [`Stinger`]    — rapid wall-skimming, **bouncing Laser** bolts.
//!   * [`Warden`]     — moderate **homing Dart** that locks the kart ahead.
//!   * [`Phantom`]    — rear-dropped **Mine** that detonates on proximity.
//!
//! ## Architecture (per the engine directives)
//! * `KartState` stays lean & `Copy`: all combat data lives in parallel arrays
//!   owned by [`Combat`] (`karts: Vec<KartCombat>`), mirroring the existing
//!   caller-owned-buffer pattern.
//! * Projectiles live in a fixed-capacity ring pool — zero allocation after
//!   construction, exactly like the particle system.
//! * Collision uses a **lock-free uniform spatial hash** ([`SpatialGrid`]):
//!   karts are inserted single-threaded once per tick; the (many) projectiles
//!   then query it **read-only** across all cores via rayon `par_iter_mut`,
//!   each writing only its own slot. Hit *effects* are applied in a cheap
//!   single-threaded pass, so the parallel phase never needs a lock.
//!
//! [`Juggernaut`]: ChassisClass::Juggernaut
//! [`Stinger`]: ChassisClass::Stinger
//! [`Warden`]: ChassisClass::Warden
//! [`Phantom`]: ChassisClass::Phantom

use crate::audio::{Sfx, SfxQueue};
use crate::physics::{Input, KartState, ParticleSystem};
use crate::track_3d::{TrackSpline, ROAD_HALF_WIDTH};
use macroquad::prelude::*;
use rayon::prelude::*;

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

const PROJECTILE_CAPACITY: usize = 256;

const SPIN_DURATION: f32 = 1.2; // how long a hit kart is stunned (seconds)
const SPIN_RATE: f32 = 18.0; // visual spin-out yaw rate (rad/s)
const HIT_SPEED_KEEP: f32 = 0.25; // speed retained after a hit

const KART_RADIUS: f32 = 1.4; // collision radius of a kart hull
// --- kart-vs-kart collision (Milestone 5) ---
const KART_RESTITUTION: f32 = 0.15; // bump bounciness (0 = dead stop, 1 = elastic)

// --- slipstream / draft (Milestone 5.1) ---
// A kart drafts when it's tucked directly behind a leader: within [MIN, MAX] metres,
// inside a ±12° rear-wake cone, both pointed roughly the same way. The 0..1 factor
// ramps/decays over RAMP/DECAY seconds and feeds physics as an overspeed allowance
// (see `DRAFT_SPEED_MULT` in physics.rs).
const DRAFT_MIN_DIST: f32 = 4.0; // too close → you're in the bumper, not the wake
const DRAFT_MAX_DIST: f32 = 14.0; // beyond this the slipstream has faded
const DRAFT_CONE_COS: f32 = 0.9781; // cos(12°): half-angle of the rear-wake cone
const DRAFT_ALIGN_MIN: f32 = 0.5; // headings must agree within ~60° (no oncoming tow)
const DRAFT_RAMP_TIME: f32 = 0.4; // seconds for the factor to climb 0 → 1 (< 0.5 s)
const DRAFT_DECAY_TIME: f32 = 0.4; // seconds for it to fall 1 → 0 once the tuck breaks
const BUMP_SCRUB: f32 = 0.20; // max fraction of speed shed on a pure side rub
const BUMP_SCRUB_FULL: f32 = 30.0; // closing speed (m/s) at which the side scrub saturates
const BUMP_SPARK_SPEED: f32 = 9.0; // closing speed (m/s) above which a contact sparks

// --- screen-shake trauma (Milestone 9) ---
// Detonations and hard player bumps deposit "trauma" (accumulated per step, read by
// game.rs into a decaying camera shake). Blasts shake by closeness to the player.
const SHAKE_RADIUS: f32 = 20.0; // a detonation past this adds no shake
const TRAUMA_BLAST: f32 = 0.9; // point-blank trauma from an AoE detonation
const TRAUMA_HIT: f32 = 0.4; // point-blank trauma from a direct (non-blast) hit
const TRAUMA_BUMP: f32 = 0.25; // trauma from a hard kart bump involving the player
const PROJ_GRAVITY: f32 = 30.0; // matches the kart sim's gravity
const LASER_RIDE_HEIGHT: f32 = 0.5; // how far a laser floats above the road
const GROUND_WINDOW: usize = 12; // LUT samples scanned for projectile ground tests

const CRATE_RADIUS: f32 = 2.2; // pickup radius
const CRATE_RESPAWN: f32 = 4.0; // seconds a crate stays empty after pickup

const FIRE_RANGE: f32 = 70.0; // AI / homing target acquisition range

// --- combat AI (Milestone 3) ---
const DODGE_LOOKAHEAD: f32 = 1.0; // seconds of incoming fire the AI reacts to
const DODGE_MISS_RADIUS: f32 = 3.4; // swerve if a bolt will pass within this
const DODGE_SCAN_RANGE: f32 = 60.0; // ignore projectiles farther than this
const MINE_REAR_RANGE: f32 = 14.0; // Phantom drops a mine when chased this close
const AIM_STEER_BIAS: f32 = 0.35; // max steer nudge to line a target-leading shot

const NONE: u16 = u16::MAX;

// ----------------------------------------------------------------------------
// Chassis classes
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChassisClass {
    Juggernaut,
    Stinger,
    Warden,
    Phantom,
}

/// Fixed cannon parameters for a class. Pure data — no per-instance state.
#[derive(Clone, Copy)]
pub struct ClassSpec {
    pub kind: ProjKind,
    pub reload: f32,     // seconds between shots
    pub speed: f32,      // muzzle speed
    pub max_ammo: u8,    // magazine the crate refills to
    pub blast: f32,      // AoE radius (0 = direct-hit only)
    pub proj_life: f32,  // projectile lifetime
    pub launch_lift: f32, // upward muzzle velocity (mortar arc)
    pub bounces: u8,     // wall bounces (laser)
    pub mass: f32,       // collision weight (relative; heavier bullies lighter)
}

impl ChassisClass {
    /// Round-robin assignment; index 0 (the player) is the forgiving Warden.
    pub fn for_index(i: usize) -> Self {
        match i % 4 {
            0 => ChassisClass::Warden,
            1 => ChassisClass::Stinger,
            2 => ChassisClass::Juggernaut,
            _ => ChassisClass::Phantom,
        }
    }

    pub fn spec(self) -> ClassSpec {
        match self {
            ChassisClass::Juggernaut => ClassSpec {
                kind: ProjKind::Mortar,
                reload: 1.5,
                speed: 30.0,
                max_ammo: 3,
                blast: 6.0,
                proj_life: 4.0,
                launch_lift: 9.0,
                bounces: 0,
                mass: 1.6, // heaviest — a rolling roadblock
            },
            ChassisClass::Stinger => ClassSpec {
                kind: ProjKind::Laser,
                reload: 0.16,
                speed: 72.0,
                max_ammo: 14,
                blast: 0.0,
                proj_life: 1.6,
                launch_lift: 0.0,
                bounces: 3,
                mass: 0.7, // lightest — gets shoved around
            },
            ChassisClass::Warden => ClassSpec {
                kind: ProjKind::Dart,
                reload: 0.9,
                speed: 46.0,
                max_ammo: 6,
                blast: 0.0,
                proj_life: 3.0,
                launch_lift: 0.0,
                bounces: 0,
                mass: 1.1, // middleweight (the player's class)
            },
            ChassisClass::Phantom => ClassSpec {
                kind: ProjKind::Mine,
                reload: 1.1,
                speed: 0.0,
                max_ammo: 5,
                blast: 4.0,
                proj_life: 16.0,
                launch_lift: 0.0,
                bounces: 0,
                mass: 0.9, // light-ish
            },
        }
    }

    /// Cosine of the half-angle within which the AI considers a forward-firing
    /// cannon "lined up". Wider (smaller cos) = fires from sloppier angles.
    /// Mine is dropped backward, so it has no forward cone (handled separately).
    pub fn aim_cone(self) -> f32 {
        match self {
            ChassisClass::Juggernaut => 0.82, // mortar, ~35°
            ChassisClass::Stinger => 0.90,    // laser, ~26°
            ChassisClass::Warden => 0.50,     // homing dart, forgiving ~60°
            ChassisClass::Phantom => -1.0,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ChassisClass::Juggernaut => "JUGGERNAUT",
            ChassisClass::Stinger => "STINGER",
            ChassisClass::Warden => "WARDEN",
            ChassisClass::Phantom => "PHANTOM",
        }
    }

    /// Signature color for HUD + projectile FX.
    pub fn color(self) -> Color {
        match self {
            ChassisClass::Juggernaut => Color::new(1.0, 0.55, 0.10, 1.0),
            ChassisClass::Stinger => Color::new(0.30, 0.95, 1.00, 1.0),
            ChassisClass::Warden => Color::new(0.70, 0.45, 1.00, 1.0),
            ChassisClass::Phantom => Color::new(0.35, 1.00, 0.50, 1.0),
        }
    }
}

// ----------------------------------------------------------------------------
// Per-kart combat state (parallel array — keeps KartState lean & Copy)
// ----------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct KartCombat {
    pub class: ChassisClass,
    pub ammo: u8,
    pub reload: f32,     // seconds until the cannon is ready again
    pub spin: f32,       // spin-out (stun) timer; > 0 means out of control
    pub spin_angle: f32, // accumulated spin-out yaw, for the renderer
}

impl KartCombat {
    fn new(class: ChassisClass) -> Self {
        Self {
            class,
            ammo: class.spec().max_ammo, // start loaded so combat is immediate
            reload: 0.0,
            spin: 0.0,
            spin_angle: 0.0,
        }
    }

    #[inline]
    pub fn stunned(&self) -> bool {
        self.spin > 0.0
    }
}

// ----------------------------------------------------------------------------
// Ammo crates (replace the floating "?" boxes)
// ----------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct AmmoCrate {
    pub pos: Vec3,
    /// > 0 while collected and hidden; counts down to respawn.
    pub cooldown: f32,
}

impl AmmoCrate {
    #[inline]
    pub fn available(&self) -> bool {
        self.cooldown <= 0.0
    }
}

// ----------------------------------------------------------------------------
// Projectiles
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProjKind {
    Mortar,
    Laser,
    Dart,
    Mine,
}

impl ProjKind {
    /// Stable index for the renderer's mesh table.
    #[inline]
    pub fn index(self) -> usize {
        match self {
            ProjKind::Mortar => 0,
            ProjKind::Laser => 1,
            ProjKind::Dart => 2,
            ProjKind::Mine => 3,
        }
    }

    /// Short weapon label for the class-select screen.
    pub fn name(self) -> &'static str {
        match self {
            ProjKind::Mortar => "MORTAR",
            ProjKind::Laser => "LASER",
            ProjKind::Dart => "DART",
            ProjKind::Mine => "MINE",
        }
    }

    /// The firing sound for this cannon — each class has its own timbre.
    #[inline]
    pub fn fire_sfx(self) -> Sfx {
        match self {
            ProjKind::Mortar => Sfx::FireMortar,
            ProjKind::Laser => Sfx::FireLaser,
            ProjKind::Dart => Sfx::FireDart,
            ProjKind::Mine => Sfx::FireMine,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Projectile {
    pub pos: Vec3,
    pub vel: Vec3,
    pub kind: ProjKind,
    pub owner: u16,
    pub target: u16, // homing target (NONE = none)
    pub life: f32,
    pub track_u: f32, // ground-query hint
    pub bounces: u8,
    pub arm: f32, // mine arming delay
    pub blast: f32,
    // -- filled by the (parallel) detect phase, consumed single-threaded --
    pub pending_hit: i16, // victim kart index, or -1
    pub detonate: bool,   // ground impact / mine trigger / expiry blast
}

impl Projectile {
    const fn dead() -> Self {
        Self {
            pos: Vec3::ZERO,
            vel: Vec3::ZERO,
            kind: ProjKind::Mortar,
            owner: NONE,
            target: NONE,
            life: 0.0,
            track_u: 0.0,
            bounces: 0,
            arm: 0.0,
            blast: 0.0,
            pending_hit: -1,
            detonate: false,
        }
    }

    #[inline]
    pub fn alive(&self) -> bool {
        self.life > 0.0
    }

    /// Advance one fixed step: motion per kind, then a read-only spatial-hash
    /// query for the nearest non-owner kart in range. Writes only `self`, so a
    /// whole pool can integrate in parallel with no locking.
    fn integrate(&mut self, dt: f32, track: &TrackSpline, positions: &[Vec3], grid: &SpatialGrid) {
        self.pending_hit = -1;
        self.detonate = false;

        self.life -= dt;
        if self.life <= 0.0 {
            // Heavy ordnance still blasts where it dies; bolts just fizzle.
            self.detonate = self.blast > 0.0 && self.kind != ProjKind::Mine;
            return;
        }

        match self.kind {
            ProjKind::Mortar => {
                self.vel.y -= PROJ_GRAVITY * dt;
                self.pos += self.vel * dt;
                let g = track.ground_query_hint(self.pos, self.track_u, GROUND_WINDOW);
                self.track_u = g.u;
                if g.height <= 0.0 {
                    self.detonate = true; // hit the deck → blast
                    self.life = 0.0;
                }
            }
            ProjKind::Laser => {
                // Skim the road surface and ricochet off the curb walls.
                self.pos += self.vel * dt;
                let g = track.ground_query_hint(self.pos, self.track_u, GROUND_WINDOW);
                self.track_u = g.u;
                let limit = ROAD_HALF_WIDTH - 0.3;
                let mut lateral = g.lateral;
                if lateral.abs() > limit {
                    // Reflect velocity about the wall normal (`right`).
                    let vn = self.vel.dot(g.right);
                    self.vel -= g.right * (2.0 * vn);
                    lateral = lateral.clamp(-limit, limit);
                    if self.bounces == 0 {
                        self.life = 0.0;
                    } else {
                        self.bounces -= 1;
                    }
                }
                // Re-seat onto the surface and keep velocity tangent to the road.
                let tangential = self.vel - g.normal * self.vel.dot(g.normal);
                if tangential.length_squared() > 1e-4 {
                    self.vel = tangential.normalize() * self.vel.length();
                }
                self.pos = g.center + g.right * lateral + g.normal * LASER_RIDE_HEIGHT;
            }
            ProjKind::Dart => {
                // Curve toward the locked target, holding muzzle speed.
                if self.target != NONE {
                    let tgt = positions[self.target as usize];
                    let to = tgt - self.pos;
                    if to.length_squared() > 1e-4 {
                        let speed = self.vel.length().max(1e-3);
                        let desired = to.normalize() * speed;
                        // Critically-damped-ish steer (lerp the velocity vector).
                        self.vel = self.vel.lerp(desired, (4.0 * dt).min(1.0));
                        self.vel = self.vel.normalize() * speed;
                    }
                }
                self.pos += self.vel * dt;
            }
            ProjKind::Mine => {
                self.arm = (self.arm - dt).max(0.0);
                // Settle onto the road and sit there.
                let g = track.ground_query_hint(self.pos, self.track_u, GROUND_WINDOW);
                self.track_u = g.u;
                self.pos = g.center + g.right * g.lateral.clamp(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH)
                    + g.normal * 0.3;
            }
        }

        // Proximity / contact test against karts via the spatial hash. Mines
        // only bite once armed; everything else hits on contact.
        let armed = self.kind != ProjKind::Mine || self.arm <= 0.0;
        if armed {
            let reach = KART_RADIUS + if self.kind == ProjKind::Mine { 0.6 } else { 0.5 };
            let r2 = reach * reach;
            let mut best = -1i16;
            let mut best_d = r2;
            grid.for_each_near(self.pos.x, self.pos.z, |id| {
                if id == self.owner {
                    return;
                }
                let d = positions[id as usize].distance_squared(self.pos);
                if d < best_d {
                    best_d = d;
                    best = id as i16;
                }
            });
            if best >= 0 {
                self.pending_hit = best;
                if self.blast > 0.0 {
                    self.detonate = true;
                }
                self.life = 0.0;
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Lock-free uniform spatial hash
// ----------------------------------------------------------------------------

/// A flat 2D (XZ) uniform grid of kart indices. Pre-sized once; each tick the
/// cells are *cleared* (capacity retained — no allocation) and refilled. After
/// the rebuild it is queried read-only from many threads at once, which is what
/// makes the parallel projectile pass lock-free.
///
/// 2D is sufficient: the circuit never overlaps itself vertically, so XZ
/// position uniquely localizes a kart. Sized for many entities — with only a
/// handful of karts the win is future-proofing (dense projectile fields,
/// destructible track furniture), but the lock-free read pattern is the point.
pub struct SpatialGrid {
    cells: Vec<Vec<u16>>,
    cols: usize,
    rows: usize,
    cell_size: f32,
    min_x: f32,
    min_z: f32,
}

impl SpatialGrid {
    pub fn for_track(track: &TrackSpline, cell_size: f32) -> Self {
        // Loose AABB of the loop, padded by the road width.
        let mut min = vec2(f32::INFINITY, f32::INFINITY);
        let mut max = vec2(f32::NEG_INFINITY, f32::NEG_INFINITY);
        let samples = track.segment_count() * 32;
        for i in 0..samples {
            let u = i as f32 / samples as f32 * track.segment_count() as f32;
            let p = track.point(u);
            min = min.min(vec2(p.x, p.z));
            max = max.max(vec2(p.x, p.z));
        }
        let pad = ROAD_HALF_WIDTH + 12.0;
        min -= Vec2::splat(pad);
        max += Vec2::splat(pad);

        let cols = (((max.x - min.x) / cell_size).ceil() as usize).max(1);
        let rows = (((max.y - min.y) / cell_size).ceil() as usize).max(1);
        // Pre-allocate each cell with a little headroom so steady-state pushes
        // never reallocate.
        let cells = (0..cols * rows).map(|_| Vec::with_capacity(4)).collect();

        Self { cells, cols, rows, cell_size, min_x: min.x, min_z: min.y }
    }

    #[inline]
    fn cell_coords(&self, x: f32, z: f32) -> (usize, usize) {
        let cx = (((x - self.min_x) / self.cell_size) as isize).clamp(0, self.cols as isize - 1);
        let cz = (((z - self.min_z) / self.cell_size) as isize).clamp(0, self.rows as isize - 1);
        (cx as usize, cz as usize)
    }

    /// Clear (retaining capacity) and reinsert every position. Single-threaded,
    /// runs once per tick before the parallel query phase.
    pub fn rebuild(&mut self, positions: &[Vec3]) {
        for c in &mut self.cells {
            c.clear();
        }
        for (i, p) in positions.iter().enumerate() {
            let (cx, cz) = self.cell_coords(p.x, p.z);
            self.cells[cz * self.cols + cx].push(i as u16);
        }
    }

    /// Visit every index in the 3×3 cell neighborhood around `(x, z)`.
    #[inline]
    pub fn for_each_near<F: FnMut(u16)>(&self, x: f32, z: f32, mut f: F) {
        let (cx, cz) = self.cell_coords(x, z);
        let (cx, cz) = (cx as isize, cz as isize);
        for dz in -1..=1 {
            for dx in -1..=1 {
                let gx = cx + dx;
                let gz = cz + dz;
                if gx < 0 || gz < 0 || gx >= self.cols as isize || gz >= self.rows as isize {
                    continue;
                }
                for &id in &self.cells[gz as usize * self.cols + gx as usize] {
                    f(id);
                }
            }
        }
    }

    /// Visit every index whose cell lies within `radius` world units of `(x, z)`,
    /// scanning the minimal `(2r+1)²` cell block (`r = ceil(radius / cell_size)`).
    /// `for_each_near` is the `r = 1` special case; this widens the window for the
    /// draft query (whose 14 m reach exceeds the 10 m cell). Same grid, same
    /// rebuild — **no second broadphase**, just a bigger read window.
    #[inline]
    pub fn for_each_within<F: FnMut(u16)>(&self, x: f32, z: f32, radius: f32, mut f: F) {
        let r = (radius / self.cell_size).ceil().max(1.0) as isize;
        let (cx, cz) = self.cell_coords(x, z);
        let (cx, cz) = (cx as isize, cz as isize);
        for dz in -r..=r {
            for dx in -r..=r {
                let gx = cx + dx;
                let gz = cz + dz;
                if gx < 0 || gz < 0 || gx >= self.cols as isize || gz >= self.rows as isize {
                    continue;
                }
                for &id in &self.cells[gz as usize * self.cols + gx as usize] {
                    f(id);
                }
            }
        }
    }
}

// ----------------------------------------------------------------------------
// The combat manager
// ----------------------------------------------------------------------------

pub struct Combat {
    pub karts: Vec<KartCombat>, // parallel to the KartState slice
    pub projectiles: Vec<Projectile>,
    pub crates: Vec<AmmoCrate>,
    /// Per-kart slipstream factor in `0..1` (M5.1), parallel to `karts`. Computed
    /// at the end of [`step`](Combat::step) from this tick's positions and consumed
    /// by next tick's `physics::step_all` (one-substep latency, like `places`).
    pub draft: Vec<f32>,
    /// Camera-shake "trauma" deposited this step by nearby detonations / hard player
    /// bumps (M9). Zeroed at the top of [`step`](Combat::step); `game.rs` folds it
    /// into a decaying shake. Player-relative, so distant AI combat doesn't rattle.
    pub trauma: f32,
    grid: SpatialGrid,
    positions: Vec<Vec3>, // reused snapshot for the parallel phase
    collision_scratch: Vec<u16>, // reused neighbor list for the collision pass
    cursor: usize,
}

impl Combat {
    pub fn new(track: &TrackSpline, classes: &[ChassisClass], num_crates: usize) -> Self {
        let karts = classes.iter().map(|&c| KartCombat::new(c)).collect();

        // Crates ride above the road, evenly spaced around the lap.
        let crates = (0..num_crates)
            .map(|n| {
                let d = track.total_length() * (n as f32 / num_crates as f32);
                let f = track.frame_at_distance(d);
                AmmoCrate { pos: f.position + f.up * 1.3, cooldown: 0.0 }
            })
            .collect();

        Self {
            karts,
            projectiles: vec![Projectile::dead(); PROJECTILE_CAPACITY],
            crates,
            draft: vec![0.0; classes.len()],
            trauma: 0.0,
            grid: SpatialGrid::for_track(track, 10.0),
            positions: vec![Vec3::ZERO; classes.len()],
            collision_scratch: Vec::with_capacity(classes.len()),
            cursor: 0,
        }
    }

    pub fn reset(&mut self) {
        for kc in &mut self.karts {
            *kc = KartCombat::new(kc.class);
        }
        for p in &mut self.projectiles {
            p.life = 0.0;
        }
        for c in &mut self.crates {
            c.cooldown = 0.0;
        }
        for d in &mut self.draft {
            *d = 0.0;
        }
        self.cursor = 0;
    }

    /// Advance combat one fixed step. `active` is false during the countdown /
    /// finish, freezing fire & pickups while still letting timers settle.
    pub fn step(
        &mut self,
        karts: &mut [KartState],
        inputs: &[Input],
        track: &TrackSpline,
        particles: &mut ParticleSystem,
        events: &mut SfxQueue,
        places: &[u8],
        active: bool,
        dt: f32,
    ) {
        // Fresh trauma each step; nearby detonations / hard player bumps add to it.
        self.trauma = 0.0;

        // 1) Tick down per-kart timers; advance the spin-out animation.
        for kc in &mut self.karts {
            kc.reload = (kc.reload - dt).max(0.0);
            if kc.spin > 0.0 {
                kc.spin = (kc.spin - dt).max(0.0);
                kc.spin_angle += SPIN_RATE * dt;
            }
        }

        // 2) Snapshot positions for the read-only parallel phase.
        for (i, k) in karts.iter().enumerate() {
            self.positions[i] = k.position;
        }

        if active {
            self.handle_firing(karts, inputs, places, particles, events);
            self.handle_pickups(dt, events);
        }

        // 3) Rebuild the grid (single-threaded), then integrate + detect across
        //    all cores. `positions`/`grid` are captured as *shared* references
        //    (disjoint fields from `projectiles`), so the closure is `Sync` and
        //    the parallel phase needs no lock — each projectile writes only its
        //    own slot.
        self.grid.rebuild(&self.positions);
        let positions: &[Vec3] = &self.positions;
        let grid: &SpatialGrid = &self.grid;
        self.projectiles.par_iter_mut().for_each(|p| {
            if p.alive() {
                p.integrate(dt, track, positions, grid);
            }
        });

        // 4) Apply hits single-threaded (cheap; n_karts is small).
        self.apply_hits(karts, particles, events);

        // 5) Resolve kart-vs-kart overlaps single-threaded, reusing the grid we
        //    just rebuilt. Runs after the parallel phase (never mutates shared
        //    kart state from `par_iter`) and after `apply_hits`, so projectile
        //    detection above still saw the tick's authoritative positions.
        self.resolve_kart_collisions(karts, particles, events);

        // 6) Slipstream/draft (M5.1): update each kart's 0..1 draft factor from the
        //    just-resolved positions, reusing the same grid (a wider read window —
        //    no second broadphase). Gated on `active` so it stays 0 through the
        //    countdown; the factor feeds next tick's `step_all`.
        if active {
            self.compute_draft(karts, dt);
        }
    }

    fn handle_firing(
        &mut self,
        karts: &[KartState],
        inputs: &[Input],
        places: &[u8],
        particles: &mut ParticleSystem,
        events: &mut SfxQueue,
    ) {
        let n = karts.len();
        for i in 0..n {
            let kc = &self.karts[i];
            if kc.reload > 0.0 || kc.ammo == 0 || kc.stunned() {
                continue;
            }

            // Player (kart 0): the cannon fires on input, auto-targeting ahead.
            if i == 0 {
                if inputs[0].fire {
                    let target = self.pick_target(0, karts);
                    self.fire(0, karts, target, particles, events);
                }
                continue;
            }

            // AI: take the shot only with a real firing solution — a leading
            // aim for line-of-sight cannons, a chasing kart for the mine layer.
            let kind = kc.class.spec().kind;
            let Some(sol) = self.firing_solution(i, karts) else {
                continue;
            };
            let take_shot = if kind == ProjKind::Mine {
                true // someone is right behind → drop it
            } else {
                // Trailing karts fire from wider angles (more aggressive).
                let agg = aggression(places.get(i).copied().unwrap_or(1), n);
                let cone = kc.class.aim_cone() - (agg - 0.5) * 0.30;
                karts[i].forward.dot(sol.aim) >= cone
            };
            if take_shot {
                self.fire(i, karts, sol.target, particles, events);
            }
        }
    }

    // -- combat AI (Milestone 3) -------------------------------------------

    /// Adjust the AI karts' *driving* inputs for combat: dodge incoming fire
    /// (top priority), nudge the nose toward a leading firing solution, and let
    /// trailing karts commit harder to drifts for catch-up mini-turbos. The
    /// player (index 0) is never touched. Cheap and single-threaded — it's a
    /// light post-process over the parallel spline-follower's output.
    pub fn plan_ai(&self, karts: &[KartState], places: &[u8], inputs: &mut [Input]) {
        for i in 1..karts.len() {
            if self.karts[i].stunned() {
                continue;
            }

            // 1) Evade — overrides aiming while a bolt is bearing down.
            let dodge = self.threat_steer(i, karts);
            if dodge.abs() > 0.02 {
                inputs[i].steer = (inputs[i].steer + dodge).clamp(-1.0, 1.0);
                continue;
            }

            // 2) Aim — bias steering to line up leading shots (laser / mortar).
            let kind = self.karts[i].class.spec().kind;
            if matches!(kind, ProjKind::Laser | ProjKind::Mortar) {
                if let Some(sol) = self.firing_solution(i, karts) {
                    let bias = aim_steer(karts[i].forward, karts[i].up, sol.aim);
                    inputs[i].steer = (inputs[i].steer + bias * AIM_STEER_BIAS).clamp(-1.0, 1.0);
                }
            }

            // 3) Strategize — back-markers drift harder to farm mini-turbos.
            let agg = aggression(places.get(i).copied().unwrap_or(1), karts.len());
            if agg > 0.75 && karts[i].grounded && inputs[i].steer.abs() > 0.3 {
                inputs[i].drift_held = true;
                if !karts[i].is_drifting() {
                    inputs[i].drift_pressed = true;
                }
            }
        }
    }

    /// A steer delta in [-1, 1] that swerves kart `i` clear of the most urgent
    /// incoming projectile (0 if none threatens). Scans the projectile pool;
    /// mines are treated as stationary hazards on the kart's forward path.
    fn threat_steer(&self, i: usize, karts: &[KartState]) -> f32 {
        let me = &karts[i];
        let right = me.right();
        let mut steer = 0.0;
        let mut worst = 0.0;

        for p in &self.projectiles {
            if !p.alive() || p.owner == i as u16 {
                continue;
            }
            let to_me = me.position - p.pos;
            if to_me.length_squared() > DODGE_SCAN_RANGE * DODGE_SCAN_RANGE {
                continue;
            }

            if p.kind == ProjKind::Mine {
                // Hazard if it sits just ahead, near our forward line.
                let ahead = (p.pos - me.position).dot(me.forward);
                if ahead > 0.0 && ahead < 12.0 {
                    let lateral = (p.pos - me.position).dot(right);
                    if lateral.abs() < DODGE_MISS_RADIUS {
                        let urgency = 1.0 - ahead / 12.0;
                        if urgency > worst {
                            worst = urgency;
                            steer = if lateral >= 0.0 { -1.0 } else { 1.0 };
                        }
                    }
                }
                continue;
            }

            let pvlen = p.vel.length();
            if pvlen < 0.1 {
                continue;
            }
            let vdir = p.vel / pvlen;
            let t = (me.position - p.pos).dot(vdir); // distance along the bolt's ray
            if t <= 0.0 {
                continue; // bolt is moving away
            }
            let ttime = t / pvlen;
            if ttime > DODGE_LOOKAHEAD {
                continue;
            }
            let closest = p.pos + vdir * t;
            let off = me.position - closest;
            let miss = off.length();
            if miss < DODGE_MISS_RADIUS {
                let urgency = (1.0 - miss / DODGE_MISS_RADIUS) * (1.0 - ttime / DODGE_LOOKAHEAD);
                if urgency > worst {
                    worst = urgency;
                    // Step further to the side we're already on (least travel).
                    let lat = off.dot(right);
                    steer = if lat.abs() < 0.2 {
                        1.0
                    } else if lat >= 0.0 {
                        1.0
                    } else {
                        -1.0
                    };
                }
            }
        }
        steer * worst.clamp(0.0, 1.0)
    }

    /// The best shot for AI kart `i` right now: a leading aim direction at the
    /// nearest kart ahead (line-of-sight cannons / homing dart), or the nearest
    /// chaser behind for the mine layer. `None` if there's nothing worth firing.
    fn firing_solution(&self, i: usize, karts: &[KartState]) -> Option<FireSolution> {
        let spec = self.karts[i].class.spec();
        let me = &karts[i];

        if spec.kind == ProjKind::Mine {
            let mut best = NONE;
            let mut best_d = MINE_REAR_RANGE * MINE_REAR_RANGE;
            for (j, o) in karts.iter().enumerate() {
                if j == i {
                    continue;
                }
                let to = o.position - me.position;
                if to.dot(me.forward) >= 0.0 {
                    continue; // must be behind us
                }
                let d = to.length_squared();
                if d < best_d {
                    best_d = d;
                    best = j as u16;
                }
            }
            return (best != NONE).then_some(FireSolution { target: best, aim: -me.forward });
        }

        // Forward cannons: nearest kart ahead within range.
        let mut best = NONE;
        let mut best_d = FIRE_RANGE * FIRE_RANGE;
        for (j, o) in karts.iter().enumerate() {
            if j == i {
                continue;
            }
            let to = o.position - me.position;
            if to.dot(me.forward) <= 0.0 {
                continue;
            }
            let d = to.length_squared();
            if d < best_d {
                best_d = d;
                best = j as u16;
            }
        }
        if best == NONE {
            return None;
        }
        let tgt = &karts[best as usize];
        let muzzle = me.position + me.forward * 1.6 + me.up * 1.1;
        let aim = if spec.kind == ProjKind::Dart {
            // Homing — no need to lead; just point at the target.
            (tgt.position - muzzle).normalize_or_zero()
        } else {
            intercept_dir(muzzle, tgt.position, tgt.velocity, spec.speed)
        };
        Some(FireSolution { target: best, aim })
    }

    fn fire(
        &mut self,
        i: usize,
        karts: &[KartState],
        target: u16,
        particles: &mut ParticleSystem,
        events: &mut SfxQueue,
    ) {
        let k = &karts[i];
        let spec = self.karts[i].class.spec();
        let muzzle = k.position + k.forward * 1.6 + k.up * 1.1;

        // Common fields; per-kind fields are set in the match below.
        let mut p = Projectile {
            kind: spec.kind,
            owner: i as u16,
            target: NONE,
            life: spec.proj_life,
            track_u: k.track_u, // seed the ground-query hint from the owner
            blast: spec.blast,
            ..Projectile::dead()
        };
        match spec.kind {
            ProjKind::Mortar => {
                p.pos = muzzle;
                p.vel = k.forward * spec.speed + k.up * spec.launch_lift;
            }
            ProjKind::Laser => {
                p.pos = muzzle;
                p.vel = k.forward * spec.speed;
                p.bounces = spec.bounces;
            }
            ProjKind::Dart => {
                p.pos = muzzle;
                p.vel = k.forward * spec.speed;
                p.target = target;
            }
            ProjKind::Mine => {
                // Drop it just behind the kart, settling onto the road.
                p.pos = k.position - k.forward * 1.6 + k.up * 0.4;
                p.vel = -k.up;
                p.arm = 0.5;
            }
        }

        self.spawn(p);
        self.karts[i].ammo -= 1;
        self.karts[i].reload = spec.reload;

        let dir = if spec.kind == ProjKind::Mine { -k.forward } else { k.forward };
        particles.emit_muzzle(muzzle, dir, self.karts[i].class.color());
        events.push(spec.kind.fire_sfx()); // per-class cannon timbre
    }

    fn spawn(&mut self, p: Projectile) {
        let n = self.projectiles.len();
        self.projectiles[self.cursor] = p;
        self.cursor = (self.cursor + 1) % n;
    }

    /// Nearest other kart ahead of `i` within [`FIRE_RANGE`] (NONE if none).
    fn pick_target(&self, i: usize, karts: &[KartState]) -> u16 {
        let me = &karts[i];
        let mut best = NONE;
        let mut best_d = FIRE_RANGE * FIRE_RANGE;
        for (j, other) in karts.iter().enumerate() {
            if j == i {
                continue;
            }
            let to = other.position - me.position;
            if to.dot(me.forward) <= 0.0 {
                continue; // only lock onto karts in front
            }
            let d = to.length_squared();
            if d < best_d {
                best_d = d;
                best = j as u16;
            }
        }
        best
    }

    fn handle_pickups(&mut self, dt: f32, events: &mut SfxQueue) {
        let Combat { crates, karts, positions, .. } = &mut *self;
        let r2 = CRATE_RADIUS * CRATE_RADIUS;
        for c in crates.iter_mut() {
            if c.cooldown > 0.0 {
                c.cooldown -= dt;
                continue;
            }
            for (i, kc) in karts.iter_mut().enumerate() {
                let max = kc.class.spec().max_ammo;
                if kc.ammo >= max {
                    continue; // don't waste a crate on a full magazine
                }
                if positions[i].distance_squared(c.pos) <= r2 {
                    kc.ammo = max; // a crate fully reloads the cannon
                    c.cooldown = CRATE_RESPAWN;
                    if i == 0 {
                        events.push(Sfx::Pickup); // only the player hears their own pickup
                    }
                    break;
                }
            }
        }
    }

    fn apply_hits(
        &mut self,
        karts: &mut [KartState],
        particles: &mut ParticleSystem,
        events: &mut SfxQueue,
    ) {
        let Combat { projectiles, karts: combat_karts, positions, trauma, .. } = &mut *self;
        let player_pos = positions[0];
        for p in projectiles.iter_mut() {
            // A projectile flags itself by zeroing life *and* setting an outcome.
            let hit = p.pending_hit >= 0;
            let blast = p.detonate;
            if !hit && !blast {
                continue;
            }
            let color = combat_karts[p.owner as usize].class.color();

            if blast && p.blast > 0.0 {
                // Area effect: spin out everyone (except the owner) in radius.
                let br2 = p.blast * p.blast;
                let mut player_caught = false;
                for (j, pos) in positions.iter().enumerate() {
                    if j as u16 == p.owner {
                        continue;
                    }
                    if pos.distance_squared(p.pos) <= br2 {
                        spinout(combat_karts, karts, j);
                        player_caught |= j == 0;
                    }
                }
                particles.emit_explosion(p.pos, color, 3.0);
                events.push(Sfx::Explosion);
                *trauma += shake_falloff(player_pos.distance(p.pos)) * TRAUMA_BLAST;
                if player_caught {
                    events.push(Sfx::Spinout);
                }
            } else if hit {
                let victim = p.pending_hit as usize;
                spinout(combat_karts, karts, victim);
                particles.emit_explosion(p.pos, color, 1.2);
                events.push(Sfx::Explosion);
                *trauma += shake_falloff(player_pos.distance(p.pos)) * TRAUMA_HIT;
                if victim == 0 {
                    events.push(Sfx::Spinout);
                }
            }

            // Clear the outcome so a now-dead projectile can't re-trigger next
            // tick (dead slots are skipped by `integrate`, which is what resets
            // these flags for live projectiles).
            p.pending_hit = -1;
            p.detonate = false;
        }
    }

    /// Push overlapping karts apart with mass-weighted, equal-and-opposite impulses
    /// resolved in the road's tangent plane (so banked turns keep karts side-by-side
    /// instead of stacking vertically). Single-threaded — pair forces need careful
    /// ordering and we never mutate shared kart state from a `par_iter`. Broadphase
    /// reuses the grid rebuilt this tick; the neighbor list reuses a pre-sized
    /// scratch buffer, so the pass allocates nothing.
    fn resolve_kart_collisions(
        &mut self,
        karts: &mut [KartState],
        particles: &mut ParticleSystem,
        events: &mut SfxQueue,
    ) {
        let n = karts.len();
        let Combat { grid, karts: combat_karts, collision_scratch, trauma, .. } = &mut *self;
        for i in 0..n {
            let pi = karts[i].position;
            // Gather only forward neighbors (id > i) so each unordered pair, which
            // the 3×3 neighborhood reports symmetrically, resolves exactly once.
            collision_scratch.clear();
            grid.for_each_near(pi.x, pi.z, |id| {
                if id as usize > i {
                    collision_scratch.push(id);
                }
            });
            for k in 0..collision_scratch.len() {
                let j = collision_scratch[k] as usize;
                let inv_i = 1.0 / combat_karts[i].class.spec().mass;
                let inv_j = 1.0 / combat_karts[j].class.spec().mass;
                // i < j always (grid yields id > i), so split the slice between them
                // to get two disjoint mutable kart references.
                let (lo, hi) = karts.split_at_mut(j);
                let hard = resolve_pair(&mut lo[i], &mut hi[0], inv_i, inv_j, particles);
                // Only sound bumps the player is part of (no positional audio yet,
                // so AI-on-AI thuds would just be noise) — and rattle the camera too.
                if hard && (i == 0 || j == 0) {
                    events.push(Sfx::Bump);
                    *trauma += TRAUMA_BUMP;
                }
            }
        }
    }

    /// Update every kart's slipstream factor (M5.1). A kart drafts when some other
    /// kart is a leader it's tucked directly behind: within `[DRAFT_MIN_DIST,
    /// DRAFT_MAX_DIST]`, inside the ±12° rear-wake cone, and pointed the same way.
    /// The factor eases toward 1 while drafting and 0 otherwise, each in well under
    /// 0.5 s. Single-threaded (writes only `self.draft`, reads `karts`); broadphase
    /// reuses the grid via `for_each_within` (the draft reach exceeds one cell).
    fn compute_draft(&mut self, karts: &[KartState], dt: f32) {
        let min2 = DRAFT_MIN_DIST * DRAFT_MIN_DIST;
        let max2 = DRAFT_MAX_DIST * DRAFT_MAX_DIST;
        for i in 0..karts.len() {
            let me = &karts[i];
            let mut drafting = false;
            self.grid.for_each_within(me.position.x, me.position.z, DRAFT_MAX_DIST, |id| {
                let j = id as usize;
                if drafting || j == i {
                    return; // already found a tow / don't draft yourself
                }
                let lead = &karts[j];
                let to = lead.position - me.position;
                let dist2 = to.length_squared();
                if dist2 < min2 || dist2 > max2 {
                    return; // outside the slipstream's reach
                }
                let dir = to / dist2.sqrt();
                // I sit in `lead`'s rear wake ⇔ the way to it aligns with its heading.
                if dir.dot(lead.forward) < DRAFT_CONE_COS {
                    return; // outside the ±12° cone behind the leader
                }
                // Both must be travelling roughly the same way (no oncoming tow).
                if me.forward.dot(lead.forward) < DRAFT_ALIGN_MIN {
                    return;
                }
                drafting = true;
            });

            let target = if drafting { 1.0 } else { 0.0 };
            let time = if drafting { DRAFT_RAMP_TIME } else { DRAFT_DECAY_TIME };
            self.draft[i] = approach(self.draft[i], target, dt / time);
        }
    }

    // -- renderer / HUD queries --------------------------------------------

    /// Visual spin-out yaw for kart `i` (0 when not stunned). The renderer
    /// applies it in the kart's local space as an extra Y rotation.
    #[inline]
    pub fn spin_yaw(&self, i: usize) -> f32 {
        let kc = &self.karts[i];
        if kc.spin > 0.0 {
            kc.spin_angle
        } else {
            0.0
        }
    }

    #[inline]
    pub fn stunned(&self, i: usize) -> bool {
        self.karts[i].stunned()
    }
}

/// A target plus the unit direction the shooter should aim to hit it.
#[derive(Clone, Copy)]
struct FireSolution {
    target: u16,
    aim: Vec3,
}

/// Resolve one overlapping kart pair. `inv_a`/`inv_b` are inverse masses and `a` is
/// the lower-indexed kart. Separates them in the shared road tangent plane (split by
/// inverse mass so the lighter kart moves more), exchanges a normal impulse, and
/// scrubs a little speed on glancing contact. Returns `true` on a *hard* contact
/// (the same closing-speed gate that sparks), so the caller can sound a bump.
fn resolve_pair(
    a: &mut KartState,
    b: &mut KartState,
    inv_a: f32,
    inv_b: f32,
    particles: &mut ParticleSystem,
) -> bool {
    let min_dist = 2.0 * KART_RADIUS;

    // Contact frame in the averaged road tangent plane (banked turns stay sane).
    let mut up = (a.up + b.up).normalize_or_zero();
    if up.length_squared() < 0.5 {
        up = Vec3::Y; // defensive: opposing normals would otherwise cancel
    }
    let delta = b.position - a.position;
    let mut d = delta - up * delta.dot(up); // project onto the surface plane
    let mut dist = d.length();
    if dist >= min_dist {
        return false; // not overlapping
    }
    // Exact overlap → pick a stable in-plane normal from a's heading.
    if dist < 1e-4 {
        d = a.right();
        d -= up * d.dot(up);
        dist = d.length().max(1e-4);
    }
    let normal = d / dist; // unit, points a -> b
    let penetration = min_dist - dist;
    let inv_sum = inv_a + inv_b;

    // 1) Positional separation, split by inverse mass (no overshoot → no jitter).
    a.position -= normal * (penetration * inv_a / inv_sum);
    b.position += normal * (penetration * inv_b / inv_sum);

    // 2) Normal impulse — only while the gap is closing, so resting contact applies
    //    nothing (never sticky). Equal-and-opposite, mass-weighted: a heavy kart
    //    barely budges while it flings a light one.
    let rel_n = (b.velocity - a.velocity).dot(normal);
    if rel_n >= 0.0 {
        return false; // resting / separating contact — no impulse, no bump
    }
    let jimp = -(1.0 + KART_RESTITUTION) * rel_n / inv_sum;
    apply_bump(a, normal * (-jimp * inv_a));
    apply_bump(b, normal * (jimp * inv_b));

    // 3) Side-bump scrub: bleed a little speed on glancing rubs (grip).
    let closing = -rel_n; // > 0 here
    let severity = (closing / BUMP_SCRUB_FULL).clamp(0.0, 1.0);
    scrub_side_speed(a, normal, severity);
    scrub_side_speed(b, normal, severity);

    // 4) A hard contact (gated on closing speed so a sustained rub, where
    //    closing ~ 0, never spams the particle pool / audio) sparks and bumps.
    let hard = closing > BUMP_SPARK_SPEED;
    if hard {
        let mid = (a.position + b.position) * 0.5 + up * 0.4;
        particles.emit_explosion(mid, Color::new(1.0, 1.0, 0.9, 1.0), 0.6);
    }
    hard
}

/// Apply a world-space velocity impulse to a kart. Grounded karts grip the road, so
/// only the along-heading component survives — as a `speed` change (their `velocity`
/// is recomputed as `forward * speed` every step); the lateral part was already
/// delivered as positional separation. Airborne karts are free bodies and take the
/// whole impulse.
fn apply_bump(k: &mut KartState, impulse: Vec3) {
    if k.grounded {
        k.speed += impulse.dot(k.forward);
        k.velocity = k.forward * k.speed; // keep the cached velocity consistent
    } else {
        k.velocity += impulse;
        k.speed = k.velocity.length();
    }
}

/// Shed a little forward speed proportional to how glancing the contact is
/// (`lateral` = 1 for a pure side rub, 0 for head-on) and how hard it was. Tire
/// grip only matters on the ground, so airborne karts are left untouched.
fn scrub_side_speed(k: &mut KartState, normal: Vec3, severity: f32) {
    if !k.grounded {
        return;
    }
    let lateral = (1.0 - k.forward.dot(normal).abs()).clamp(0.0, 1.0);
    k.speed *= 1.0 - BUMP_SCRUB * lateral * severity;
    k.velocity = k.forward * k.speed;
}

/// Knock a kart out of control: kill most of its speed and start the stun timer.
fn spinout(combat_karts: &mut [KartCombat], karts: &mut [KartState], i: usize) {
    karts[i].speed *= HIT_SPEED_KEEP;
    karts[i].velocity *= HIT_SPEED_KEEP;
    combat_karts[i].spin = SPIN_DURATION;
}

/// Linear shake falloff (M9): 1 at the player's feet → 0 at `SHAKE_RADIUS`.
#[inline]
fn shake_falloff(dist: f32) -> f32 {
    (1.0 - dist / SHAKE_RADIUS).clamp(0.0, 1.0)
}

/// Move `cur` toward `target` by at most `step` (a clamped linear approach). Used
/// to ramp/decay the draft factor at a fixed rate per substep.
#[inline]
fn approach(cur: f32, target: f32, step: f32) -> f32 {
    if cur < target {
        (cur + step).min(target)
    } else {
        (cur - step).max(target)
    }
}

/// Combat aggression from race place: 0.5 for the leader → 1.0 for last. Drives
/// wider firing cones and harder drifting for the karts that need to catch up.
fn aggression(place: u8, n: usize) -> f32 {
    if n <= 1 {
        return 0.75;
    }
    0.5 + 0.5 * ((place.max(1) as f32 - 1.0) / (n as f32 - 1.0))
}

/// Signed steer in [-1, 1] that rotates `forward` toward `aim` about `up`,
/// matching the sim's convention (steer > 0 turns right). Used as an aim nudge.
fn aim_steer(forward: Vec3, up: Vec3, aim: Vec3) -> f32 {
    let a = aim - up * aim.dot(up);
    if a.length_squared() < 1e-5 {
        return 0.0;
    }
    let a = a.normalize();
    let s = forward.cross(a).dot(up); // > 0 → aim is to the left
    let c = forward.dot(a);
    (-s.atan2(c)).clamp(-1.0, 1.0)
}

/// First-order intercept: the unit direction from `shooter` to where a shot of
/// `speed` meets a target at `tp` moving at `tv`. Falls back to a straight
/// line-of-sight aim when no real solution exists (target faster than the shot).
fn intercept_dir(shooter: Vec3, tp: Vec3, tv: Vec3, speed: f32) -> Vec3 {
    let to = tp - shooter;
    if speed <= 0.1 {
        return to.normalize_or_zero();
    }
    // Solve |to + tv·t| = speed·t  →  (tv·tv − speed²)t² + 2(to·tv)t + to·to = 0.
    let a = tv.length_squared() - speed * speed;
    let b = 2.0 * to.dot(tv);
    let c = to.length_squared();
    let t = if a.abs() < 1e-3 {
        if b.abs() < 1e-6 {
            -1.0
        } else {
            -c / b
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            -1.0
        } else {
            let sq = disc.sqrt();
            let (t1, t2) = ((-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a));
            [t1, t2].into_iter().filter(|&t| t > 0.0).fold(f32::INFINITY, f32::min)
        }
    };
    if t.is_finite() && t > 0.0 {
        (tp + tv * t - shooter).normalize_or_zero()
    } else {
        to.normalize_or_zero()
    }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_finds_inserted_neighbors() {
        let track = TrackSpline::demo_circuit();
        let mut grid = SpatialGrid::for_track(&track, 10.0);
        let start = track.start_frame().position;
        let positions = [start, start + Vec3::X * 1.0, start + Vec3::X * 200.0];
        grid.rebuild(&positions);

        let mut found = Vec::new();
        grid.for_each_near(start.x, start.z, |id| found.push(id));
        assert!(found.contains(&0));
        assert!(found.contains(&1), "a kart 1m away must share the neighborhood");
        assert!(!found.contains(&2), "a kart 200m away must not");
    }

    #[test]
    fn homing_dart_spins_out_the_target() {
        // Exercises the whole pipeline headlessly: fire → spawn → parallel
        // integrate + spatial-hash detect → single-threaded spinout apply.
        let track = TrackSpline::demo_circuit();
        let classes = [ChassisClass::Warden, ChassisClass::Warden];
        let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();
        karts[0].forward = Vec3::Z;
        karts[0].up = Vec3::Y;
        karts[1].position = karts[0].position + Vec3::Z * 8.0; // directly ahead

        let mut combat = Combat::new(&track, &classes, 0);
        let mut particles = ParticleSystem::with_capacity(64);
        let mut inputs = vec![Input::default(); 2];
        inputs[0].fire = true;
        let places = [1u8, 2u8];

        let mut events = SfxQueue::new();
        let mut hit = false;
        for _ in 0..120 {
            combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, true, 1.0 / 60.0);
            inputs[0].fire = false; // a single shot is plenty
            if combat.stunned(1) {
                hit = true;
                break;
            }
        }
        assert!(hit, "a homing dart should reach and spin out the kart ahead");
        assert!(karts[1].speed.abs() < 1.0, "the hit should scrub the victim's speed");
    }

    #[test]
    fn intercept_leads_a_crossing_target() {
        let shooter = Vec3::ZERO;
        let tp = Vec3::new(10.0, 0.0, 0.0);
        let tv = Vec3::new(0.0, 0.0, 8.0); // crossing perpendicular to the line of sight
        let aim = intercept_dir(shooter, tp, tv, 40.0);
        assert!(aim.x > 0.0, "aim should still point toward the target");
        let los = (tp - shooter).normalize();
        assert!(aim.z > los.z + 1e-3, "a leading aim must tilt into the target's travel");
    }

    #[test]
    fn aggression_increases_down_the_order() {
        assert!((aggression(1, 8) - 0.5).abs() < 1e-6, "leader is least aggressive");
        assert!((aggression(8, 8) - 1.0).abs() < 1e-6, "last place is most aggressive");
        assert!(aggression(1, 8) < aggression(8, 8));
    }

    #[test]
    fn class_specs_are_distinct() {
        assert_eq!(ChassisClass::Juggernaut.spec().kind, ProjKind::Mortar);
        assert_eq!(ChassisClass::Stinger.spec().kind, ProjKind::Laser);
        assert_eq!(ChassisClass::Warden.spec().kind, ProjKind::Dart);
        assert_eq!(ChassisClass::Phantom.spec().kind, ProjKind::Mine);
        assert_eq!(ChassisClass::for_index(0), ChassisClass::Warden);
    }

    #[test]
    fn masses_are_ordered() {
        // Heavier classes must outweigh lighter ones — this is what makes the
        // Juggernaut bully and the Stinger get shoved (M5).
        let j = ChassisClass::Juggernaut.spec().mass;
        let w = ChassisClass::Warden.spec().mass;
        let p = ChassisClass::Phantom.spec().mass;
        let s = ChassisClass::Stinger.spec().mass;
        assert!(j > w && w > p && p > s, "mass order J>W>P>S; got {j},{w},{p},{s}");
    }

    /// Two karts spawned overlapping must separate to just-touching and then hold
    /// steady — no oscillation, no drift. Drives the real `combat.step` path with
    /// `active = false` (skips firing/pickups; still rebuilds the grid + resolves).
    #[test]
    fn karts_separate_without_jitter() {
        let track = TrackSpline::demo_circuit();
        let classes = [ChassisClass::Warden, ChassisClass::Warden];
        let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();

        let f = track.start_frame();
        for (n, k) in karts.iter_mut().enumerate() {
            k.position = f.position + f.right * (n as f32 * 1.0); // 0.0 and 1.0 → overlap
            k.forward = f.forward;
            k.up = f.up;
            k.velocity = Vec3::ZERO;
            k.speed = 0.0;
        }

        let mut combat = Combat::new(&track, &classes, 0);
        let mut particles = ParticleSystem::with_capacity(64);
        let inputs = vec![Input::default(); 2];
        let places = [1u8, 2u8];

        let mut events = SfxQueue::new();
        let min_dist = 2.0 * KART_RADIUS;
        let mut dists = Vec::new();
        for _ in 0..40 {
            combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, false, 1.0 / 60.0);
            dists.push(karts[0].position.distance(karts[1].position));
            // Side never flips: kart 1 stays on kart 0's +right side.
            let side = (karts[1].position - karts[0].position).dot(f.right);
            assert!(side > 0.0, "the karts swapped sides during separation");
        }

        let last = *dists.last().unwrap();
        assert!(
            (last - min_dist).abs() < 0.05,
            "should settle at the contact distance {min_dist}, got {last}"
        );
        // No jitter: the tail of the run is flat (consecutive deltas ~ 0).
        for w in dists[dists.len() - 8..].windows(2) {
            assert!((w[1] - w[0]).abs() < 1e-3, "separation oscillated: {:?}", w);
        }
    }

    /// A heavy class must be displaced less than a light one by the same overlap.
    #[test]
    fn heavier_class_displaces_lighter_more() {
        let track = TrackSpline::demo_circuit();
        let classes = [ChassisClass::Juggernaut, ChassisClass::Stinger];
        let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();

        let f = track.start_frame();
        karts[0].position = f.position; // Juggernaut
        karts[1].position = f.position + f.right * 1.0; // Stinger, overlapping
        for k in karts.iter_mut() {
            k.forward = f.forward;
            k.up = f.up;
            k.velocity = Vec3::ZERO;
            k.speed = 0.0;
        }
        let before = [karts[0].position, karts[1].position];

        let mut combat = Combat::new(&track, &classes, 0);
        let mut particles = ParticleSystem::with_capacity(64);
        let inputs = vec![Input::default(); 2];
        let places = [1u8, 2u8];
        let mut events = SfxQueue::new();
        combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, false, 1.0 / 60.0);

        let jug = (karts[0].position - before[0]).length();
        let stinger = (karts[1].position - before[1]).length();
        assert!(stinger > jug, "the lighter Stinger must move more (jug {jug}, stinger {stinger})");
        // Displacement splits by inverse mass: Stinger/Juggernaut ≈ 1.6/0.7 ≈ 2.29.
        let ratio = stinger / jug;
        assert!((2.1..2.5).contains(&ratio), "displacement ratio off: {ratio}");
    }

    /// Two karts ramming head-on at near-top speed must never pass through each
    /// other (no tunneling) — exercises `step_all` + `combat.step` together.
    #[test]
    fn top_speed_no_tunnel() {
        let track = TrackSpline::demo_circuit();
        let classes = [ChassisClass::Warden, ChassisClass::Stinger];
        let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();

        let f = track.start_frame();
        let fast = 55.0; // near MAX_SPEED
        karts[0].position = f.position - f.forward * KART_RADIUS;
        karts[0].forward = f.forward;
        karts[0].up = f.up;
        karts[0].speed = fast;
        karts[0].velocity = f.forward * fast;
        karts[1].position = f.position + f.forward * KART_RADIUS;
        karts[1].forward = -f.forward; // facing back at kart 0
        karts[1].up = f.up;
        karts[1].speed = fast;
        karts[1].velocity = -f.forward * fast;

        let mut combat = Combat::new(&track, &classes, 0);
        let mut particles = ParticleSystem::with_capacity(64);
        let inputs = vec![Input { throttle: 1.0, ..Default::default() }; 2];
        let places = [1u8, 2u8];
        let dt = crate::physics::FIXED_DT;

        let mut events = SfxQueue::new();
        let no_draft = [0.0_f32; 2];
        let mut min_gap = f32::INFINITY;
        for _ in 0..30 {
            crate::physics::step_all(&mut karts, &inputs, &no_draft, &track, dt);
            combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, false, dt);
            // Along the contact axis kart 1 must stay ahead of kart 0 (no swap).
            let gap = (karts[1].position - karts[0].position).dot(f.forward);
            assert!(gap > 0.0, "karts tunneled through each other (gap {gap})");
            min_gap = min_gap.min(karts[0].position.distance(karts[1].position));
        }
        // After each resolve they sit ~one contact-diameter apart, never overlapped.
        assert!(min_gap > KART_RADIUS, "karts overlapped too deeply (min {min_gap})");
    }

    /// Tucking directly behind a leader builds the draft factor toward 1 in under
    /// 0.5 s, the leader (no one ahead) never drafts, and breaking the tuck decays
    /// it back to 0 in under 0.5 s. Positions are held (no `step_all`) and the
    /// cannons silenced, so the only thing moving is the M5.1 draft pass.
    #[test]
    fn draft_ramps_and_decays_in_the_cone() {
        let track = TrackSpline::demo_circuit();
        let classes = [ChassisClass::Warden, ChassisClass::Warden];
        let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();

        let f = track.frame(2.0);
        karts[0].position = f.position; // leader
        karts[0].forward = f.forward;
        karts[0].up = f.up;
        karts[1].position = f.position - f.forward * 8.0; // follower, 8 m dead astern
        karts[1].forward = f.forward;
        karts[1].up = f.up;

        let mut combat = Combat::new(&track, &classes, 0);
        for kc in &mut combat.karts {
            kc.ammo = 0; // silence the cannons
        }
        let mut particles = ParticleSystem::with_capacity(64);
        let inputs = vec![Input::default(); 2];
        let places = [1u8, 2u8];
        let mut events = SfxQueue::new();
        let dt = crate::physics::FIXED_DT;

        // 30 substeps == 0.5 s: the factor must be (nearly) full ⇒ ramps < 0.5 s.
        for _ in 0..30 {
            combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, true, dt);
        }
        assert!(combat.draft[1] >= 0.95, "follower should be drafting, got {}", combat.draft[1]);
        assert!(combat.draft[0] <= 0.05, "leader has no one ahead, got {}", combat.draft[0]);

        // Break the tuck — shove the follower out past the cone — and watch it decay.
        karts[1].position = f.position - f.forward * 8.0 + f.right * 10.0;
        for _ in 0..30 {
            combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, true, dt);
        }
        assert!(combat.draft[1] <= 0.05, "draft should decay once the tuck breaks, got {}", combat.draft[1]);
    }

    /// The draft must engage *only* inside the rear-wake cone and range: not when
    /// level/beside the leader, not beyond 14 m, not inside 4 m, and not when ahead
    /// of it. Each case holds positions for 0.5 s and asserts no factor builds.
    #[test]
    fn no_draft_outside_the_cone() {
        let track = TrackSpline::demo_circuit();
        let f = track.frame(2.0);
        let dt = crate::physics::FIXED_DT;

        // Run 30 substeps with kart 0 = leader at `f` and kart 1 = follower at
        // `offset` from it (same heading); report kart 1's draft factor.
        let draft_of_follower = |offset: Vec3| -> f32 {
            let classes = [ChassisClass::Warden, ChassisClass::Warden];
            let mut karts: Vec<KartState> = (0..2).map(|i| KartState::spawn(&track, i)).collect();
            karts[0].position = f.position;
            karts[0].forward = f.forward;
            karts[0].up = f.up;
            karts[1].position = f.position + offset;
            karts[1].forward = f.forward;
            karts[1].up = f.up;
            let mut combat = Combat::new(&track, &classes, 0);
            for kc in &mut combat.karts {
                kc.ammo = 0;
            }
            let mut particles = ParticleSystem::with_capacity(64);
            let inputs = vec![Input::default(); 2];
            let places = [1u8, 2u8];
            let mut events = SfxQueue::new();
            for _ in 0..30 {
                combat.step(&mut karts, &inputs, &track, &mut particles, &mut events, &places, true, dt);
            }
            combat.draft[1]
        };

        assert!(draft_of_follower(f.right * 6.0) <= 0.1, "beside the leader → no draft");
        assert!(draft_of_follower(-f.forward * 20.0) <= 0.1, "beyond 14 m → no draft");
        assert!(draft_of_follower(-f.forward * 3.0) <= 0.1, "inside 4 m → no draft");
        assert!(draft_of_follower(f.forward * 6.0) <= 0.1, "ahead of the leader → no draft");
    }

    /// End-to-end speed claim: two identical karts on the same racing line (AI keeps
    /// them on it), one stepped with `draft = 0` and one with `draft = 1`. Over 5 s
    /// the fully-drafting kart covers ≥ 3 m more (the DoD floor; the real gain is far
    /// larger). Exercises the physics overspeed allowance through `KartState::step`.
    #[test]
    fn drafting_raises_top_speed_and_distance() {
        use crate::physics::{ai_input, FIXED_DT};
        let track = TrackSpline::demo_circuit();
        let mut control = KartState::spawn(&track, 0);
        let mut drafter = KartState::spawn(&track, 0);

        // Warm both up to steady lapping speed.
        for _ in 0..300 {
            let ci = ai_input(&control, &track, 1.0);
            let di = ai_input(&drafter, &track, 1.0);
            control.step(&ci, &track, 0.0, FIXED_DT);
            drafter.step(&di, &track, 1.0, FIXED_DT);
        }

        // Distance covered over the next 5 s (300 substeps).
        let (c0, d0) = (control.lap_distance, drafter.lap_distance);
        for _ in 0..300 {
            let ci = ai_input(&control, &track, 1.0);
            let di = ai_input(&drafter, &track, 1.0);
            control.step(&ci, &track, 0.0, FIXED_DT);
            drafter.step(&di, &track, 1.0, FIXED_DT);
        }
        let gained = (drafter.lap_distance - d0) - (control.lap_distance - c0);
        assert!(gained >= 3.0, "a full draft should gain ≥3 m over 5 s, got {gained:.2}");
    }

    /// Headless micro-benchmark of one full sim substep (AI + combat AI + physics +
    /// combat/collision + particles) at the shipping 8-kart config. Ignored by
    /// default (it's a measurement, not an assertion); capture a release baseline:
    ///   cargo test --release -- --ignored --nocapture bench_sim_substep
    #[test]
    #[ignore]
    fn bench_sim_substep() {
        use crate::physics::{compute_ai_inputs, step_all, FIXED_DT};
        use std::time::Instant;

        const N: usize = 8; // == main.rs NUM_KARTS
        let track = TrackSpline::demo_circuit();
        let classes: Vec<ChassisClass> = (0..N).map(ChassisClass::for_index).collect();
        let mut karts: Vec<KartState> = (0..N).map(|i| KartState::spawn(&track, i)).collect();
        let skills: Vec<f32> = (0..N).map(|i| 0.55 + (i as f32 * 0.07) % 0.45).collect();
        let mut inputs = vec![Input::default(); N];
        let places = vec![1u8; N];
        let mut combat = Combat::new(&track, &classes, 12);
        let mut particles = ParticleSystem::with_capacity(1024);
        let mut events = SfxQueue::new();

        let tick = |karts: &mut Vec<KartState>,
                    inputs: &mut Vec<Input>,
                    combat: &mut Combat,
                    particles: &mut ParticleSystem,
                    events: &mut SfxQueue| {
            events.clear(); // drained per frame in the real loop; mirror that here
            compute_ai_inputs(karts, &skills, &track, inputs);
            combat.plan_ai(karts, &places, inputs);
            // `combat.draft` holds the previous tick's factors, exactly as the real
            // loop feeds them in — so the bench measures the live draft path.
            step_all(karts, inputs, &combat.draft, &track, FIXED_DT);
            combat.step(karts, inputs, &track, particles, events, &places, true, FIXED_DT);
            particles.update(FIXED_DT);
        };

        // Warm up: let karts spread out and start bumping/firing.
        for _ in 0..600 {
            tick(&mut karts, &mut inputs, &mut combat, &mut particles, &mut events);
        }

        let iters = 60_000; // 1000 s of simulated race time
        let t0 = Instant::now();
        for _ in 0..iters {
            tick(&mut karts, &mut inputs, &mut combat, &mut particles, &mut events);
        }
        let per_us = t0.elapsed().as_secs_f64() * 1e6 / iters as f64;
        let budget_us = 1.0e6 / 60.0; // one 60 Hz frame
        println!(
            "bench_sim_substep: {N} karts  {per_us:.2} us/substep  \
             ({:.2}% of the {budget_us:.0} us 60Hz frame budget)",
            per_us / budget_us * 100.0
        );
    }
}
