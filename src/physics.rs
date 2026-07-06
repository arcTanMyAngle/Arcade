//! physics.rs — fixed-60Hz arcade kart simulation.
//!
//! Model: a kart is a point with full 3D `velocity`, a `forward` heading and an
//! `up` (the track surface normal). Gravity is always applied; a per-step ground
//! query either resolves the kart onto the road (grounded) or lets it fly
//! (airborne). Driving forces act in the surface tangent plane, so banked turns
//! and hills "just work".
//!
//! Features:
//!   * two-stage manual drift (1.5s -> blue mini-turbo, 3.0s -> orange super),
//!   * ramp launches + airborne trick -> landing boost,
//!   * boost timers feeding the camera "speed juice" (FOV) in main.rs,
//!   * rayon-parallel AI input solving and particle integration,
//!   * zero per-step heap allocation (caller-owned buffers, ring-buffer pool).
//!
//! Conventions match mesh_gen.rs: +Z forward, +Y up, +X right.

use crate::mesh_gen::{BLUE_SPARK, ORANGE_SPARK};
use crate::track_3d::{TrackSpline, ROAD_HALF_WIDTH};
use macroquad::prelude::*;
use macroquad::rand::gen_range;
use rayon::prelude::*;

// ----------------------------------------------------------------------------
// Timestep
// ----------------------------------------------------------------------------

pub const PHYSICS_HZ: f32 = 60.0;
pub const FIXED_DT: f32 = 1.0 / PHYSICS_HZ;

// ----------------------------------------------------------------------------
// Driving tunables
// ----------------------------------------------------------------------------

const MAX_SPEED: f32 = 58.0;
const REVERSE_MAX: f32 = -12.0;
const ACCEL: f32 = 42.0;
const BRAKE_DECEL: f32 = 80.0;
const COAST_FRICTION: f32 = 22.0;
const OVERSPEED_DECAY: f32 = 3.0; // how fast post-boost overspeed bleeds off

const TURN_RATE: f32 = 2.2; // rad/s, normal steering
const AIR_TURN_RATE: f32 = 1.0; // limited yaw control while airborne

const GRAVITY: f32 = 30.0;
const GRAVITY_VEC: Vec3 = Vec3::new(0.0, -GRAVITY, 0.0);
const CONTACT_THRESH: f32 = 0.25; // height above surface still counts as grounded
const WALL_MARGIN: f32 = 0.6; // keep this far from the curb
const GROUND_WINDOW: usize = 10; // LUT samples scanned around the hint
const WHEEL_RADIUS: f32 = 0.38;

// Out-of-bounds respawn (M9): a kart that flies far off the circuit (a bad airborne
// trajectory after a ramp or a mortar knockback) is recovered to the nearest
// centerline frame instead of being lost. Thresholds sit well outside normal play —
// the wall clamp keeps grounded karts on-road, so these only fire on real excursions.
const OOB_MIN_HEIGHT: f32 = -7.0; // this far *below* the nearest road surface = fell off
const OOB_MAX_LATERAL: f32 = ROAD_HALF_WIDTH + 22.0; // this far to the side = flung clear
const RESPAWN_SPEED_KEEP: f32 = 0.3; // fraction of speed kept after a recovery
const RESPAWN_LIFT: f32 = 0.2; // drop height on respawn (< CONTACT_THRESH → grounded next tick)

// Starting grid layout (all karts behind the start/finish line; see spawn()).
const GRID_START_BACK: f32 = 7.0; // front row's distance behind the line
const GRID_ROW_GAP: f32 = 3.2; // distance between staggered grid rows

// Drift / mini-turbo
const DRIFT_MIN_SPEED: f32 = 18.0;
const DRIFT_BIAS: f32 = 0.55; // baked-in turn toward the drift direction
const DRIFT_STEER_INFLUENCE: f32 = 0.50; // counter/inside steer modulation
const DRIFT_TURN_RATE: f32 = 3.0;
const DRIFT_VIS_ANGLE: f32 = 0.5; // visual slide yaw of the model
const MINI_TURBO_TIME: f32 = 1.5; // -> blue
const SUPER_TIME: f32 = 3.0; // -> orange
const BLUE_BOOST_DUR: f32 = 0.7;
const ORANGE_BOOST_DUR: f32 = 1.1;

