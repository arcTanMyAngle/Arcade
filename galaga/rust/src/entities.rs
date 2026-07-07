// entities.rs — constants, data structs, RNG and helpers.
// 1:1 port of galaga/cpp/src/entities.hpp — keep the numbers identical.
use raylib::prelude::Vector2;

// ---------- Logical screen / fixed timestep ----------
pub const SCREEN_W: i32 = 600;
pub const SCREEN_H: i32 = 760;
pub const FW: f32 = SCREEN_W as f32;
pub const FH: f32 = SCREEN_H as f32;
pub const DT: f32 = 1.0 / 60.0;

// ---------- Player ----------
pub const PLAYER_W: f32 = 36.0;
pub const PLAYER_H: f32 = 28.0;
pub const PLAYER_SPEED: f32 = 320.0;
pub const PLAYER_Y: f32 = FH - 70.0;
pub const DUAL_OFFSET: f32 = 20.0;
pub const START_LIVES: i32 = 3;
pub const EXTRA_LIFE_SCORE: i32 = 20000;

// ---------- Shots ----------
pub const BULLET_SPEED: f32 = 780.0;
pub const BULLET_W: f32 = 4.0;
pub const BULLET_H: f32 = 16.0;
pub const MAX_BULLETS_PER_FIGHTER: i32 = 2;
pub const BOMB_SPEED: f32 = 300.0;
pub const BOMB_W: f32 = 7.0;
pub const BOMB_H: f32 = 14.0;

// ---------- Enemies / formation ----------
pub const ENEMY_W: f32 = 32.0;
pub const ENEMY_H: f32 = 28.0;
pub const FORM_COLS: i32 = 8;
pub const FORM_ROWS: i32 = 5;
pub const CELL_W: f32 = 48.0;
pub const CELL_H: f32 = 40.0;
pub const FORM_TOP: f32 = 130.0;
pub const SWAY_AMP: f32 = 18.0;
pub const SWAY_SPEED: f32 = 1.1;
pub const ENTER_SPEED: f32 = 300.0;
pub const DIVE_SPEED: f32 = 320.0;
pub const BEAM_W: f32 = 120.0;
pub const BEAM_HOLD: f32 = 1.6;
pub const CHALLENGE_TOTAL: i32 = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode { Title, Playing, StageClear, Dying, GameOver }

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EnemyType { Bee, Butterfly, Boss }

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EnemyState { Entering, Formation, Diving, Returning, CaptureDive, CaptureHold, FlyThrough, Dead }

#[derive(Clone, Copy)]
pub struct Bullet { pub pos: Vector2, pub active: bool }
#[derive(Clone, Copy)]
pub struct Bomb { pub pos: Vector2, pub active: bool }
#[derive(Clone, Copy)]
pub struct Star { pub pos: Vector2, pub speed: f32, pub bright: f32 }
#[derive(Clone, Copy)]
pub struct FreedShip { pub pos: Vector2, pub active: bool }

#[derive(Clone)]
pub struct Enemy {
    pub etype: EnemyType,
    pub state: EnemyState,
    pub col: i32,
    pub row: i32,
    pub pos: Vector2,
    pub path: Vec<Vector2>,
    pub cum: Vec<f32>,
    pub path_len: f32,
    pub dist: f32,
    pub delay: f32,
    pub fire_timer: f32,
    pub hold_timer: f32,
    pub carrying: bool,
    pub target_x: f32,
}

impl Enemy {
    pub fn blank() -> Enemy {
        Enemy {
            etype: EnemyType::Bee, state: EnemyState::Dead, col: 0, row: 0,
            pos: Vector2::new(0.0, 0.0), path: Vec::new(), cum: Vec::new(),
            path_len: 0.0, dist: 0.0, delay: 0.0, fire_timer: 0.0, hold_timer: 0.0,
            carrying: false, target_x: 0.0,
        }
    }
}

// ---------- Deterministic LCG (identical to the C++ Rng) ----------
pub struct Rng { pub s: u32 }
impl Rng {
    pub fn new(seed: u32) -> Rng { Rng { s: seed } }
    pub fn next(&mut self) -> u32 {
        self.s = self.s.wrapping_mul(1664525).wrapping_add(1013904223);
        self.s
    }
    pub fn f(&mut self) -> f32 { (self.next() >> 8) as f32 * (1.0 / 16777216.0) }
    pub fn range(&mut self, a: f32, b: f32) -> f32 { a + self.f() * (b - a) }
    pub fn irange(&mut self, a: i32, b: i32) -> i32 { a + (self.next() % (b - a + 1) as u32) as i32 }
}

// ---------- Helpers ----------
pub fn formation_home(col: i32, row: i32) -> Vector2 {
    let grid_w = (FORM_COLS - 1) as f32 * CELL_W;
    let x = FW * 0.5 - grid_w * 0.5 + col as f32 * CELL_W;
    let y = FORM_TOP + row as f32 * CELL_H;
    Vector2::new(x, y)
}

pub fn row_type(row: i32) -> EnemyType {
    if row == 0 { EnemyType::Boss }
    else if row <= 2 { EnemyType::Butterfly }
    else { EnemyType::Bee }
}

pub fn slot_used(col: i32, row: i32) -> bool {
    if row == 0 { (2..=5).contains(&col) } else { true }
}

pub fn aabb(a: Vector2, aw: f32, ah: f32, b: Vector2, bw: f32, bh: f32) -> bool {
    (a.x - b.x).abs() * 2.0 < (aw + bw) && (a.y - b.y).abs() * 2.0 < (ah + bh)
}
