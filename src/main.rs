//! main.rs — window, top-level flow, camera, rendering, HUD.
//!
//! The simulation and the game-flow state machine live in [`game::Game`]; this
//! file is the thin GPU/IO shell around it. Each frame it samples keys into a
//! [`game::FrameInput`], advances the game ([`Game::update`], which runs the
//! sacred 60 Hz fixed-step loop internally), then renders the current
//! [`GameState`]. Rendering interpolates between the previous and current physics
//! states (`game.alpha`) for stutter-free motion; meshes are placed with the GL
//! model-matrix stack (no per-frame vertex churn); the chase camera widens its
//! FOV with speed for the Mario-Kart-Wii "speed juice".

// Some helper APIs are intentionally part of the toolkit but not all wired into
// the demo yet (extra HUD icons, the item-use input, the full GroundInfo, sky
// gradient). They're ready for the next features, so don't warn on them.
#![allow(dead_code)]

mod audio;
mod combat;
mod game;
mod mesh_gen;
mod physics;
mod race;
mod shaders;
mod track_3d;

use macroquad::models::Mesh;
use macroquad::prelude::*;
use macroquad::rand::gen_range;

use audio::AudioBank;
use combat::{Combat, ItemKind};
use game::{
    Flow, FrameInput, Game, GameState, CLASS_ORDER, FOV_MAX, FOV_MIN, NUM_KARTS, SETTINGS_ROWS,
    TRACK_NAMES, TRACK_ORDER,
};
use mesh_gen::{
    build_item_box_mesh, draw_boost_spark, draw_pixel_text, gen_item_box_texture,
    pixel_text_width, BLUE_SPARK, ORANGE_SPARK,
};
use physics::{interpolate, Input, KartState, RenderPose, SparkStage};
use race::{Phase, RaceDirector};
use shaders::Shaders;
use track_3d::{build_track_meshes, Frame, TrackSpline};

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

const CAM_DIST: f32 = 8.5;
const CAM_HEIGHT: f32 = 3.6;
const CAM_LERP: f32 = 8.0; // higher = stiffer chase cam
const CAM_TARGET_LIFT: f32 = 1.3;

const BASE_FOV: f32 = 1.0; // radians (~57 deg)
const FOV_SPEED: f32 = 0.30; // extra FOV at top speed
const FOV_BOOST: f32 = 0.20; // extra FOV while boosting

const SHAKE_MAX_OFFSET: f32 = 0.35; // metres of camera jitter at full shake (M9)
const PLACE_FLASH_SECS: f32 = 1.6; // how long a position-change arrow stays up (M9)

const GRASS: Color = Color::new(0.27, 0.55, 0.27, 1.0);
const SKY: Color = Color::new(0.45, 0.70, 1.00, 1.0);

const WHEEL_Y: f32 = 0.38; // matches WHEEL_RADIUS in physics/mesh_gen
const WHEEL_OFFSETS: [(f32, f32, bool); 4] = [
    (0.80, 0.95, true),   // front-right
    (-0.80, 0.95, true),  // front-left
    (0.80, -0.95, false), // rear-right
    (-0.80, -0.95, false),// rear-left
];

const MINIMAP_SIZE: f32 = 190.0; // side of the HUD radar panel, px (M10)

/// Top-down HUD minimap (M10): the circuit centerline sampled once into world-XZ
/// points, plus the bounds to map live kart positions into the same panel. Built
/// like the road meshes — once per track change, never per frame.
struct Minimap {
    loop_xz: Vec<Vec2>, // world-space (x, z) centerline samples, a closed loop
    center: Vec2,       // world-XZ center of the layout
    extent: f32,        // largest world-XZ span, for a uniform (undistorted) fit
}

impl Minimap {
    fn build(track: &TrackSpline) -> Self {
        let segs = track.segment_count();
        let n = (segs * 8).max(8); // smooth enough for a small radar
        let mut loop_xz = Vec::with_capacity(n);
        let mut lo = Vec2::splat(f32::INFINITY);
        let mut hi = Vec2::splat(f32::NEG_INFINITY);
        for i in 0..n {
            let u = i as f32 / n as f32 * segs as f32;
            let p = track.point(u);
            let xz = vec2(p.x, p.z);
            loop_xz.push(xz);
            lo = lo.min(xz);
            hi = hi.max(xz);
        }
        Self { loop_xz, center: (lo + hi) * 0.5, extent: (hi - lo).max_element().max(1.0) }
    }

    /// Map a world-XZ point into the panel at (`ox`,`oy`) of side `size`. Uniform
    /// scale (no aspect distortion) with a small inset; world +Z maps downward on
    /// screen, matching a top-down look.
    #[inline]
    fn project(&self, xz: Vec2, ox: f32, oy: f32, size: f32) -> Vec2 {
        let inset = size * 0.12;
        let s = (size - 2.0 * inset) / self.extent;
        let d = (xz - self.center) * s;
        vec2(ox + size * 0.5 + d.x, oy + size * 0.5 + d.y)
    }
}

fn window_conf() -> Conf {
    Conf {
        window_title: "Wii Kart — Rust / macroquad".to_owned(),
        window_width: 1280,
        window_height: 720,
        high_dpi: true,
        sample_count: 4, // MSAA — the Arc iGPU eats this for breakfast
        ..Default::default()
    }
}