// Tricks
const TRICK_MIN_AIR: f32 = 0.15; // must be airborne this long before a trick
const TRICK_SPIN_RATE: f32 = 12.0; // visual flip speed
const TRICK_BOOST_DUR: f32 = 0.5;

// Boost
const BOOST_SPEED_MULT: f32 = 1.40;
const BOOST_ACCEL_MULT: f32 = 2.50;
/// Boost granted by driving over a track boost pad (M8). Sits between the blue and
/// orange mini-turbo durations, reusing the same `boost_time` machinery.
const PAD_BOOST_DUR: f32 = 0.9;

/// Slipstream / draft (M5.1): a fully-drafting kart (factor 1.0) gets this much
/// extra top speed as an *overspeed allowance*. `combat.rs` decides **who** is
/// drafting (the 0..1 factor, ramped/decayed); this is **what** it does to speed.
/// +13 % sits in the design's 10–15 % band. Stacks multiplicatively with boost, so
/// a draft chained into a boost pad is a genuinely big run.
const DRAFT_SPEED_MULT: f32 = 0.13;

// AI
const AI_LOOKAHEAD_U: f32 = 0.25; // spline parameter ahead to aim at
const AI_STEER_GAIN: f32 = 1.6;
const AI_DRIFT_ANGLE: f32 = 0.5; // start drifting past this heading error (rad)

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
pub struct Input {
    pub throttle: f32, // 0..1
    pub brake: f32,    // 0..1
    pub steer: f32,    // -1 (left) .. +1 (right)
    pub drift_held: bool,
    pub drift_pressed: bool, // rising edge this tick
    pub trick_pressed: bool, // rising edge (jump / drift while airborne)
    pub use_item: bool,
    pub fire: bool, // cannon trigger (held); reload gates the actual cadence
}

// ----------------------------------------------------------------------------
// Drift / trick state
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SparkStage {
    None,
    Blue,
    Orange,
}

#[derive(Clone, Copy)]
pub enum DriftState {
    None,
    Active { dir: f32, charge: f32, stage: SparkStage },
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TrickState {
    Idle,
    Charged,
}

// ----------------------------------------------------------------------------
// Kart state
// ----------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct KartState {
    pub position: Vec3,
    pub velocity: Vec3,
    pub forward: Vec3,
    pub up: Vec3,

    pub track_u: f32, // ground-query hint (last known progress)
    pub grounded: bool,
    pub air_time: f32,

    pub drift: DriftState,
    pub trick: TrickState,
    pub boost_time: f32,

    pub speed: f32,        // cached planar speed along forward (signed)
    pub lap_distance: f32, // monotonic forward distance (for standings/HUD)

    // Visual-only, smoothed for the interpolated renderer.
    pub wheel_spin: f32,
    pub steer_vis: f32,
    pub drift_vis: f32,
    pub trick_spin: f32,
}

impl KartState {
    /// Spawn on the starting grid, staggered into a 2-wide column. The whole
    /// grid sits *behind* the start/finish line ([`GRID_START_BACK`]) so that
    /// every kart's first line crossing legitimately opens lap 1 — the Race
    /// Director relies on this for consistent, exploit-proof lap counting.
    pub fn spawn(track: &TrackSpline, grid_index: usize) -> Self {
        let f = track.start_frame();
        let row = (grid_index / 2) as f32; // two karts share each grid row
        let lateral = if grid_index % 2 == 0 { 2.5 } else { -2.5 };
        let back = GRID_START_BACK + row * GRID_ROW_GAP;
        let pos = f.position - f.forward * back + f.right * lateral;
        let g = track.ground_query(pos);
        Self {
            position: g.surface,
            velocity: Vec3::ZERO,
            forward: f.forward,
            up: g.normal,
            track_u: g.u,
            grounded: true,
            air_time: 0.0,
            drift: DriftState::None,
            trick: TrickState::Idle,
            boost_time: 0.0,
            speed: 0.0,
            lap_distance: 0.0,
            wheel_spin: 0.0,
            steer_vis: 0.0,
            drift_vis: 0.0,
            trick_spin: 0.0,
        }
    }

