// game.rs — gameplay logic, flow machine and rendering.
// 1:1 port of galaga/cpp/src/game.{hpp,cpp}. Loops are index-based so the
// borrow checker is happy while mutating self mid-iteration.
use raylib::prelude::*;
use crate::entities::*;
use crate::paths::*;
use crate::sprites::*;

#[derive(Clone, Copy, Default)]
pub struct Input {
    pub left: bool,
    pub right: bool,
    pub fire_pressed: bool,
    pub start_pressed: bool,
}

pub struct Game {
    pub rng: Rng,
    pub mode: Mode,
    pub stage: i32,
    pub score: i32,
    pub hi_score: i32,
    pub lives: i32,
    pub challenging: bool,

    pub player: Vector2,
    pub fighters: i32,
    pub player_alive: bool,
    pub fire_cooldown: f32,

    pub bullets: Vec<Bullet>,
    pub bombs: Vec<Bomb>,
    pub enemies: Vec<Enemy>,
    pub stars: Vec<Star>,
    pub freed: FreedShip,

    pub sway_time: f32,
    pub dive_timer: f32,
    pub mode_timer: f32,
    pub ft_hits: i32,
    pub ft_spawned: i32,
    pub extras: i32,
}

impl Game {
    pub fn new() -> Game {
        Game {
            rng: Rng::new(0x1234567),
            mode: Mode::Title,
            stage: 0, score: 0, hi_score: 0, lives: START_LIVES, challenging: false,
            player: Vector2::new(FW * 0.5, PLAYER_Y),
            fighters: 1, player_alive: true, fire_cooldown: 0.0,
            bullets: Vec::new(), bombs: Vec::new(), enemies: Vec::new(), stars: Vec::new(),
            freed: FreedShip { pos: Vector2::new(0.0, 0.0), active: false },
            sway_time: 0.0, dive_timer: 2.0, mode_timer: 0.0,
            ft_hits: 0, ft_spawned: 0, extras: 0,
        }
    }

    // ---------- setup ----------
    pub fn init(&mut self) {
        self.stars.clear();
        for _ in 0..110 {
            let x = self.rng.range(0.0, FW);
            let y = self.rng.range(0.0, FH);
            let sp = self.rng.range(20.0, 90.0);
            let br = self.rng.f();
            self.stars.push(Star { pos: Vector2::new(x, y), speed: sp, bright: br });
        }
        self.mode = Mode::Title;
    }

    fn spawn_formation(&mut self) {
        self.enemies.clear();
        let mut side = 0;
        let mut delay_acc = 0.0;
        for row in 0..FORM_ROWS {
            for col in 0..FORM_COLS {
                if !slot_used(col, row) { continue; }
                let mut e = Enemy::blank();
                e.etype = row_type(row);
                e.col = col; e.row = row;
                e.state = EnemyState::Entering;
                e.path = make_entry_path(side, formation_home(col, row), &mut self.rng);
                e.path_len = compute_cum(&e.path, &mut e.cum);
                e.dist = 0.0; e.delay = delay_acc;
                e.pos = e.path[0];
                e.carrying = false;
                e.fire_timer = self.rng.range(0.5, 1.5);
                self.enemies.push(e);
                delay_acc += 0.11;
                side += 1;
            }
        }
    }

    fn spawn_challenging(&mut self) {
        self.enemies.clear();
        for i in 0..CHALLENGE_TOTAL {
            let mut e = Enemy::blank();
            e.etype = match i % 3 { 0 => EnemyType::Bee, 1 => EnemyType::Butterfly, _ => EnemyType::Boss };
            e.state = EnemyState::FlyThrough;
            e.path = make_fly_through_path(i, &mut self.rng);
            e.path_len = compute_cum(&e.path, &mut e.cum);
            e.dist = 0.0; e.delay = i as f32 * 0.22;
            e.pos = e.path[0];
            e.carrying = false;
            self.enemies.push(e);
        }
        self.ft_hits = 0;
        self.ft_spawned = CHALLENGE_TOTAL;
    }

