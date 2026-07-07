// entities.hpp — constants, data structs, RNG and small helpers.
// Kept header-only so the gameplay constants live in exactly one place and are
// trivial to compare 1:1 against the Rust port (galaga/rust/src/entities.rs).
#pragma once
#include "raylib.h"
#include <vector>
#include <cstdint>
#include <cmath>

namespace gg {

// ---------- Logical screen / fixed timestep ----------
constexpr int   SCREEN_W = 600;
constexpr int   SCREEN_H = 760;
constexpr float DT       = 1.0f / 60.0f;   // fixed update step (seconds)

// ---------- Player ----------
constexpr float PLAYER_W      = 36.0f;
constexpr float PLAYER_H      = 28.0f;
constexpr float PLAYER_SPEED  = 320.0f;
constexpr float PLAYER_Y      = SCREEN_H - 70.0f;
constexpr float DUAL_OFFSET   = 20.0f;     // half-gap between the two dual fighters
constexpr int   START_LIVES   = 3;
constexpr int   EXTRA_LIFE_SCORE = 20000;

// ---------- Shots ----------
constexpr float BULLET_SPEED = 780.0f;
constexpr float BULLET_W     = 4.0f;
constexpr float BULLET_H     = 16.0f;
constexpr int   MAX_BULLETS_PER_FIGHTER = 2;
constexpr float BOMB_SPEED   = 300.0f;
constexpr float BOMB_W       = 7.0f;
constexpr float BOMB_H       = 14.0f;

// ---------- Enemies / formation ----------
constexpr float ENEMY_W   = 32.0f;
constexpr float ENEMY_H   = 28.0f;
constexpr int   FORM_COLS = 8;
constexpr int   FORM_ROWS = 5;
constexpr float CELL_W    = 48.0f;
constexpr float CELL_H    = 40.0f;
constexpr float FORM_TOP  = 130.0f;
constexpr float SWAY_AMP  = 18.0f;
constexpr float SWAY_SPEED= 1.1f;
constexpr float ENTER_SPEED = 300.0f;
constexpr float DIVE_SPEED  = 320.0f;
constexpr float BEAM_W      = 120.0f;      // tractor-beam mouth width
constexpr float BEAM_HOLD   = 1.6f;        // seconds the beam stays open
constexpr int   CHALLENGE_WAVES    = 5;    // distinct waves in a challenging stage
constexpr int   CHALLENGE_PER_WAVE = 8;    // single-file enemies per wave
constexpr int   CHALLENGE_TOTAL = CHALLENGE_WAVES * CHALLENGE_PER_WAVE; // 40, arcade-accurate
constexpr float EXPLODE_TIME = 0.25f;      // seconds an enemy spends in the Exploding state
constexpr int   BOSS_HP      = 2;          // hits a boss takes before dying

// ---------- Game modes ----------
enum Mode { TITLE, PLAYING, STAGE_CLEAR, DYING, GAME_OVER };

enum class EnemyType  { Bee, Butterfly, Boss };
enum class EnemyState { Entering, Formation, Diving, Returning, CaptureDive, CaptureHold, FlyThrough, Exploding, Dead };

struct Bullet { Vector2 pos; bool active; };
struct Bomb   { Vector2 pos; bool active; };
struct Star   { Vector2 pos; float speed; float bright; };

struct Enemy {
    EnemyType  type;
    EnemyState state;
    int   col, row;            // home slot in the formation grid
    Vector2 pos;
    std::vector<Vector2> path; // current motion polyline
    std::vector<float>   cum;  // cumulative arc length per point
    float pathLen;
    float dist;                // distance travelled along the path
    float delay;               // entry stagger (seconds) before motion starts
    float fireTimer;           // cooldown before dropping the next bomb
    float holdTimer;           // capture-beam timer
    bool  carrying;            // boss is holding a captured fighter
    float targetX;             // remembered dive target (player x at dive start)
    int   hp;                  // hits remaining (Boss=2, others=1)
    float fxTimer;             // Exploding-state countdown
};

// A captured fighter freed from a destroyed boss, drifting down to rejoin.
struct FreedShip { Vector2 pos; bool active; };

// ---------- Deterministic LCG (identical in both languages) ----------
struct Rng {
    uint32_t s;
    uint32_t next() { s = s * 1664525u + 1013904223u; return s; }
    float f()       { return (next() >> 8) * (1.0f / 16777216.0f); } // [0,1)
    float range(float a, float b) { return a + f() * (b - a); }
    int   irange(int a, int b)    { return a + (int)(next() % (uint32_t)(b - a + 1)); }
};

// ---------- Helpers ----------
inline Vector2 formationHome(int col, int row) {
    float gridW = (FORM_COLS - 1) * CELL_W;
    float x = SCREEN_W * 0.5f - gridW * 0.5f + col * CELL_W;
    float y = FORM_TOP + row * CELL_H;
    return { x, y };
}

// Row 0 = bosses (centre 4 columns only), rows 1-2 butterflies, rows 3-4 bees.
inline EnemyType rowType(int row) {
    if (row == 0) return EnemyType::Boss;
    if (row <= 2) return EnemyType::Butterfly;
    return EnemyType::Bee;
}
inline bool slotUsed(int col, int row) {
    if (row == 0) return col >= 2 && col <= 5; // only 4 bosses
    return true;
}

inline bool aabb(Vector2 a, float aw, float ah, Vector2 b, float bw, float bh) {
    return std::fabs(a.x - b.x) * 2.0f < (aw + bw) &&
           std::fabs(a.y - b.y) * 2.0f < (ah + bh);
}

} // namespace gg