#[macroquad::main(window_conf)]
async fn main() {
    // The game owns the world + simulation; we own the GPU resources and camera.
    let mut game = Game::new();
    // GPU road meshes for the live track; rebuilt when `game.track_dirty` (M8).
    let mut track_meshes = build_track_meshes(&game.track);
    // HUD radar outline for the live track; rebuilt on the same signal (M10).
    let mut minimap = Minimap::build(&game.track);
    // Prebuilt splines + meshes for every selectable circuit, for the track-select
    // preview (built once at load — no per-frame mesh churn).
    let track_splines: Vec<TrackSpline> = TRACK_ORDER.iter().map(|ctor| ctor()).collect();
    let track_previews: Vec<Vec<Mesh>> = track_splines.iter().map(build_track_meshes).collect();
    let shaders = Shaders::load();
    // The "?" item box (M13) is textured, so it's built here where the GPU texture
    // context exists — not in the headless `Game`.
    let item_box_mesh = build_item_box_mesh(gen_item_box_texture(64));
    // Procedural audio (M7): all PCM synthesized + decoded once, here. Needs the
    // window's audio context, so it lives in `main`, never in the headless `Game`.
    let mut audio = AudioBank::load().await;

    // Chase-cam smoothing state (used in Race/Results; snapped on race entry).
    let seed = pose_of(&game.karts[0]);
    let mut cam_eye = seed.position - seed.forward * CAM_DIST + seed.up * CAM_HEIGHT;
    let mut cam_up = seed.up;
    let mut prev_state = game.state;

    // Position-change arrow state (M9, render-side only): flash a ▲/▼ by the POS
    // readout when the player gains/loses a place.
    let mut prev_player_pos = 0u8;
    let mut place_flash = 0.0f32;
    let mut place_dir = 0i8;

    let start_time = get_time();

    loop {
        // ===================== INPUT + FLOW =====================
        let fi = sample_frame_input();
        let frame_dt = get_frame_time();
        if let Flow::Quit = game.update(&fi, frame_dt) {
            break;
        }

        // ===================== AUDIO =====================
        // `[` / `]` trim the master-volume *setting* (the same value the M11 Settings
        // screen edits); we then mirror it into the bank each frame so either path
        // takes effect at once. Finally drain the one-shots and drive the continuous
        // voices (engine pitch ← speed, drift screech ← drift state).
        if is_key_pressed(KeyCode::LeftBracket) {
            game.settings.master_volume = (game.settings.master_volume - game::VOLUME_STEP).max(0.0);
        }
        if is_key_pressed(KeyCode::RightBracket) {
            game.settings.master_volume = (game.settings.master_volume + game::VOLUME_STEP).min(1.0);
        }
        audio.set_master(game.settings.master_volume);
        audio.play_all(&game.events);
        let racing = game.state == GameState::Race && !game.paused;
        audio.update_engine(game.karts[0].speed_ratio(), racing);
        audio.update_drift(racing && game.karts[0].is_drifting());

        // Rebuild the GPU road meshes + HUD radar when a new circuit was committed.
        if game.track_dirty {
            track_meshes = build_track_meshes(&game.track);
            minimap = Minimap::build(&game.track);
            game.track_dirty = false;
        }

        let t = (get_time() - start_time) as f32; // seconds, for FX animation
        let entered_race = game.state == GameState::Race && prev_state != GameState::Race;
        place_flash = (place_flash - frame_dt).max(0.0);
        if entered_race {
            prev_player_pos = game.race.player_position();
            place_flash = 0.0;
        }

        // ===================== RENDER =====================
        clear_background(SKY);
        match game.state {
            GameState::Menu => {
                let cam = menu_camera(&game.track, t);
                set_camera(&cam);
                shaders.set_camera(cam.position);
                draw_world(&game, &track_meshes, &item_box_mesh, &shaders, t);

                set_default_camera();
                draw_menu(&game, t);
            }
            GameState::Settings => {
                // Reuse the menu backdrop, then overlay the options panel (M11).
                let cam = menu_camera(&game.track, t);
                set_camera(&cam);
                shaders.set_camera(cam.position);
                draw_world(&game, &track_meshes, &item_box_mesh, &shaders, t);

                set_default_camera();
                draw_settings(&game);
            }
            GameState::ClassSelect => {
                draw_class_preview(&game, &shaders, t);

                set_default_camera();
                draw_class_select(&game);
            }
            GameState::TrackSelect => {
                let cursor = game.track_cursor;
                draw_track_preview(
                    &track_splines[cursor],
                    &track_previews[cursor],
                    &game.pad_mesh,
                    &game.accel_strip_mesh,
                    &shaders,
                    t,
                );

                set_default_camera();
                draw_track_select(cursor, &track_splines[cursor]);
            }
            GameState::Race | GameState::Results => {
                // Chase cam from the interpolated player pose.
                let p0 = interpolate(&game.prev_karts[0], &game.karts[0], game.alpha);
                let desired_eye = p0.position - p0.forward * CAM_DIST + p0.up * CAM_HEIGHT;
                if entered_race {
                    cam_eye = desired_eye; // snap so we don't sweep in from the menu
                    cam_up = p0.up;
                } else {
                    let k = 1.0 - (-CAM_LERP * frame_dt).exp();
                    cam_eye = cam_eye.lerp(desired_eye, k);
                    cam_up = cam_up.lerp(p0.up, k).normalize();
                }
                let mut eye = cam_eye;
                let mut target = p0.position + p0.up * CAM_TARGET_LIFT;

                // Screen shake (M9): jitter the eye (and a touch of the target) by
                // trauma², render-side only so it never perturbs the fixed-step sim.
                if game.shake > 0.001 {
                    let s = game.shake * game.shake * SHAKE_MAX_OFFSET;
                    let right = p0.forward.cross(cam_up).normalize_or_zero();
                    let jit = right * gen_range(-1.0, 1.0) + cam_up * gen_range(-1.0, 1.0);
                    eye += jit * s;
                    target += jit * (s * 0.5);
                }

                let boosting = game.karts[0].is_boosting();
                // Base FOV is the M11 setting; the speed/boost swell adds on top.
                let fov = game.settings.fov
                    + game.karts[0].speed_ratio() * FOV_SPEED
                    + if boosting { FOV_BOOST } else { 0.0 };
                let cam = Camera3D {
                    position: eye,
                    target,
                    up: cam_up,
                    fovy: fov,
                    ..Default::default()
                };
                set_camera(&cam);
                shaders.set_camera(cam_eye);
                draw_world(&game, &track_meshes, &item_box_mesh, &shaders, t);

                // 2D HUD.
                set_default_camera();
                let intensity = ((game.karts[0].speed_ratio() - 0.6).max(0.0) / 0.6
                    + if boosting { 0.5 } else { 0.0 })
                .clamp(0.0, 1.0);
                draw_speed_lines(intensity, t);
                draw_hud(&game.karts[0], t);
                draw_combat_hud(&game.combat, t);
                draw_race_hud(&game.race, t);

                // Position-change arrow: detect a place change, flash ▲/▼ (M9).
                if game.state == GameState::Race && !game.paused {
                    let pos = game.race.player_position();
                    if pos != prev_player_pos {
                        place_dir = if pos < prev_player_pos { 1 } else { -1 };
                        place_flash = PLACE_FLASH_SECS;
                        prev_player_pos = pos;
                    }
                }
                draw_place_arrow(place_dir, place_flash);

                // Radar (M10): hidden behind the full-screen standings board. Only
                // the active field is plotted (M11).
                if game.race.phase != Phase::Finished {
                    draw_minimap(&minimap, &game.karts[..game.active_karts]);
                }

                if game.paused {
                    draw_pause_overlay();
                }
            }
        }

        prev_state = game.state;
        next_frame().await;
    }
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------

/// Sample this frame's high-level intents (edge-triggered nav/confirm/etc. plus
/// the held driving input) into the value the state machine consumes.
fn sample_frame_input() -> FrameInput {
    let nav = is_key_pressed(KeyCode::Right) as i8 - is_key_pressed(KeyCode::Left) as i8;
    // Vertical menu nav (M11): Up/Down move the menu item / settings-row cursor.
    // These share the arrow keys with driving, but driving samples `is_key_down`
    // in `Race` only, so there's no cross-state conflict.
    let nav_v = is_key_pressed(KeyCode::Down) as i8 - is_key_pressed(KeyCode::Up) as i8;
    FrameInput {
        confirm: is_key_pressed(KeyCode::Enter),
        cancel: is_key_pressed(KeyCode::Escape),
        restart: is_key_pressed(KeyCode::R),
        nav,
        nav_v,
        player: sample_player_input(),
    }
}

fn sample_player_input() -> Input {
    let throttle = if is_key_down(KeyCode::Up) || is_key_down(KeyCode::W) { 1.0 } else { 0.0 };
    let brake = if is_key_down(KeyCode::Down) || is_key_down(KeyCode::S) { 1.0 } else { 0.0 };

    let mut steer = 0.0;
    if is_key_down(KeyCode::Left) || is_key_down(KeyCode::A) {
        steer -= 1.0;
    }
    if is_key_down(KeyCode::Right) || is_key_down(KeyCode::D) {
        steer += 1.0;
    }

    // Drift (and, while airborne, a trick) is armed by Space / LeftShift or the
    // right mouse button — a natural hold-to-slide for mouse steering setups.
    let drift_held = is_key_down(KeyCode::Space)
        || is_key_down(KeyCode::LeftShift)
        || is_mouse_button_down(MouseButton::Right);
    let drift_pressed = is_key_pressed(KeyCode::Space)
        || is_key_pressed(KeyCode::LeftShift)
        || is_mouse_button_pressed(MouseButton::Right);

    // Cannon fires while held; the per-class reload gates the actual cadence.
    let fire = is_key_down(KeyCode::LeftControl) || is_key_down(KeyCode::F);
    // Item use is edge-triggered (M13): E / LeftAlt fires the held item.
    let use_item = is_key_pressed(KeyCode::E) || is_key_pressed(KeyCode::LeftAlt);

    Input {
        throttle,
        brake,
        steer,
        drift_held,
        drift_pressed,
        trick_pressed: drift_pressed, // same key arms a trick while airborne
        use_item,
        fire,
    }
}

// ----------------------------------------------------------------------------
// World render (shared by Menu / Race / Results)
// ----------------------------------------------------------------------------

/// Draw the full 3D scene (ground, road, crates, item boxes, projectiles, karts,
/// particles). The caller sets the camera + feeds it to the shaders first.
fn draw_world(game: &Game, track_meshes: &[Mesh], item_box_mesh: &Mesh, shaders: &Shaders, t: f32) {
    draw_plane(vec3(0.0, -1.5, 0.0), vec2(500.0, 500.0), None, GRASS);

    // Road — procedural value-noise asphalt.
    shaders.use_road();
    for m in track_meshes {
        draw_mesh(m); // chunks, already in world space
    }
    gl_use_default_material();

    // Boost pads — flush on the road, pulsing via the crate material (M8).
    shaders.use_crate();
    for pad in game.track.boost_pads() {
        draw_mesh_transformed(&game.pad_mesh, pad_model_matrix(&pad.frame));
    }
    // Accel strips (M14) — longer/hotter orange-red siblings of the pads.
    for strip in game.track.accel_strips() {
        draw_mesh_transformed(&game.accel_strip_mesh, pad_model_matrix(&strip.frame));
    }
    gl_use_default_material();

    // Floating, pulsing ammo crates (GPU vertex displacement).
    shaders.use_crate();
    for (n, c) in game.combat.crates.iter().enumerate() {
        if !c.available() {
            continue;
        }
        let m = Mat4::from_translation(c.pos)
            * Mat4::from_rotation_y(t * 1.5)
            * Mat4::from_rotation_x(t * 1.1)
            * Mat4::from_scale(Vec3::splat(0.85 + 0.1 * (t * 3.0 + n as f32).sin()));
        draw_mesh_transformed(&game.crate_mesh, m);
    }
    gl_use_default_material();

    // Floating "?" item boxes (M13): the classic rainbow cube, spinning in place.
    // Textured, so drawn with the default material.
    for (n, b) in game.combat.item_boxes.iter().enumerate() {
        if !b.available() {
            continue;
        }
        let bob = (t * 2.0 + n as f32 * 1.3).sin() * 0.15;
        let m = Mat4::from_translation(b.pos + Vec3::Y * bob)
            * Mat4::from_rotation_y(t * 1.3 + n as f32)
            * Mat4::from_rotation_x(t * 0.9)
            * Mat4::from_scale(Vec3::splat(1.0));
        draw_mesh_transformed(item_box_mesh, m);
    }

    // Karts, wheels and projectiles — cel/toon shaded.
    shaders.use_toon();
    for p in &game.combat.projectiles {
        if !p.alive() {
            continue;
        }
        let m = Mat4::from_translation(p.pos) * orient_to(p.vel);
        draw_mesh_transformed(&game.proj_meshes[p.kind.index()], m);
    }
    // A spun-out kart whirls about its up axis. Only the active field is drawn (M11);
    // parked karts beyond `active_karts` sit unused on the grid, never rendered.
    for i in 0..game.active_karts {
        let pose = interpolate(&game.prev_karts[i], &game.karts[i], game.alpha);
        let model = kart_model_matrix(&pose) * Mat4::from_rotation_y(game.combat.spin_yaw(i));
        draw_mesh_transformed(&game.kart_meshes[i], model);
        draw_wheels(&game.wheel_mesh, model, &pose);
    }
    gl_use_default_material();

    // Particles (cheap fading cubes).
    for p in &game.particles.particles {
        if p.alive() {
            let mut c = p.color;
            c.a *= p.life_ratio();
            let s = p.size * (0.5 + 0.5 * p.life_ratio());
            draw_cube(p.pos, vec3(s, s, s), None, c);
        }
    }

    // Star glow (M13): a translucent pulsing aura around star-powered karts.
    for i in 0..game.active_karts {
        if game.combat.karts[i].star_time > 0.0 {
            let k = &game.karts[i];
            let pulse = 1.0 + 0.12 * (t * 10.0).sin();
            let c = Color::new(1.0, 0.95, 0.40, 0.26);
            draw_cube(k.position + k.up * 0.5, Vec3::splat(2.6 * pulse), None, c);
        }
    }
}

// ----------------------------------------------------------------------------
// Mesh placement
// ----------------------------------------------------------------------------

/// Draw a mesh through the GL model-matrix stack (no vertex copies).
fn draw_mesh_transformed(mesh: &Mesh, m: Mat4) {
    unsafe {
        get_internal_gl().quad_gl.push_model_matrix(m);
    }
    draw_mesh(mesh);
    unsafe {
        get_internal_gl().quad_gl.pop_model_matrix();
    }
}

/// World matrix for a kart from its interpolated pose (incl. drift/trick yaw).
fn kart_model_matrix(p: &RenderPose) -> Mat4 {
    let right = p.forward.cross(p.up).normalize();
    let up = right.cross(p.forward).normalize();
    let rot = Mat4::from_cols(
        right.extend(0.0),
        up.extend(0.0),
        p.forward.extend(0.0), // model +Z maps to world forward
        Vec3::ZERO.extend(1.0),
    );
    Mat4::from_translation(p.position)
        * rot
        * Mat4::from_rotation_y(p.drift_yaw)
        * Mat4::from_rotation_x(p.trick_spin)
}

/// World matrix that lays the (model-space, +Z-forward / +Y-up) boost-pad mesh
/// flush on the road at a track frame, lifted a hair so it doesn't z-fight.
fn pad_model_matrix(f: &Frame) -> Mat4 {
    let basis = Mat4::from_cols(
        f.right.extend(0.0),
        f.up.extend(0.0),
        f.forward.extend(0.0),
        Vec3::ZERO.extend(1.0),
    );
    Mat4::from_translation(f.position + f.up * 0.06) * basis
}

fn draw_wheels(wheel: &Mesh, model: Mat4, pose: &RenderPose) {
    for (wx, wz, front) in WHEEL_OFFSETS {
        let mut wm = model * Mat4::from_translation(vec3(wx, WHEEL_Y, wz));
        if front {
            wm = wm * Mat4::from_rotation_y(pose.steer_vis * 0.5);
        }
        wm = wm * Mat4::from_rotation_x(pose.wheel_spin);
        draw_mesh_transformed(wheel, wm);
    }
}

/// Build a render pose directly from a state (used to seed the camera).
fn pose_of(k: &KartState) -> RenderPose {
    interpolate(k, k, 0.0)
}

/// Rotation that maps the mesh's local +Z onto `dir` (with a stable up). Used to
/// point projectiles along their velocity. Falls back to identity for ~zero dir.
fn orient_to(dir: Vec3) -> Mat4 {
    let len2 = dir.length_squared();
    if len2 < 1e-6 {
        return Mat4::IDENTITY;
    }
    let fwd = dir / len2.sqrt();
    let mut up = Vec3::Y;
    if fwd.dot(up).abs() > 0.99 {
        up = Vec3::X; // avoid a degenerate cross when flying straight up/down
    }
    let right = up.cross(fwd).normalize();
    let up = fwd.cross(right).normalize();
    Mat4::from_cols(
        right.extend(0.0),
        up.extend(0.0),
        fwd.extend(0.0),
        Vec3::ZERO.extend(1.0),
    )
}

// ----------------------------------------------------------------------------
// Menu / Class-select (front-end states)
// ----------------------------------------------------------------------------

/// Slow auto-orbit around the starting grid for the menu backdrop.
fn menu_camera(track: &TrackSpline, t: f32) -> Camera3D {
    let f = track.start_frame();
    let focus = f.position + Vec3::Y * 1.5;
    let a = t * 0.2;
    let r = 18.0;
    let eye = focus + vec3(a.cos() * r, 7.0, a.sin() * r);
    Camera3D { position: eye, target: focus, up: Vec3::Y, fovy: BASE_FOV, ..Default::default() }
}

fn draw_menu(game: &Game, t: f32) {
    let w = screen_width();
    let h = screen_height();

    let title = "WII KART";
    let s = 16.0;
    let tw = pixel_text_width(title, s);
    draw_pixel_text(title, (w - tw) * 0.5 + 4.0, 124.0, s, Color::new(0.0, 0.0, 0.0, 0.5));
    draw_pixel_text(title, (w - tw) * 0.5, 120.0, s, Color::new(1.0, 0.85, 0.20, 1.0));

    let sub = "COMBAT GRAND PRIX";
    let ss = 6.0;
    let sw = pixel_text_width(sub, ss);
    draw_pixel_text(sub, (w - sw) * 0.5, 212.0, ss, ORANGE_SPARK);

    // Two-item menu (M11): START / SETTINGS. The highlighted item pulses gold with
    // a caret; the other is dimmed. `menu_cursor` is the flow's selection.
    let items = ["START", "SETTINGS"];
    let ms = 6.0;
    let pulse = 0.55 + 0.45 * (t * 3.0).sin();
    let mut y = h * 0.55;
    for (i, label) in items.iter().enumerate() {
        let selected = i == game.menu_cursor;
        let color = if selected {
            Color::new(1.0, 0.9, 0.35, pulse)
        } else {
            Color::new(1.0, 1.0, 1.0, 0.5)
        };
        let lw = pixel_text_width(label, ms);
        if selected {
            draw_pixel_text(">", (w - lw) * 0.5 - 42.0, y, ms, color);
        }
        draw_pixel_text(label, (w - lw) * 0.5, y, ms, color);
        y += 64.0;
    }

    let hint = "UP / DOWN  SELECT      ENTER  CONFIRM      ESC  QUIT";
    let qs = 3.0;
    let qw = pixel_text_width(hint, qs);
    draw_pixel_text(hint, (w - qw) * 0.5, h - 60.0, qs, Color::new(1.0, 1.0, 1.0, 0.7));
}

/// The Settings screen (M11): a titled panel of adjustable rows over the menu
/// backdrop. Up/Down move the row cursor; Left/Right change the highlighted value.
/// Everything it edits lives in `game.settings` and persists for the session.
fn draw_settings(game: &Game) {
    let w = screen_width();
    let h = screen_height();
    draw_rectangle(0.0, 0.0, w, h, Color::new(0.0, 0.0, 0.0, 0.45));

    let title = "SETTINGS";
    let ts = 9.0;
    let tw = pixel_text_width(title, ts);
    draw_pixel_text(title, (w - tw) * 0.5, 60.0, ts, WHITE);

    let s = &game.settings;
    let panel_w = 560.0;
    let x = (w - panel_w) * 0.5;
    let row_h = 62.0;
    let top = 172.0;
    let lab_s = 4.0;
    let val_s = 4.0;
    let bar_x = x + panel_w - 260.0;
    let bar_w = 210.0;
    let labels = ["VOLUME", "RACERS", "LAPS", "TRACK", "FOV"];

    for row in 0..SETTINGS_ROWS {
        let y = top + row as f32 * row_h;
        let selected = row == game.settings_cursor;
        if selected {
            draw_rectangle(x - 18.0, y - 16.0, panel_w + 36.0, 44.0, Color::new(1.0, 1.0, 1.0, 0.10));
            draw_pixel_text("<", bar_x - 34.0, y, val_s, Color::new(1.0, 0.9, 0.35, 1.0));
            draw_pixel_text(">", bar_x + bar_w + 60.0, y, val_s, Color::new(1.0, 0.9, 0.35, 1.0));
        }
        let lab_c = if selected {
            Color::new(1.0, 0.9, 0.35, 1.0)
        } else {
            Color::new(0.85, 0.85, 0.9, 1.0)
        };
        draw_pixel_text(labels[row], x, y, lab_s, lab_c);

        match row {
            0 => {
                draw_setting_bar(bar_x, y, bar_w, s.master_volume, Color::new(0.2, 0.9, 0.4, 0.9));
                draw_uint((s.master_volume * 100.0).round() as u32, bar_x + bar_w + 90.0, y, val_s, WHITE);
            }
            1 => {
                draw_uint(s.active_karts as u32, bar_x, y, val_s, WHITE);
                draw_pixel_text("/", bar_x + 60.0, y, val_s, Color::new(0.7, 0.7, 0.75, 1.0));
                draw_uint(NUM_KARTS as u32, bar_x + 96.0, y, val_s, Color::new(0.7, 0.7, 0.75, 1.0));
            }
            2 => draw_uint(s.lap_count as u32, bar_x, y, val_s, WHITE),
            3 => draw_pixel_text(TRACK_NAMES[s.default_track], bar_x, y, val_s, Color::new(0.30, 0.90, 1.00, 1.0)),
            _ => {
                let frac = (s.fov - FOV_MIN) / (FOV_MAX - FOV_MIN);
                draw_setting_bar(bar_x, y, bar_w, frac, Color::new(0.9, 0.6, 0.2, 0.9));
                let deg = (s.fov * 180.0 / std::f32::consts::PI).round() as u32;
                draw_uint(deg, bar_x + bar_w + 90.0, y, val_s, WHITE);
            }
        }
    }

    let hint = "UP / DOWN  ROW      LEFT / RIGHT  ADJUST      ESC  BACK";
    let hs = 3.0;
    let hw = pixel_text_width(hint, hs);
    draw_pixel_text(hint, (w - hw) * 0.5, h - 48.0, hs, Color::new(1.0, 1.0, 1.0, 0.85));
}

/// A settings-row value bar: dark track + a colored fill for `frac` in [0, 1].
fn draw_setting_bar(x: f32, y: f32, w: f32, frac: f32, fill: Color) {
    draw_rectangle(x, y - 4.0, w, 18.0, Color::new(0.0, 0.0, 0.0, 0.5));
    draw_rectangle(x, y - 4.0, w * frac.clamp(0.0, 1.0), 18.0, fill);
}

/// The 3D half of class-select: a spinning preview of the highlighted chassis,
/// wearing its class cannon, on a dark stage.
fn draw_class_preview(game: &Game, shaders: &Shaders, t: f32) {
    let cam = Camera3D {
        position: vec3(0.0, 2.4, 6.2),
        target: vec3(0.0, 0.7, 0.0),
        up: Vec3::Y,
        fovy: BASE_FOV,
        ..Default::default()
    };
    set_camera(&cam);
    shaders.set_camera(cam.position);

    draw_plane(vec3(0.0, 0.0, 0.0), vec2(7.0, 7.0), None, Color::new(0.10, 0.11, 0.15, 1.0));

    shaders.use_toon();
    // Minimal pose: just enough for the wheels to roll as it turns.
    let pose = RenderPose {
        position: Vec3::ZERO,
        forward: Vec3::Z,
        up: Vec3::Y,
        drift_yaw: 0.0,
        trick_spin: 0.0,
        wheel_spin: t * 2.0,
        steer_vis: 0.0,
    };
    let model = Mat4::from_rotation_y(t * 0.8);
    draw_mesh_transformed(&game.preview_meshes[game.class_cursor], model);
    draw_wheels(&game.wheel_mesh, model, &pose);
    gl_use_default_material();
}

/// The 2D half of class-select: one stat card per chassis with comparative bars.
fn draw_class_select(game: &Game) {
    let w = screen_width();
    let h = screen_height();
    draw_rectangle(0.0, 0.0, w, h, Color::new(0.0, 0.0, 0.0, 0.35));

    let title = "SELECT CHASSIS";
    let ts = 8.0;
    let tw = pixel_text_width(title, ts);
    draw_pixel_text(title, (w - tw) * 0.5, 48.0, ts, WHITE);

    // Comparative maxima, so each bar reads relative to the strongest class.
    let mut max_mass = 0.0_f32;
    let mut max_rate = 0.0_f32;
    let mut max_ammo = 0.0_f32;
    let mut max_blast = 0.0_f32;
    for c in CLASS_ORDER {
        let s = c.spec();
        max_mass = max_mass.max(s.mass);
        max_rate = max_rate.max(1.0 / s.reload);
        max_ammo = max_ammo.max(s.max_ammo as f32);
        max_blast = max_blast.max(s.blast);
    }

    let n = CLASS_ORDER.len();
    let card_w = 250.0;
    let gap = 24.0;
    let total = n as f32 * card_w + (n as f32 - 1.0) * gap;
    let x0 = (w - total) * 0.5;
    let top = 132.0;
    let card_h = 372.0;

    for (i, &c) in CLASS_ORDER.iter().enumerate() {
        let x = x0 + i as f32 * (card_w + gap);
        let selected = i == game.class_cursor;
        let color = c.color();

        let bg = if selected {
            Color::new(0.16, 0.17, 0.22, 0.95)
        } else {
            Color::new(0.08, 0.08, 0.11, 0.85)
        };
        draw_rectangle(x, top, card_w, card_h, bg);
        if selected {
            draw_rectangle_lines(x, top, card_w, card_h, 6.0, color);
        }

        draw_pixel_text(c.name(), x + 18.0, top + 24.0, 5.0, color);
        draw_pixel_text(c.spec().kind.name(), x + 18.0, top + 72.0, 3.0, Color::new(0.85, 0.85, 0.9, 1.0));

        let s = c.spec();
        let bars = [
            ("WEIGHT", s.mass / max_mass),
            ("FIRE", (1.0 / s.reload) / max_rate),
            ("AMMO", s.max_ammo as f32 / max_ammo),
            ("BLAST", if max_blast > 0.0 { s.blast / max_blast } else { 0.0 }),
        ];
        let bar_x = x + 18.0;
        let bar_w = card_w - 36.0;
        let mut by = top + 124.0;
        for (label, frac) in bars {
            draw_pixel_text(label, bar_x, by, 2.5, Color::new(0.75, 0.75, 0.8, 1.0));
            let track_y = by + 22.0;
            draw_rectangle(bar_x, track_y, bar_w, 14.0, Color::new(0.0, 0.0, 0.0, 0.5));
            draw_rectangle(bar_x, track_y, bar_w * frac.clamp(0.0, 1.0), 14.0, color);
            by += 54.0;
        }
    }

    let hint = "LEFT / RIGHT  SELECT      ENTER  CONFIRM      ESC  BACK";
    let hs = 3.0;
    let hw = pixel_text_width(hint, hs);
    draw_pixel_text(hint, (w - hw) * 0.5, h - 48.0, hs, Color::new(1.0, 1.0, 1.0, 0.85));
}

/// The 3D half of track-select: a slow overhead orbit of the highlighted circuit
/// (road + its boost pads + accel strips), so the player can read the layout at a
/// glance. The ramps (M14) are part of the road mesh itself, so they show too.
fn draw_track_preview(
    spline: &TrackSpline,
    meshes: &[Mesh],
    pad_mesh: &Mesh,
    accel_mesh: &Mesh,
    shaders: &Shaders,
    t: f32,
) {
    let a = t * 0.22;
    let r = 165.0;
    let eye = vec3(a.cos() * r, 135.0, a.sin() * r);
    let cam = Camera3D { position: eye, target: Vec3::ZERO, up: Vec3::Y, fovy: BASE_FOV, ..Default::default() };
    set_camera(&cam);
    shaders.set_camera(eye);

    draw_plane(vec3(0.0, -1.5, 0.0), vec2(600.0, 600.0), None, GRASS);

    shaders.use_road();
    for m in meshes {
        draw_mesh(m);
    }
    gl_use_default_material();

    shaders.use_crate();
    for pad in spline.boost_pads() {
        draw_mesh_transformed(pad_mesh, pad_model_matrix(&pad.frame));
    }
    for strip in spline.accel_strips() {
        draw_mesh_transformed(accel_mesh, pad_model_matrix(&strip.frame));
    }
    gl_use_default_material();
}

/// The 2D half of track-select: the circuit's name and headline stats.
fn draw_track_select(cursor: usize, spline: &TrackSpline) {
    let w = screen_width();
    let h = screen_height();
    draw_rectangle(0.0, 0.0, w, h, Color::new(0.0, 0.0, 0.0, 0.30));

    let title = "SELECT TRACK";
    let ts = 8.0;
    let tw = pixel_text_width(title, ts);
    draw_pixel_text(title, (w - tw) * 0.5, 48.0, ts, WHITE);

    // Circuit name, big and centered.
    let name = TRACK_NAMES[cursor];
    let ns = 12.0;
    let nw = pixel_text_width(name, ns);
    draw_pixel_text(name, (w - nw) * 0.5 + 4.0, 124.0, ns, Color::new(0.0, 0.0, 0.0, 0.5));
    draw_pixel_text(name, (w - nw) * 0.5, 120.0, ns, Color::new(0.30, 0.90, 1.00, 1.0));

    // Headline stats: length (m) + boost-pad count.
    let len_m = spline.total_length() as u32;
    let pads = spline.boost_pads().len() as u32;
    let ss = 4.0;
    draw_pixel_text("LENGTH", w * 0.5 - 220.0, h - 180.0, ss, Color::new(0.8, 0.8, 0.85, 1.0));
    draw_uint(len_m, w * 0.5 - 70.0, h - 180.0, ss, WHITE);
    draw_pixel_text("M", w * 0.5 + 70.0, h - 180.0, ss, Color::new(0.8, 0.8, 0.85, 1.0));
    draw_pixel_text("PADS", w * 0.5 - 220.0, h - 130.0, ss, Color::new(0.8, 0.8, 0.85, 1.0));
    draw_uint(pads, w * 0.5 - 70.0, h - 130.0, ss, ORANGE_SPARK);

    let hint = "LEFT / RIGHT  SELECT      ENTER  RACE      ESC  BACK";
    let hs = 3.0;
    let hw = pixel_text_width(hint, hs);
    draw_pixel_text(hint, (w - hw) * 0.5, h - 48.0, hs, Color::new(1.0, 1.0, 1.0, 0.85));
}

fn draw_pause_overlay() {
    let w = screen_width();
    let h = screen_height();
    draw_rectangle(0.0, 0.0, w, h, Color::new(0.0, 0.0, 0.0, 0.55));

    let title = "PAUSED";
    let s = 12.0;
    let tw = pixel_text_width(title, s);
    draw_pixel_text(title, (w - tw) * 0.5 + 4.0, 184.0, s, Color::new(0.0, 0.0, 0.0, 0.5));
    draw_pixel_text(title, (w - tw) * 0.5, 180.0, s, WHITE);

    let lines = ["ESC   RESUME", "ENTER   QUIT TO MENU", "R   RESTART RACE"];
    let ls = 4.0;
    let mut y = h * 0.5;
    for line in lines {
        let lw = pixel_text_width(line, ls);
        draw_pixel_text(line, (w - lw) * 0.5, y, ls, Color::new(1.0, 1.0, 1.0, 0.9));
        y += 48.0;
    }
}

// ----------------------------------------------------------------------------
// HUD
// ----------------------------------------------------------------------------

fn draw_hud(player: &KartState, elapsed: f32) {
    // Speed readout (km/h-ish for flavor).
    let speed = (player.speed.abs() * 3.6) as u32;
    draw_pixel_text("SPEED", 24.0, 24.0, 4.0, WHITE);
    draw_uint(speed, 24.0, 64.0, 7.0, WHITE);

    // Speed bar.
    let ratio = (player.speed_ratio() / 1.0).clamp(0.0, 1.0);
    draw_rectangle(24.0, 120.0, 240.0, 16.0, Color::new(0.0, 0.0, 0.0, 0.4));
    draw_rectangle(24.0, 120.0, 240.0 * ratio, 16.0, Color::new(0.2, 0.9, 0.4, 0.9));

    // Drift-charge spark indicator (bottom-left).
    match player.spark_stage() {
        SparkStage::Blue => draw_boost_spark(70.0, screen_height() - 70.0, 24.0, BLUE_SPARK),
        SparkStage::Orange => draw_boost_spark(70.0, screen_height() - 70.0, 30.0, ORANGE_SPARK),
        SparkStage::None => {}
    }

    // Boost banner.
    if player.is_boosting() {
        let s = 8.0;
        let label = "BOOST!";
        let w = mesh_gen::pixel_text_width(label, s);
        draw_pixel_text(label, (screen_width() - w) * 0.5, 40.0, s, ORANGE_SPARK);
    }

    // Controls hint for the first few seconds.
    if elapsed < 7.0 {
        let a = (1.0 - elapsed / 7.0).clamp(0.0, 1.0);
        let c = Color::new(1.0, 1.0, 1.0, a);
        draw_pixel_text("WASD / ARROWS  DRIVE", 24.0, screen_height() - 140.0, 3.0, c);
        draw_pixel_text("SPACE / R-CLICK  DRIFT / TRICK", 24.0, screen_height() - 110.0, 3.0, c);
        draw_pixel_text("CTRL / F  FIRE CANNON", 24.0, screen_height() - 80.0, 3.0, c);
        draw_pixel_text("E / ALT  USE ITEM", 24.0, screen_height() - 50.0, 3.0, c);
    }
}

/// The player's cannon readout: chassis class + ammo magazine (bottom-right).
fn draw_combat_hud(combat: &Combat, t: f32) {
    let kc = &combat.karts[0];
    let class = kc.class;
    let max = class.spec().max_ammo;
    let color = class.color();

    let panel_w = 220.0;
    let x = screen_width() - panel_w - 24.0;
    let y = screen_height() - 96.0;

    // Item slot (M13): the held item, floating above the class/ammo panel.
    if kc.held != ItemKind::None {
        let iy = y - 42.0;
        draw_rectangle(x, iy, panel_w, 34.0, Color::new(0.0, 0.0, 0.0, 0.40));
        draw_pixel_text("ITEM", x + 12.0, iy + 8.0, 2.5, Color::new(0.80, 0.80, 0.85, 1.0));
        draw_pixel_text(kc.held.name(), x + 56.0, iy + 6.0, 3.0, kc.held.color());
    }

    draw_rectangle(x, y, panel_w, 72.0, Color::new(0.0, 0.0, 0.0, 0.40));

    draw_pixel_text(class.name(), x + 12.0, y + 12.0, 3.0, color);

    // Ammo as a row of pips, dimmed once spent.
    let pips = max.min(16) as usize;
    let pip_w = (panel_w - 24.0) / pips as f32;
    for i in 0..pips {
        let lit = (i as u8) < kc.ammo;
        let c = if lit { color } else { Color::new(0.3, 0.3, 0.33, 0.6) };
        draw_rectangle(x + 12.0 + i as f32 * pip_w, y + 44.0, pip_w - 3.0, 14.0, c);
    }

    if kc.star_time > 0.0 {
        // A pulsing banner while invincible (M13).
        let label = "STAR!";
        let s = 6.0 + 0.8 * (t * 14.0).sin();
        let w = pixel_text_width(label, s);
        draw_pixel_text(label, (screen_width() - w) * 0.5, 170.0, s, ItemKind::Star.color());
    }

    if kc.stunned() {
        // A quick scale pulse so the spin-out really punches (M9).
        let label = "SPUN OUT!";
        let s = 5.5 + 0.9 * (t * 16.0).sin();
        let w = pixel_text_width(label, s);
        draw_pixel_text(label, (screen_width() - w) * 0.5, 200.0, s, ORANGE_SPARK);
    }
}

/// Draw the HUD radar (M10): a translucent panel, the circuit outline, and a dot
/// per kart — AI muted gold, the player a bright ringed green so it reads at a
/// glance. Top-right corner; purely render-side (reads live positions).
fn draw_minimap(mm: &Minimap, karts: &[KartState]) {
    let size = MINIMAP_SIZE;
    let ox = screen_width() - size - 24.0;
    let oy = 24.0;

    draw_rectangle(ox, oy, size, size, Color::new(0.0, 0.0, 0.0, 0.35));
    draw_rectangle_lines(ox, oy, size, size, 3.0, Color::new(1.0, 1.0, 1.0, 0.25));

    // Circuit outline: a closed loop of dim segments.
    let outline = Color::new(0.90, 0.90, 1.00, 0.55);
    let pts = &mm.loop_xz;
    for i in 0..pts.len() {
        let a = mm.project(pts[i], ox, oy, size);
        let b = mm.project(pts[(i + 1) % pts.len()], ox, oy, size);
        draw_line(a.x, a.y, b.x, b.y, 2.0, outline);
    }

    // AI dots first so the player marker always sits on top.
    for k in karts.iter().skip(1) {
        let p = mm.project(vec2(k.position.x, k.position.z), ox, oy, size);
        draw_circle(p.x, p.y, 3.5, Color::new(0.85, 0.75, 0.35, 0.9));
    }
    let p0 = mm.project(vec2(karts[0].position.x, karts[0].position.z), ox, oy, size);
    draw_circle(p0.x, p0.y, 6.0, Color::new(0.35, 1.00, 0.55, 1.0));
    draw_circle_lines(p0.x, p0.y, 6.0, 2.0, Color::new(1.0, 1.0, 1.0, 0.9));
}

/// Flash a place-change arrow beside the POS readout: green ▲ on a gain, red ▼ on a
/// loss, fading over its lifetime (M9, render-side only).
fn draw_place_arrow(dir: i8, flash: f32) {
    if dir == 0 || flash <= 0.0 {
        return;
    }
    let a = (flash / PLACE_FLASH_SECS).clamp(0.0, 1.0);
    let cx = screen_width() * 0.5 + 96.0; // just right of the POS line
    let cy = 74.0;
    let h = 14.0;
    if dir > 0 {
        let c = Color::new(0.30, 1.00, 0.45, a); // gained places
        draw_triangle(vec2(cx, cy - h), vec2(cx - h, cy + h), vec2(cx + h, cy + h), c);
    } else {
        let c = Color::new(1.00, 0.35, 0.30, a); // lost places
        draw_triangle(vec2(cx, cy + h), vec2(cx - h, cy - h), vec2(cx + h, cy - h), c);
    }
}

/// Draw an unsigned integer with the pixel font — no heap allocation.
fn draw_uint(mut v: u32, x: f32, y: f32, scale: f32, color: Color) {
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    if v == 0 {
        i -= 1;
        buf[i] = b'0';
    }
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    let s = core::str::from_utf8(&buf[i..]).unwrap();
    draw_pixel_text(s, x, y, scale, color);
}

// ----------------------------------------------------------------------------
// Race HUD (countdown, lap / position, finish board)
// ----------------------------------------------------------------------------

fn draw_race_hud(race: &RaceDirector, t: f32) {
    let w = screen_width();

    // Big centered banner: "3 / 2 / 1" during the countdown, "GO!" on release.
    let banner = if race.show_go_flash() {
        Some(("GO!", Color::new(0.30, 1.00, 0.45, 1.0)))
    } else {
        let label = race.countdown_label();
        (!label.is_empty()).then_some((label, ORANGE_SPARK))
    };
    if let Some((label, color)) = banner {
        let s = 18.0;
        let tw = pixel_text_width(label, s);
        // Drop shadow then the glyphs, so it reads over the bright track.
        draw_pixel_text(label, (w - tw) * 0.5 + 4.0, 124.0, s, Color::new(0.0, 0.0, 0.0, 0.5));
        draw_pixel_text(label, (w - tw) * 0.5, 120.0, s, color);
    }

    // Lap + live position, top-center, once the lights are out.
    if race.phase != Phase::Countdown {
        let cx = w * 0.5;
        draw_pixel_text("LAP", cx - 96.0, 24.0, 4.0, WHITE);
        draw_uint(race.display_lap(0) as u32, cx - 12.0, 24.0, 4.0, WHITE);
        draw_pixel_text("/", cx + 16.0, 24.0, 4.0, WHITE);
        draw_uint(race.laps as u32, cx + 40.0, 24.0, 4.0, WHITE);

        draw_pixel_text("POS", cx - 96.0, 66.0, 4.0, ORANGE_SPARK);
        draw_uint(race.player_position() as u32, cx - 12.0, 66.0, 4.0, ORANGE_SPARK);
        draw_pixel_text("/", cx + 16.0, 66.0, 4.0, ORANGE_SPARK);
        draw_uint(race.progress.len() as u32, cx + 40.0, 66.0, 4.0, ORANGE_SPARK);
    }

    // Final-lap flash (M9): a pulsing banner once the player starts the last lap.
    if race.phase == Phase::Racing && race.display_lap(0) == race.laps {
        let a = 0.55 + 0.45 * (t * 6.0).sin();
        let label = "FINAL LAP";
        let s = 6.0;
        let lw = pixel_text_width(label, s);
        draw_pixel_text(label, (w - lw) * 0.5, 96.0, s, Color::new(1.0, 0.85, 0.20, a));
    }

    if race.phase == Phase::Finished {
        draw_standings_board(race);
    }
}

fn draw_standings_board(race: &RaceDirector) {
    let (w, h) = (screen_width(), screen_height());
    draw_rectangle(0.0, 0.0, w, h, Color::new(0.0, 0.0, 0.0, 0.55));

    let title = "FINISH";
    let ts = 11.0;
    let tw = pixel_text_width(title, ts);
    draw_pixel_text(title, (w - tw) * 0.5, 70.0, ts, ORANGE_SPARK);

    let mut order = [0u8; NUM_KARTS];
    race.standings_into(&mut order);
    // Only the karts that actually raced fill valid slots (M11 field size).
    let field = race.progress.len();

    let row_h = 46.0;
    let top = 180.0;
    let s = 5.0;
    for (place, &ki) in order.iter().take(field).enumerate() {
        let y = top + place as f32 * row_h;
        let is_player = ki == 0;
        let color = if is_player {
            Color::new(0.35, 1.00, 0.55, 1.0)
        } else {
            Color::new(0.85, 0.85, 0.90, 1.0)
        };
        if is_player {
            draw_rectangle(w * 0.5 - 200.0, y - 8.0, 400.0, 38.0, Color::new(1.0, 1.0, 1.0, 0.08));
        }
        draw_uint((place + 1) as u32, w * 0.5 - 180.0, y, s, color);
        draw_pixel_text(if is_player { "YOU" } else { "CPU" }, w * 0.5 - 90.0, y, s, color);
    }

    let hint = "ENTER  MENU      R  REPLAY";
    let hs = 3.0;
    let hw = pixel_text_width(hint, hs);
    draw_pixel_text(hint, (w - hw) * 0.5, h - 60.0, hs, Color::new(1.0, 1.0, 1.0, 0.8));
}

// ----------------------------------------------------------------------------
// Speed lines ("speed juice")
// ----------------------------------------------------------------------------

fn draw_speed_lines(intensity: f32, t: f32) {
    if intensity <= 0.01 {
        return;
    }
    let (w, h) = (screen_width(), screen_height());
    let (cx, cy) = (w * 0.5, h * 0.5);
    let count = 44;
    for i in 0..count {
        let ang = (i as f32 / count as f32) * std::f32::consts::TAU + t * 1.5;
        let (dx, dy) = (ang.cos(), ang.sin());
        let outer_x = cx + dx * w;
        let outer_y = cy + dy * h;
        let inner = 0.32 + 0.05 * (i as f32 * 1.7 + t * 12.0).sin();
        let inner_x = cx + dx * w * inner;
        let inner_y = cy + dy * h * inner;
        let flicker = 0.4 + 0.6 * ((i as f32 * 1.3 + t * 14.0).sin() * 0.5 + 0.5);
        let a = intensity * flicker * 0.5;
        draw_line(inner_x, inner_y, outer_x, outer_y, 2.0, Color::new(1.0, 1.0, 1.0, a));
    }
}