    pub fn start_stage(&mut self) {
        self.stage += 1;
        self.bullets.clear();
        self.bombs.clear();
        self.freed.active = false;
        self.challenging = self.stage % 4 == 0;
        self.sway_time = 0.0;
        self.dive_timer = (2.0 - self.stage as f32 * 0.1).max(0.6);
        self.player.x = FW * 0.5;
        self.player_alive = true;
        if self.challenging { self.spawn_challenging(); } else { self.spawn_formation(); }
    }

    // ---------- top-level update ----------
    pub fn update(&mut self, input: &Input) {
        self.sway_time += DT;
        for s in &mut self.stars {
            s.pos.y += s.speed * DT;
            if s.pos.y > FH { s.pos.y = 0.0; }
        }
        // re-randomise wrapped stars' x (separate pass to avoid borrowing rng in loop above)
        for i in 0..self.stars.len() {
            if self.stars[i].pos.y == 0.0 { self.stars[i].pos.x = self.rng.range(0.0, FW); }
        }

        match self.mode {
            Mode::Title => {
                if input.start_pressed {
                    self.score = 0; self.lives = START_LIVES; self.fighters = 1;
                    self.stage = 0; self.extras = 0;
                    self.start_stage();
                    self.mode = Mode::Playing;
                }
            }
            Mode::Playing => self.update_playing(input),
            Mode::StageClear => {
                self.mode_timer -= DT;
                if self.mode_timer <= 0.0 { self.start_stage(); self.mode = Mode::Playing; }
            }
            Mode::Dying => {
                self.mode_timer -= DT;
                for b in &mut self.bombs {
                    if b.active { b.pos.y += BOMB_SPEED * DT; if b.pos.y > FH + 20.0 { b.active = false; } }
                }
                if self.mode_timer <= 0.0 {
                    if self.lives <= 0 {
                        self.mode = Mode::GameOver;
                        if self.score > self.hi_score { self.hi_score = self.score; }
                    } else {
                        self.player.x = FW * 0.5; self.player_alive = true; self.fighters = 1;
                        for b in &mut self.bombs { b.active = false; }
                        self.mode = Mode::Playing;
                    }
                }
            }
            Mode::GameOver => {
                if input.start_pressed { self.mode = Mode::Title; }
            }
        }
    }

