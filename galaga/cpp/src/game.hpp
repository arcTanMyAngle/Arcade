// game.hpp — game state + the update/draw/flow machine.
// Mirrored by galaga/rust/src/game.rs.
#pragma once
#include "entities.hpp"
#include "audio.hpp"

namespace gg {

struct Input {
    bool left = false, right = false;
    bool firePressed = false;   // edge-triggered
    bool startPressed = false;
};

struct Game {
    Rng   rng{ 0x1234567u };
    Mode  mode = TITLE;
    int   stage = 0;
    int   score = 0;
    int   hiScore = 0;
    int   lives = START_LIVES;
    bool  challenging = false;

    // player
    Vector2 player{ SCREEN_W * 0.5f, PLAYER_Y };
    int   fighters = 1;            // 1 or 2 (dual)
    bool  playerAlive = true;
    float respawnTimer = 0.0f;
    float fireCooldown = 0.0f;

    std::vector<Bullet>   bullets;
    std::vector<Bomb>     bombs;
    std::vector<Enemy>    enemies;
    std::vector<Star>     stars;
    FreedShip freed{ {0,0}, false };

    Sfx   sfx;                     // procedural sound effects (loaded from main)

    float swayTime = 0.0f;
    float diveTimer = 2.0f;
    float modeTimer = 0.0f;
    int   ftHits = 0;              // challenging-stage hit counter
    int   ftSpawned = 0;          // challenging-stage spawned counter
    int   extras = 0;             // extra lives already awarded

    void init();
    void startStage();
    void update(const Input& in);
    void draw() const;

    int  aliveEnemies() const;
    int  entityCount() const;

private:
    void updatePlaying(const Input& in);
    void updateEnemies();
    void scheduleDives();
    void startDive(Enemy& e);
    void fire();
    void dropBomb(Vector2 from);
    void killEnemy(Enemy& e, bool diving);
    void playSfx(SfxId id) const { sfx.play(id); }
    void hitPlayer(bool captured, Enemy* captor);
    void spawnFormation();
    void spawnChallenging();
    bool anyCarrying() const;
    void stageClear();
};

} // namespace gg