    // -- queries used by the renderer / HUD --------------------------------

    #[inline]
    pub fn spark_stage(&self) -> SparkStage {
        match self.drift {
            DriftState::Active { stage, .. } => stage,
            DriftState::None => SparkStage::None,
        }
    }

    #[inline]
    pub fn is_drifting(&self) -> bool {
        matches!(self.drift, DriftState::Active { .. })
    }

    #[inline]
    pub fn is_boosting(&self) -> bool {
        self.boost_time > 0.0
    }

    /// 0..~1.4, used to scale camera FOV for the "speed juice".
    #[inline]
    pub fn speed_ratio(&self) -> f32 {
        (self.speed.abs() / MAX_SPEED).clamp(0.0, 1.4)
    }

    #[inline]
    pub fn right(&self) -> Vec3 {
        self.forward.cross(self.up).normalize()
    }

    // -- the fixed-timestep step -------------------------------------------

    /// `draft` is this kart's slipstream factor in `0..1` (M5.1), computed by
    /// `combat.rs` and threaded in as a parallel-array value (never stored on
    /// `KartState`, keeping it lean & `Copy`). It raises the grounded speed
    /// ceiling; airborne karts have no ceiling, so it's ignored in the air.
    pub fn step(&mut self, input: &Input, track: &TrackSpline, draft: f32, dt: f32) {
        if self.boost_time > 0.0 {
            self.boost_time = (self.boost_time - dt).max(0.0);
        }

        // Integrate gravity + position in world space.
        self.velocity += GRAVITY_VEC * dt;
        self.position += self.velocity * dt;

        // Where are we relative to the road?
        let g = track.ground_query_hint(self.position, self.track_u, GROUND_WINDOW);
        self.track_u = g.u;

        // Out-of-bounds recovery (M9): if we've left the circuit entirely (fell well
        // below it, or got flung clear of the side), snap back to the nearest frame
        // upright with scrubbed speed and skip the rest of this step. Runs *before*
        // the wall clamp so a big excursion respawns cleanly instead of being yanked.
        if g.height < OOB_MIN_HEIGHT || g.lateral.abs() > OOB_MAX_LATERAL {
            self.respawn_to_track(track);
            return;
        }

        // Keep inside the curbs.
        let limit = ROAD_HALF_WIDTH - WALL_MARGIN;
        if g.lateral.abs() > limit {
            let over = g.lateral.signum() * (g.lateral.abs() - limit);
            self.position -= g.right * over;
            let v_lat = self.velocity.dot(g.right);
            if v_lat.signum() == g.lateral.signum() {
                self.velocity -= g.right * v_lat; // cancel into-wall motion
            }
        }

        if g.height <= CONTACT_THRESH {
            self.grounded_step(input, &g, draft, dt);
        } else {
            self.airborne_step(input, dt);
        }

        // Boost pads (M8): driving over a pad grants a boost. Reuses the ground
        // query's `u`/`lateral` (no extra spatial lookup) and the existing boost
        // timer, so the camera juice + boost SFX fire automatically.
        if self.grounded && g.on_road && track.boost_at(g.u, g.lateral) {
            self.boost_time = self.boost_time.max(PAD_BOOST_DUR);
        }

        // Visual smoothing.
        self.steer_vis = lerp(self.steer_vis, input.steer, (12.0 * dt).min(1.0));
        let drift_target = match self.drift {
            DriftState::Active { dir, .. } => dir * DRIFT_VIS_ANGLE,
            DriftState::None => 0.0,
        };
        self.drift_vis = lerp(self.drift_vis, drift_target, (10.0 * dt).min(1.0));
        self.wheel_spin += self.speed * dt / WHEEL_RADIUS;
    }