    fn update_playing(&mut self, input: &Input) {
        if self.player_alive {
            let half = PLAYER_W * 0.5 + if self.fighters == 2 { DUAL_OFFSET } else { 0.0 };
            if input.left { self.player.x -= PLAYER_SPEED * DT; }
            if input.right { self.player.x += PLAYER_SPEED * DT; }
            self.player.x = self.player.x.clamp(half, FW - half);
            self.fire_cooldown -= DT;
            if input.fire_pressed && self.fire_cooldown <= 0.0 { self.fire(); }
        }

        for b in &mut self.bullets {
            if b.active { b.pos.y -= BULLET_SPEED * DT; if b.pos.y < -20.0 { b.active = false; } }
        }
        for b in &mut self.bombs {
            if b.active { b.pos.y += BOMB_SPEED * DT; if b.pos.y > FH + 20.0 { b.active = false; } }
        }

        if self.freed.active {
            self.freed.pos.y += 140.0 * DT;
            self.freed.pos.x += (self.player.x - self.freed.pos.x) * (3.0 * DT).min(1.0);
            if self.freed.pos.y >= PLAYER_Y {
                self.freed.active = false;
                if self.player_alive { self.fighters = 2; }
            }
        }

        self.update_enemies();
        if !self.challenging { self.schedule_dives(); }

        // bullet vs enemy
        for i in 0..self.bullets.len() {
            if !self.bullets[i].active { continue; }
            for j in 0..self.enemies.len() {
                if self.enemies[j].state == EnemyState::Dead { continue; }
                if aabb(self.bullets[i].pos, BULLET_W, BULLET_H, self.enemies[j].pos, ENEMY_W, ENEMY_H) {
                    self.bullets[i].active = false;
                    let st = self.enemies[j].state;
                    let diving = matches!(st, EnemyState::Diving | EnemyState::CaptureDive
                        | EnemyState::CaptureHold | EnemyState::Returning | EnemyState::FlyThrough);
                    self.kill_enemy(j, diving);
                    break;
                }
            }
        }

        // bombs vs player
        if self.player_alive {
            for i in 0..self.bombs.len() {
                if !self.bombs[i].active { continue; }
                for f in 0..self.fighters {
                    let fx = self.player.x + if self.fighters == 2 { if f == 0 { -DUAL_OFFSET } else { DUAL_OFFSET } } else { 0.0 };
                    if aabb(self.bombs[i].pos, BOMB_W, BOMB_H, Vector2::new(fx, self.player.y), PLAYER_W, PLAYER_H) {
                        self.bombs[i].active = false;
                        self.hit_player(false, None);
                        break;
                    }
                }
                if !self.player_alive { break; }
            }
        }

        // diving enemy vs player
        if self.player_alive {
            for j in 0..self.enemies.len() {
                let st = self.enemies[j].state;
                if !matches!(st, EnemyState::Diving | EnemyState::CaptureDive | EnemyState::FlyThrough) { continue; }
                let mut hit = false;
                for f in 0..self.fighters {
                    let fx = self.player.x + if self.fighters == 2 { if f == 0 { -DUAL_OFFSET } else { DUAL_OFFSET } } else { 0.0 };
                    if aabb(self.enemies[j].pos, ENEMY_W, ENEMY_H, Vector2::new(fx, self.player.y), PLAYER_W, PLAYER_H) {
                        hit = true; break;
                    }
                }
                if hit {
                    self.kill_enemy(j, true);
                    self.hit_player(false, None);
                    break;
                }
            }
        }

        if self.mode == Mode::Playing && self.alive_enemies() == 0 {
            self.stage_clear();
        }
    }

