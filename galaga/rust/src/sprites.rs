// sprites.rs — procedural immediate-mode sprite drawing (no asset files).
// 1:1 port of galaga/cpp/src/sprites.hpp.
use raylib::prelude::*;
use crate::entities::*;

pub fn draw_ship(d: &mut RaylibDrawHandle, c: Vector2, tint: Color) {
    let w = PLAYER_W;
    let h = PLAYER_H;
    d.draw_triangle(
        Vector2::new(c.x, c.y - h * 0.5),
        Vector2::new(c.x - w * 0.5, c.y + h * 0.5),
        Vector2::new(c.x + w * 0.5, c.y + h * 0.5),
        tint,
    );
    d.draw_rectangle((c.x - w * 0.5) as i32, (c.y + h * 0.2) as i32, w as i32, 5, tint);
    d.draw_rectangle((c.x - 3.0) as i32, (c.y - 4.0) as i32, 6, 12, Color::RED);
}

pub fn draw_bug(d: &mut RaylibDrawHandle, c: Vector2, etype: EnemyType) {
    let (body, wing, mut w, mut h) = match etype {
        EnemyType::Bee => (Color::YELLOW, Color::SKYBLUE, ENEMY_W, ENEMY_H),
        EnemyType::Butterfly => (Color::RED, Color::YELLOW, ENEMY_W, ENEMY_H),
        EnemyType::Boss => (Color::GREEN, Color::BLUE, ENEMY_W, ENEMY_H),
    };
    if etype == EnemyType::Boss { w += 4.0; h += 4.0; }

    d.draw_triangle(
        Vector2::new(c.x, c.y - h * 0.1),
        Vector2::new(c.x - w * 0.6, c.y - h * 0.4),
        Vector2::new(c.x - w * 0.45, c.y + h * 0.45),
        wing,
    );
    d.draw_triangle(
        Vector2::new(c.x, c.y - h * 0.1),
        Vector2::new(c.x + w * 0.45, c.y + h * 0.45),
        Vector2::new(c.x + w * 0.6, c.y - h * 0.4),
        wing,
    );
    d.draw_rectangle((c.x - w * 0.2) as i32, (c.y - h * 0.4) as i32, (w * 0.4) as i32, (h * 0.8) as i32, body);
    d.draw_rectangle((c.x - w * 0.18) as i32, (c.y - h * 0.15) as i32, 4, 4, Color::WHITE);
    d.draw_rectangle((c.x + w * 0.18 - 4.0) as i32, (c.y - h * 0.15) as i32, 4, 4, Color::WHITE);
    d.draw_line_ex(Vector2::new(c.x - 4.0, c.y - h * 0.4), Vector2::new(c.x - 9.0, c.y - h * 0.7), 2.0, wing);
    d.draw_line_ex(Vector2::new(c.x + 4.0, c.y - h * 0.4), Vector2::new(c.x + 9.0, c.y - h * 0.7), 2.0, wing);
}

pub fn draw_bullet(d: &mut RaylibDrawHandle, p: Vector2) {
    d.draw_rectangle((p.x - BULLET_W * 0.5) as i32, (p.y - BULLET_H * 0.5) as i32,
                     BULLET_W as i32, BULLET_H as i32, Color::RAYWHITE);
}

pub fn draw_bomb(d: &mut RaylibDrawHandle, p: Vector2) {
    d.draw_circle(p.x as i32, p.y as i32, BOMB_W * 0.6, Color::ORANGE);
    d.draw_circle_lines(p.x as i32, p.y as i32, BOMB_W * 0.9, Color::RED);
}

pub fn draw_star(d: &mut RaylibDrawHandle, s: &Star) {
    let b = (120.0 + s.bright * 135.0) as u8;
    let bb = if b > 230 { 255 } else { b };
    d.draw_pixel(s.pos.x as i32, s.pos.y as i32, Color::new(b, b, bb, 255));
}

pub fn draw_beam(d: &mut RaylibDrawHandle, boss: Vector2, alpha: f32) {
    let col = Color::new(0, 200, 255, (120.0 * alpha) as u8);
    let top_w = ENEMY_W * 0.6;
    let bot_w = BEAM_W;
    let top = boss.y + ENEMY_H * 0.3;
    let bot = FH;
    d.draw_triangle(
        Vector2::new(boss.x - top_w * 0.5, top),
        Vector2::new(boss.x - bot_w * 0.5, bot),
        Vector2::new(boss.x + bot_w * 0.5, bot),
        col,
    );
    d.draw_triangle(
        Vector2::new(boss.x - top_w * 0.5, top),
        Vector2::new(boss.x + bot_w * 0.5, bot),
        Vector2::new(boss.x + top_w * 0.5, top),
        col,
    );
}