    /// Recover an out-of-bounds kart onto the circuit (M9). Uses a full ground
    /// query (the O(n) one — this is a rare path, never per normal tick) to find
    /// the genuinely nearest centerline frame regardless of how stale the hint is,
    /// then sets the kart there upright, facing along the track, with its speed
    /// scrubbed and all drift/trick/boost state cleared. The caller (`step`) returns
    /// immediately after, so this tick does no further integration; `game.rs` snaps
    /// the render-interpolation `prev` so the teleport doesn't streak.
    fn respawn_to_track(&mut self, track: &TrackSpline) {
        let g = track.ground_query(self.position);
        self.position = g.center + g.normal * RESPAWN_LIFT;
        self.up = g.normal;
        self.forward = project_plane(g.forward, g.normal);
        self.track_u = g.u;
        self.grounded = true;
        self.air_time = 0.0;
        self.drift = DriftState::None;
        self.trick = TrickState::Idle;
        self.trick_spin = 0.0;
        self.boost_time = 0.0;
        self.speed *= RESPAWN_SPEED_KEEP;
        self.velocity = self.forward * self.speed;
    }

    fn grounded_step(&mut self, input: &Input, g: &crate::track_3d::GroundInfo, draft: f32, dt: f32) {
        // Snap onto the surface, remove the gap/penetration along the normal.
        self.position -= g.normal * g.height;
        let was_airborne = !self.grounded;
        self.grounded = true;
        self.up = g.normal;
        self.forward = project_plane(self.forward, self.up);

        // Landing: cash in a charged trick, reset air state.
        if was_airborne {
            if self.trick == TrickState::Charged {
                self.boost_time = self.boost_time.max(TRICK_BOOST_DUR);
            }
            self.trick = TrickState::Idle;
            self.trick_spin = 0.0;
        }
        self.air_time = 0.0;

        // `self.speed` is the authoritative forward speed; integrate it directly
        // so acceleration accumulates frame-to-frame.
        let mut speed = self.speed;
        let boosting = self.boost_time > 0.0;
        // Slipstream raises the base ceiling (overspeed allowance); boost still
        // multiplies on top, so draft + pad chains stack into a big run.
        let base_max = MAX_SPEED * (1.0 + DRAFT_SPEED_MULT * draft.clamp(0.0, 1.0));
        let target_max = if boosting { base_max * BOOST_SPEED_MULT } else { base_max };
        if input.throttle > 0.0 {
            let accel = ACCEL * input.throttle * if boosting { BOOST_ACCEL_MULT } else { 1.0 };
            // Throttle alone can't exceed target_max, but it never cuts existing
            // overspeed gained from a boost (that bleeds off below).
            let ceil = target_max.max(speed);
            speed = (speed + accel * dt).min(ceil);
        }
        if input.brake > 0.0 {
            speed -= BRAKE_DECEL * input.brake * dt;
        }
        if input.throttle == 0.0 && input.brake == 0.0 {
            let f = COAST_FRICTION * dt;
            speed -= speed.clamp(-f, f); // ease toward 0
        }
        if speed > target_max {
            speed -= (speed - target_max) * OVERSPEED_DECAY * dt;
        }
        speed = speed.max(REVERSE_MAX);

        // Drift state machine + steering.
        let fast_enough = speed > DRIFT_MIN_SPEED;
        self.update_drift(input, fast_enough, dt);
        let turn = match self.drift {
            DriftState::Active { dir, .. } => {
                (dir * DRIFT_BIAS + input.steer * DRIFT_STEER_INFLUENCE) * DRIFT_TURN_RATE
            }
            DriftState::None => input.steer * TURN_RATE,
        };
        // steer>0 = right => negative rotation about up (see derivation in notes).
        let q = Quat::from_axis_angle(self.up, -turn * dt);
        self.forward = project_plane(q * self.forward, self.up);

        // Velocity follows the heading, which is tangent to the surface — so the
        // kart climbs hills and, at a ramp's crest, carries its up-and-forward
        // momentum into the air (gravity then takes over in airborne_step).
        self.speed = speed;
        self.velocity = self.forward * speed;
        self.lap_distance += speed.max(0.0) * dt;
    }

    fn airborne_step(&mut self, input: &Input, dt: f32) {
        self.grounded = false;
        self.air_time += dt;

        // Limited mid-air yaw.
        if input.steer != 0.0 {
            let q = Quat::from_axis_angle(Vec3::Y, -input.steer * AIR_TURN_RATE * dt);
            self.forward = (q * self.forward).normalize();
        }

        // Trick: a press while airborne arms the landing boost.
        if input.trick_pressed && self.air_time > TRICK_MIN_AIR && self.trick == TrickState::Idle {
            self.trick = TrickState::Charged;
        }
        if self.trick == TrickState::Charged {
            self.trick_spin += TRICK_SPIN_RATE * dt;
        }

        // Drift charge pauses in the air; a hard landing without the button
        // still keeps the state, matching MKWii's "keep the drift" feel.
        self.speed = self.velocity.length();

        // Ease `up` back toward world up so landings are stable.
        self.up = self.up.lerp(Vec3::Y, (2.0 * dt).min(1.0)).normalize();
    }