    // ---------- enemies ----------
    fn update_enemies(&mut self) {
        let sway = (self.sway_time * SWAY_SPEED).sin() * SWAY_AMP;
        for i in 0..self.enemies.len() {
            match self.enemies[i].state {
                EnemyState::Entering => {
                    if self.enemies[i].delay > 0.0 {
                        self.enemies[i].delay -= DT;
                        self.enemies[i].pos = self.enemies[i].path[0];
                        continue;
                    }
                    self.enemies[i].dist += ENTER_SPEED * DT;
                    let dpos = sample_path(&self.enemies[i].path, &self.enemies[i].cum, self.enemies[i].dist);
                    self.enemies[i].pos = dpos;
                    if self.enemies[i].dist >= self.enemies[i].path_len { self.enemies[i].state = EnemyState::Formation; }
                }
                EnemyState::Formation => {
                    let h = formation_home(self.enemies[i].col, self.enemies[i].row);
                    self.enemies[i].pos = Vector2::new(h.x + sway, h.y);
                }
                EnemyState::Diving => {
                    self.enemies[i].dist += DIVE_SPEED * DT;
                    let dist = self.enemies[i].dist;
                    let pos = sample_path(&self.enemies[i].path, &self.enemies[i].cum, dist);
                    self.enemies[i].pos = pos;
                    self.enemies[i].fire_timer -= DT;
                    if self.enemies[i].fire_timer <= 0.0 && pos.y < FH - 120.0 {
                        self.drop_bomb(pos);
                        self.enemies[i].fire_timer = self.rng.range(0.4, 0.9);
                    }
                    if dist >= self.enemies[i].path_len {
                        let home = formation_home(self.enemies[i].col, self.enemies[i].row);
                        let p = make_return_path(home, &mut self.rng);
                        let len = compute_cum(&p, &mut self.enemies[i].cum);
                        self.enemies[i].path = p;
                        self.enemies[i].path_len = len;
                        self.enemies[i].dist = 0.0;
                        self.enemies[i].state = EnemyState::Returning;
                    }
                }
                EnemyState::CaptureDive => {
                    self.enemies[i].dist += DIVE_SPEED * 0.75 * DT;
                    let dist = self.enemies[i].dist;
                    let pos = sample_path(&self.enemies[i].path, &self.enemies[i].cum, dist);
                    self.enemies[i].pos = pos;
                    if dist >= self.enemies[i].path_len {
                        self.enemies[i].state = EnemyState::CaptureHold;
                        self.enemies[i].hold_timer = BEAM_HOLD;
                    }
                }
                EnemyState::CaptureHold => {
                    self.enemies[i].hold_timer -= DT;
                    let pos = self.enemies[i].pos;
                    if self.player_alive && !self.freed.active && !self.any_carrying()
                        && (self.player.x - pos.x).abs() < BEAM_W * 0.5 && self.player.y > pos.y {
                        self.hit_player(true, Some(i));
                    }
                    if self.enemies[i].hold_timer <= 0.0 && self.enemies[i].state == EnemyState::CaptureHold {
                        let home = formation_home(self.enemies[i].col, self.enemies[i].row);
                        let p = make_return_path(home, &mut self.rng);
                        let len = compute_cum(&p, &mut self.enemies[i].cum);
                        self.enemies[i].path = p;
                        self.enemies[i].path_len = len;
                        self.enemies[i].dist = 0.0;
                        self.enemies[i].state = EnemyState::Returning;
                    }
                }
                EnemyState::Returning => {
                    self.enemies[i].dist += ENTER_SPEED * DT;
                    let dpos = sample_path(&self.enemies[i].path, &self.enemies[i].cum, self.enemies[i].dist);
                    self.enemies[i].pos = dpos;
                    if self.enemies[i].dist >= self.enemies[i].path_len { self.enemies[i].state = EnemyState::Formation; }
                }
                EnemyState::FlyThrough => {
                    if self.enemies[i].delay > 0.0 {
                        self.enemies[i].delay -= DT;
                        self.enemies[i].pos = self.enemies[i].path[0];
                        continue;
                    }
                    self.enemies[i].dist += ENTER_SPEED * DT;
                    let dpos = sample_path(&self.enemies[i].path, &self.enemies[i].cum, self.enemies[i].dist);
                    self.enemies[i].pos = dpos;
                    if self.enemies[i].dist >= self.enemies[i].path_len { self.enemies[i].state = EnemyState::Dead; }
                }
                EnemyState::Dead => {}
            }
        }
    }

    fn schedule_dives(&mut self) {
        self.dive_timer -= DT;
        if self.dive_timer > 0.0 { return; }

        let mut formed: Vec<usize> = Vec::new();
        for i in 0..self.enemies.len() {
            if self.enemies[i].state == EnemyState::Formation { formed.push(i); }
        }
        if formed.is_empty() { self.dive_timer = 0.5; return; }

        let idx = formed[self.rng.irange(0, formed.len() as i32 - 1) as usize];
        let is_boss = self.enemies[idx].etype == EnemyType::Boss;
        let capture = is_boss && !self.any_carrying() && self.fighters == 1
            && self.player_alive && self.rng.f() < 0.5;
        let pos = self.enemies[idx].pos;
        let target = self.player.x;
        if capture {
            let p = make_capture_path(pos, target, &mut self.rng);
            let len = compute_cum(&p, &mut self.enemies[idx].cum);
            self.enemies[idx].path = p;
            self.enemies[idx].path_len = len;
            self.enemies[idx].dist = 0.0;
            self.enemies[idx].state = EnemyState::CaptureDive;
        } else {
            self.enemies[idx].target_x = target;
            let p = make_dive_path(pos, target, &mut self.rng);
            let len = compute_cum(&p, &mut self.enemies[idx].cum);
            self.enemies[idx].path = p;
            self.enemies[idx].path_len = len;
            self.enemies[idx].dist = 0.0;
            self.enemies[idx].fire_timer = self.rng.range(0.3, 0.7);
            self.enemies[idx].state = EnemyState::Diving;
        }
        self.dive_timer = self.rng.range(0.8, 2.0) * (1.0 - self.stage as f32 * 0.05).max(0.4);
    }

