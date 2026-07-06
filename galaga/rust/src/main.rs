// main.rs — window, fixed-timestep loop, input and the performance HUD.
// 1:1 port of galaga/cpp/src/main.cpp.
mod entities;
mod paths;
mod sprites;
mod game;

use raylib::prelude::*;
use entities::*;
use game::{Game, Input};

fn read_input(rl: &RaylibHandle) -> Input {
    Input {
        left: rl.is_key_down(KeyboardKey::KEY_LEFT) || rl.is_key_down(KeyboardKey::KEY_A),
        right: rl.is_key_down(KeyboardKey::KEY_RIGHT) || rl.is_key_down(KeyboardKey::KEY_D),
        fire_pressed: rl.is_key_pressed(KeyboardKey::KEY_SPACE) || rl.is_key_pressed(KeyboardKey::KEY_LEFT_CONTROL),
        start_pressed: rl.is_key_pressed(KeyboardKey::KEY_ENTER) || rl.is_key_pressed(KeyboardKey::KEY_KP_ENTER),
    }
}

fn main() {
    let (mut rl, thread) = raylib::init()
        .size(SCREEN_W, SCREEN_H)
        .title("Galaga - Rust / raylib")
        .build();
    rl.set_target_fps(60);
    rl.set_exit_key(Some(KeyboardKey::KEY_ESCAPE));

    let mut uncapped = false;
    let mut show_hud = true;
    let mut game = Game::new();
    game.init();
    let mut acc = 0.0f32;

    while !rl.window_should_close() {
        if rl.is_key_pressed(KeyboardKey::KEY_V) {
            uncapped = !uncapped;
            rl.set_target_fps(if uncapped { 0 } else { 60 });
        }
        if rl.is_key_pressed(KeyboardKey::KEY_H) { show_hud = !show_hud; }

        // ---- fixed-timestep update, decoupled from render rate ----
        let mut ft = rl.get_frame_time();
        if ft > 0.25 { ft = 0.25; }
        acc += ft;
        let input = read_input(&rl);
        let mut first = true;
        while acc >= DT {
            let mut step = input;
            if !first { step.fire_pressed = false; step.start_pressed = false; }
            game.update(&step);
            acc -= DT;
            first = false;
        }

        let fps = rl.get_fps();
        let frame_ms = rl.get_frame_time() * 1000.0;
        let ent = game.entity_count();

        // ---- render ----
        let mut d = rl.begin_drawing(&thread);
        d.clear_background(Color::BLACK);
        game.draw(&mut d);

        if show_hud {
            d.draw_rectangle(0, 0, 150, 78, Color::new(0, 0, 0, 140));
            d.draw_text(&format!("FPS   {}", fps), 8, 4, 18, Color::GREEN);
            d.draw_text(&format!("ms    {:.2}", frame_ms), 8, 24, 18, Color::GREEN);
            d.draw_text(&format!("ent   {}", ent), 8, 44, 18, Color::GREEN);
            d.draw_text(if uncapped { "UNCAPPED" } else { "VSYNC 60" }, 8, 60, 16,
                        if uncapped { Color::ORANGE } else { Color::GRAY });
        }
    }
}