    fn update_drift(&mut self, input: &Input, fast_enough: bool, dt: f32) {
        match &mut self.drift {
            DriftState::None => {
                if input.drift_pressed && fast_enough && input.steer.abs() > 0.2 {
                    self.drift = DriftState::Active {
                        dir: input.steer.signum(),
                        charge: 0.0,
                        stage: SparkStage::None,
                    };
                }
            }
            DriftState::Active { charge, stage, .. } => {
                if !input.drift_held || !fast_enough {
                    // Release -> award the charged mini-turbo.
                    let dur = match *stage {
                        SparkStage::Orange => ORANGE_BOOST_DUR,
                        SparkStage::Blue => BLUE_BOOST_DUR,
                        SparkStage::None => 0.0,
                    };
                    if dur > 0.0 {
                        self.boost_time = self.boost_time.max(dur);
                    }
                    self.drift = DriftState::None;
                } else {
                    *charge += dt;
                    *stage = if *charge >= SUPER_TIME {
                        SparkStage::Orange
                    } else if *charge >= MINI_TURBO_TIME {
                        SparkStage::Blue
                    } else {
                        SparkStage::None
                    };
                }
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Render interpolation (between two fixed-step states)
// ----------------------------------------------------------------------------

/// A smoothed pose for one render frame, produced by [`interpolate`].
#[derive(Clone, Copy)]
pub struct RenderPose {
    pub position: Vec3,
    pub forward: Vec3,
    pub up: Vec3,
    pub drift_yaw: f32, // extra model yaw for the visual slide
    pub trick_spin: f32,
    pub wheel_spin: f32,
    pub steer_vis: f32,
}

/// Interpolate between the previous and current physics states (`t` in 0..1).
pub fn interpolate(a: &KartState, b: &KartState, t: f32) -> RenderPose {
    RenderPose {
        position: a.position.lerp(b.position, t),
        forward: nlerp(a.forward, b.forward, t),
        up: nlerp(a.up, b.up, t),
        drift_yaw: lerp(a.drift_vis, b.drift_vis, t),
        trick_spin: lerp(a.trick_spin, b.trick_spin, t),
        wheel_spin: lerp(a.wheel_spin, b.wheel_spin, t),
        steer_vis: lerp(a.steer_vis, b.steer_vis, t),
    }
}

// ----------------------------------------------------------------------------
// AI (parallelizable)
// ----------------------------------------------------------------------------

/// Solve one AI kart's input: aim at a point ahead on the spline, drift through
/// hard corners, lift off the throttle when badly misaligned. `skill` in 0..1.
pub fn ai_input(kart: &KartState, track: &TrackSpline, skill: f32) -> Input {
    let look = AI_LOOKAHEAD_U * (0.7 + skill * 0.6);
    let target = track.point(kart.track_u + look);

    let up = kart.up;
    let to = target - kart.position;
    let flat = to - up * to.dot(up);
    let dir = if flat.length_squared() > 1e-6 {
        flat.normalize()
    } else {
        kart.forward
    };

    // Signed heading error around `up` (positive = target is to the left).
    let s = kart.forward.cross(dir).dot(up);
    let c = kart.forward.dot(dir);
    let angle = s.atan2(c);
    let steer = (-angle * AI_STEER_GAIN).clamp(-1.0, 1.0); // -angle: left target -> steer left

    let sharp = angle.abs();
    let brake = if sharp > 1.0 && kart.speed > MAX_SPEED * 0.7 { 0.4 } else { 0.0 };
    let throttle = if brake > 0.0 { 0.4 } else { 1.0 };

    let want_drift = sharp > AI_DRIFT_ANGLE && kart.speed > DRIFT_MIN_SPEED && kart.grounded;
    let drift_pressed = want_drift && matches!(kart.drift, DriftState::None);
    let trick_pressed =
        !kart.grounded && kart.air_time > TRICK_MIN_AIR && kart.trick == TrickState::Idle;

    Input {
        throttle,
        brake,
        steer,
        drift_held: want_drift,
        drift_pressed,
        trick_pressed,
        use_item: false,
        fire: false, // combat AI (aiming/firing) lands in Milestone 3
    }
}

/// Fill `out` with AI inputs for every kart in parallel across all cores.
/// Caller owns the buffers — no allocation happens here.
pub fn compute_ai_inputs(
    karts: &[KartState],
    skills: &[f32],
    track: &TrackSpline,
    out: &mut [Input],
) {
    out.par_iter_mut().enumerate().for_each(|(i, o)| {
        *o = ai_input(&karts[i], track, skills[i]);
    });
}

/// Advance all karts one fixed step in parallel. `inputs[i]` drives `karts[i]`;
/// `draft[i]` is its slipstream factor (M5.1), a parallel array exactly like
/// `inputs` — `combat.rs` fills it each tick and it feeds the next.
pub fn step_all(karts: &mut [KartState], inputs: &[Input], draft: &[f32], track: &TrackSpline, dt: f32) {
    karts.par_iter_mut().enumerate().for_each(|(i, k)| {
        k.step(&inputs[i], track, draft[i], dt);
    });
}

// ----------------------------------------------------------------------------
// Particles (ring-buffer pool, parallel integration)
// ----------------------------------------------------------------------------

const PARTICLE_GRAVITY: Vec3 = Vec3::new(0.0, -9.0, 0.0);

#[derive(Clone, Copy)]
pub struct Particle {
    pub pos: Vec3,
    pub vel: Vec3,
    pub life: f32,
    pub max_life: f32,
    pub size: f32,
    pub color: Color,
}

impl Particle {
    const fn dead() -> Self {
        Self {
            pos: Vec3::ZERO,
            vel: Vec3::ZERO,
            life: 0.0,
            max_life: 1.0,
            size: 0.0,
            color: Color::new(0.0, 0.0, 0.0, 0.0),
        }
    }

    /// Remaining life as 0..1 (handy for fading alpha/size when drawing).
    #[inline]
    pub fn life_ratio(&self) -> f32 {
        (self.life / self.max_life).clamp(0.0, 1.0)
    }

    #[inline]
    pub fn alive(&self) -> bool {
        self.life > 0.0
    }
}

/// Fixed-capacity particle pool. Allocated once; `emit` overwrites in a ring so
/// the gameplay loop never touches the heap.
pub struct ParticleSystem {
    pub particles: Vec<Particle>,
    cursor: usize,
}

impl ParticleSystem {
    pub fn with_capacity(n: usize) -> Self {
        Self {
            particles: vec![Particle::dead(); n.max(1)],
            cursor: 0,
        }
    }

    #[inline]
    pub fn emit(&mut self, p: Particle) {
        let n = self.particles.len();
        self.particles[self.cursor] = p;
        self.cursor = (self.cursor + 1) % n;
    }

    /// Integrate every particle in parallel (decay + ballistic motion).
    pub fn update(&mut self, dt: f32) {
        self.particles.par_iter_mut().for_each(|pt| {
            if pt.life > 0.0 {
                pt.life -= dt;
                pt.vel += PARTICLE_GRAVITY * dt;
                pt.pos += pt.vel * dt;
            }
        });
    }

    /// Spit drift sparks from the rear wheels in the current mini-turbo color.
    pub fn emit_drift_sparks(&mut self, kart: &KartState) {
        let color = match kart.spark_stage() {
            SparkStage::Blue => BLUE_SPARK,
            SparkStage::Orange => ORANGE_SPARK,
            SparkStage::None => return,
        };
        let right = kart.right();
        let rear = kart.position - kart.forward * 1.0 + kart.up * 0.3;
        for side in [-1.0_f32, 1.0] {
            let base = rear + right * (0.8 * side);
            for _ in 0..2 {
                let vel = kart.up * gen_range(1.5, 3.5)
                    - kart.forward * gen_range(0.0, 2.0)
                    + right * gen_range(-1.5, 1.5);
                self.emit(Particle {
                    pos: base,
                    vel,
                    life: 0.35,
                    max_life: 0.35,
                    size: gen_range(0.10, 0.25),
                    color,
                });
            }
        }
    }

    /// A radial burst at `pos` — used for cannon impacts and mortar/mine blasts.
    /// `power` scales both the spray speed and the puff size (1.0 ≈ a laser tick,
    /// 3.0 ≈ a heavy mortar detonation).
    pub fn emit_explosion(&mut self, pos: Vec3, color: Color, power: f32) {
        let n = (6.0 * power) as i32 + 4;
        for _ in 0..n {
            let dir = vec3(
                gen_range(-1.0, 1.0),
                gen_range(0.2, 1.0),
                gen_range(-1.0, 1.0),
            );
            self.emit(Particle {
                pos,
                vel: dir.normalize_or_zero() * gen_range(2.0, 6.0) * power,
                life: gen_range(0.3, 0.6),
                max_life: 0.6,
                size: gen_range(0.15, 0.35) * power,
                color,
            });
        }
    }

    /// A quick spark cone at `pos` along `dir` — the muzzle flash when a cannon
    /// fires.
    pub fn emit_muzzle(&mut self, pos: Vec3, dir: Vec3, color: Color) {
        for _ in 0..5 {
            let jitter = vec3(
                gen_range(-0.4, 0.4),
                gen_range(-0.4, 0.4),
                gen_range(-0.4, 0.4),
            );
            self.emit(Particle {
                pos,
                vel: (dir + jitter).normalize_or_zero() * gen_range(4.0, 9.0),
                life: 0.18,
                max_life: 0.18,
                size: gen_range(0.10, 0.22),
                color,
            });
        }
    }

    /// Light exhaust puff (call occasionally while throttling).
    pub fn emit_exhaust(&mut self, kart: &KartState) {
        let right = kart.right();
        let back = kart.position - kart.forward * 1.25 + kart.up * 0.7;
        for side in [-0.45_f32, 0.45] {
            let base = back + right * side;
            self.emit(Particle {
                pos: base,
                vel: -kart.forward * gen_range(1.0, 3.0) + kart.up * gen_range(0.5, 1.5),
                life: 0.5,
                max_life: 0.5,
                size: gen_range(0.15, 0.30),
                color: Color::new(0.6, 0.6, 0.62, 0.5),
            });
        }
    }
}

// ----------------------------------------------------------------------------
// Math helpers
// ----------------------------------------------------------------------------

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
fn nlerp(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    let v = a.lerp(b, t);
    if v.length_squared() > 1e-8 {
        v.normalize()
    } else {
        a
    }
}

/// Project `v` onto the plane with normal `n` and renormalize (keeps headings
/// unit-length and tangent to the surface).
#[inline]
fn project_plane(v: Vec3, n: Vec3) -> Vec3 {
    let p = v - n * v.dot(n);
    if p.length_squared() > 1e-8 {
        p.normalize()
    } else {
        v
    }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::track_3d::TrackSpline;

    fn drive(_input: Input) -> (TrackSpline, KartState) {
        let track = TrackSpline::demo_circuit();
        let kart = KartState::spawn(&track, 0);
        (track, kart)
    }

    #[test]
    fn throttle_accelerates_and_stays_grounded() {
        let (track, mut kart) = drive(Input::default());
        let input = Input { throttle: 1.0, ..Default::default() };
        for _ in 0..30 {
            kart.step(&input, &track, 0.0, FIXED_DT);
        }
        assert!(kart.speed > 5.0, "expected the kart to speed up, got {}", kart.speed);
        assert!(kart.grounded);
    }

    #[test]
    fn drift_charges_to_blue_then_releases_boost() {
        let (track, mut kart) = drive(Input::default());
        // Pre-load speed and a nearly-charged drift.
        kart.speed = 40.0;
        kart.velocity = kart.forward * 40.0;
        kart.drift = DriftState::Active { dir: 1.0, charge: 1.49, stage: SparkStage::None };

        let holding = Input { throttle: 1.0, steer: 0.5, drift_held: true, ..Default::default() };
        kart.step(&holding, &track, 0.0, FIXED_DT);
        assert_eq!(kart.spark_stage(), SparkStage::Blue);

        let release = Input { throttle: 1.0, steer: 0.5, drift_held: false, ..Default::default() };
        kart.step(&release, &track, 0.0, FIXED_DT);
        assert!(kart.is_boosting(), "releasing a blue drift should grant a boost");
        assert!(matches!(kart.drift, DriftState::None));
    }

    #[test]
    fn airborne_when_lifted_off_the_track() {
        let (track, mut kart) = drive(Input::default());
        kart.position += kart.up * 10.0; // teleport into the air
        kart.velocity = Vec3::ZERO;
        kart.step(&Input::default(), &track, 0.0, FIXED_DT);
        assert!(!kart.grounded);
        assert!(kart.velocity.y < 0.0, "gravity should pull the kart down");
    }

    #[test]
    fn trick_arms_in_air_and_boosts_on_landing() {
        let (track, mut kart) = drive(Input::default());
        // Simulate being airborne with a trick already armed, then land.
        kart.grounded = false;
        kart.air_time = 0.5;
        kart.trick = TrickState::Charged;
        kart.position = track.start_frame().position + track.start_frame().up * 0.05;
        kart.velocity = -track.start_frame().up * 2.0;
        kart.step(&Input { throttle: 1.0, ..Default::default() }, &track, 0.0, FIXED_DT);
        assert!(kart.grounded);
        assert!(kart.is_boosting(), "landing a trick should grant a boost");
    }

    #[test]
    fn boost_pad_grants_boost_only_when_driven_over() {
        let track = TrackSpline::demo_circuit();
        let pad = track.boost_pads()[0];

        // Centered on the pad → a single step grants a boost.
        let mut k = KartState::spawn(&track, 0);
        k.position = pad.frame.position;
        k.forward = pad.frame.forward;
        k.up = pad.frame.up;
        k.track_u = pad.u_center;
        k.speed = 20.0;
        k.velocity = k.forward * 20.0;
        k.step(&Input { throttle: 1.0, ..Default::default() }, &track, 0.0, FIXED_DT);
        assert!(k.is_boosting(), "driving over a pad should grant a boost");

        // Same spot, but out at the curb beyond the pad strip → no boost.
        let mut k2 = KartState::spawn(&track, 0);
        k2.position = pad.frame.position + pad.frame.right * (pad.half_width + 1.5);
        k2.forward = pad.frame.forward;
        k2.up = pad.frame.up;
        k2.track_u = pad.u_center;
        k2.speed = 20.0;
        k2.velocity = k2.forward * 20.0;
        k2.step(&Input { throttle: 1.0, ..Default::default() }, &track, 0.0, FIXED_DT);
        assert!(!k2.is_boosting(), "missing the pad strip should grant no boost");
    }

    #[test]
    fn off_track_kart_respawns_onto_the_circuit() {
        let track = TrackSpline::demo_circuit();
        let mut k = KartState::spawn(&track, 0);
        let f = track.start_frame();
        // Fling the kart 50 m off to the side, at speed (a worst-case excursion).
        k.position = f.position + f.right * 50.0;
        k.speed = 40.0;
        k.velocity = f.forward * 40.0;

        // Within 1 s of sim it should have recovered onto the road.
        for _ in 0..60 {
            k.step(&Input::default(), &track, 0.0, FIXED_DT);
        }

        let g = track.ground_query(k.position);
        assert!(
            g.lateral.abs() <= ROAD_HALF_WIDTH,
            "kart should be back on the road, lateral {}",
            g.lateral
        );
        assert!(k.up.dot(g.normal) > 0.9, "kart should be upright after a respawn");
        assert!(k.speed.abs() < 40.0, "respawn should scrub speed, got {}", k.speed);
    }

    #[test]
    fn particle_pool_is_fixed_size() {
        let mut ps = ParticleSystem::with_capacity(8);
        for _ in 0..100 {
            ps.emit(Particle { life: 1.0, max_life: 1.0, ..Particle::dead() });
        }
        assert_eq!(ps.particles.len(), 8); // ring buffer never grows
        ps.update(0.5);
        assert!(ps.particles.iter().all(|p| p.life <= 0.5 + 1e-6));
    }
}