    // ---------- combat ----------
    fn fire(&mut self) {
        let active = self.bullets.iter().filter(|b| b.active).count() as i32;
        if active >= MAX_BULLETS_PER_FIGHTER * self.fighters { return; }
        let y = self.player.y - PLAYER_H * 0.5;
        if self.fighters == 2 {
            self.spawn_bullet(self.player.x - DUAL_OFFSET, y);
            self.spawn_bullet(self.player.x + DUAL_OFFSET, y);
        } else {
            self.spawn_bullet(self.player.x, y);
        }
        self.fire_cooldown = 0.18;
    }

    fn spawn_bullet(&mut self, x: f32, y: f32) {
        for b in &mut self.bullets {
            if !b.active { b.pos = Vector2::new(x, y); b.active = true; return; }
        }
        self.bullets.push(Bullet { pos: Vector2::new(x, y), active: true });
    }

    fn drop_bomb(&mut self, from: Vector2) {
        for b in &mut self.bombs {
            if !b.active { b.pos = from; b.active = true; return; }
        }
        self.bombs.push(Bomb { pos: from, active: true });
    }

    fn kill_enemy(&mut self, idx: usize, diving: bool) {
        let pts = match self.enemies[idx].etype {
            EnemyType::Bee => if diving { 100 } else { 50 },
            EnemyType::Butterfly => if diving { 160 } else { 80 },
            EnemyType::Boss => if diving { 400 } else { 150 },
        };
        self.score += pts;
        if self.challenging { self.ft_hits += 1; }
        if self.enemies[idx].carrying {
            self.freed.active = true;
            self.freed.pos = self.enemies[idx].pos;
            self.enemies[idx].carrying = false;
        }
        self.enemies[idx].state = EnemyState::Dead;
        while self.score >= (self.extras + 1) * EXTRA_LIFE_SCORE { self.lives += 1; self.extras += 1; }
        if self.score > self.hi_score { self.hi_score = self.score; }
    }

    fn hit_player(&mut self, captured: bool, captor: Option<usize>) {
        if !self.player_alive { return; }
        self.player_alive = false;
        self.fighters = 1;
        self.lives -= 1;
        if captured {
            if let Some(c) = captor {
                self.enemies[c].carrying = true;
                let home = formation_home(self.enemies[c].col, self.enemies[c].row);
                let p = make_return_path(home, &mut self.rng);
                let len = compute_cum(&p, &mut self.enemies[c].cum);
                self.enemies[c].path = p;
                self.enemies[c].path_len = len;
                self.enemies[c].dist = 0.0;
                self.enemies[c].state = EnemyState::Returning;
            }
        }
        if self.lives <= 0 {
            self.mode = Mode::GameOver;
            if self.score > self.hi_score { self.hi_score = self.score; }
        } else {
            self.mode = Mode::Dying;
            self.mode_timer = 1.4;
        }
    }

    fn stage_clear(&mut self) {
        self.mode = Mode::StageClear;
        self.mode_timer = 2.0;
    }

    fn any_carrying(&self) -> bool {
        self.enemies.iter().any(|e| e.carrying)
    }

    pub fn alive_enemies(&self) -> i32 {
        self.enemies.iter().filter(|e| e.state != EnemyState::Dead).count() as i32
    }

    pub fn entity_count(&self) -> i32 {
        let mut n = self.alive_enemies()
            + if self.freed.active { 1 } else { 0 }
            + if self.player_alive { self.fighters } else { 0 };
        n += self.bullets.iter().filter(|b| b.active).count() as i32;
        n += self.bombs.iter().filter(|b| b.active).count() as i32;
        n
    }

    // ---------- rendering ----------
    pub fn draw(&self, d: &mut RaylibDrawHandle) {
        for s in &self.stars { draw_star(d, s); }

        for e in &self.enemies {
            if e.state == EnemyState::Dead { continue; }
            if e.state == EnemyState::CaptureHold {
                let a = (e.hold_timer / BEAM_HOLD * 1.5).min(1.0);
                draw_beam(d, e.pos, a);
            }
            draw_bug(d, e.pos, e.etype);
            if e.carrying { draw_ship(d, Vector2::new(e.pos.x, e.pos.y + ENEMY_H * 0.8), Color::GREEN); }
        }

        if self.freed.active { draw_ship(d, self.freed.pos, Color::GREEN); }

        if self.player_alive && self.mode == Mode::Playing {
            if self.fighters == 2 {
                draw_ship(d, Vector2::new(self.player.x - DUAL_OFFSET, self.player.y), Color::RAYWHITE);
                draw_ship(d, Vector2::new(self.player.x + DUAL_OFFSET, self.player.y), Color::RAYWHITE);
            } else {
                draw_ship(d, Vector2::new(self.player.x, self.player.y), Color::RAYWHITE);
            }
        }

        for b in &self.bullets { if b.active { draw_bullet(d, b.pos); } }
        for b in &self.bombs { if b.active { draw_bomb(d, b.pos); } }

        d.draw_text(&format!("SCORE {}", self.score), 12, 8, 20, Color::RAYWHITE);
        d.draw_text(&format!("HI {}", self.hi_score), SCREEN_W - 150, 8, 20, Color::RED);
        if self.mode == Mode::Playing {
            for i in 0..(self.lives - 1).max(0) {
                draw_ship(d, Vector2::new(28.0 + i as f32 * 30.0, FH - 20.0), Color::SKYBLUE);
            }
        }
        if self.mode == Mode::Playing || self.mode == Mode::Dying {
            d.draw_text(&format!("STAGE {}", self.stage), SCREEN_W - 110, SCREEN_H - 28, 18, Color::YELLOW);
        }

        match self.mode {
            Mode::Title => {
                draw_center(d, "GALAGA", 200, 64, Color::YELLOW);
                draw_center(d, "Rust  /  raylib", 280, 28, Color::SKYBLUE);
                draw_center(d, "PRESS  ENTER  TO  START", 420, 24, Color::RAYWHITE);
                draw_center(d, "ARROWS / A,D  MOVE     SPACE  FIRE", 470, 18, Color::GRAY);
                draw_center(d, "V  uncap FPS     H  toggle HUD", 500, 18, Color::GRAY);
            }
            Mode::StageClear => {
                let t = if self.challenging { "READY  -  CHALLENGING  STAGE!" } else { "STAGE  CLEAR" };
                draw_center(d, t, 340, 30, Color::YELLOW);
            }
            Mode::GameOver => {
                draw_center(d, "GAME  OVER", 320, 48, Color::RED);
                draw_center(d, "PRESS  ENTER", 400, 24, Color::RAYWHITE);
            }
            _ => {}
        }
        if self.challenging && (self.mode == Mode::Playing || self.mode == Mode::Dying) {
            let t = format!("CHALLENGING STAGE   HITS {}/{}", self.ft_hits, self.ft_spawned);
            draw_center(d, &t, 60, 18, Color::ORANGE);
        }
    }
}

fn draw_center(d: &mut RaylibDrawHandle, t: &str, y: i32, size: i32, col: Color) {
    let w = d.measure_text(t, size); // RaylibHandle method via Deref
    d.draw_text(t, SCREEN_W / 2 - w / 2, y, size, col);
}
