// game.cpp — gameplay logic, flow machine and rendering.
// Mirrored by galaga/rust/src/game.rs.
#include "game.hpp"
#include "paths.hpp"
#include "sprites.hpp"
#include <algorithm>
#include <cmath>

namespace gg {

// ---------- setup ----------
void Game::init() {
    stars.clear();
    for (int i = 0; i < 110; ++i) {
        stars.push_back({ { rng.range(0, SCREEN_W), rng.range(0, SCREEN_H) },
                          rng.range(20, 90), rng.f() });
    }
    mode = TITLE;
}

void Game::spawnFormation() {
    enemies.clear();

    // Collect the occupied formation slots in entry order (bosses first, then down).
    struct Slot { int col, row; };
    std::vector<Slot> slots;
    for (int row = 0; row < FORM_ROWS; ++row)
        for (int col = 0; col < FORM_COLS; ++col)
            if (slotUsed(col, row)) slots.push_back({ col, row });

    // Enter as single-file groups: every member of a group flies the SAME trunk
    // curve (staggered nose-to-tail), then peels off on a short tail to its slot.
    const int GROUP = CHALLENGE_PER_WAVE;   // 8 per group
    float delayAcc = 0.0f;
    for (size_t g0 = 0; g0 < slots.size(); g0 += GROUP) {
        int  gi   = (int)(g0 / GROUP);
        int  side = gi & 1;                 // alternate entry side per group
        bool loop = (gi % 2) == 1;          // every other group does a 360 loop
        std::vector<Vector2> trunk = makeGroupTrunk(side, loop, rng);
        Vector2 rally = trunk.back();

        size_t end = std::min(slots.size(), g0 + (size_t)GROUP);
        for (size_t k = g0; k < end; ++k) {
            Slot s = slots[k];
            Vector2 home = formationHome(s.col, s.row);
            Enemy e{};
            e.type = rowType(s.row);
            e.col = s.col; e.row = s.row;
            e.state = EnemyState::Entering;
            e.path = trunk;                 // shared single-file curve
            // tail: peel off the rally point out to this slot
            Vector2 c1 = { rally.x, rally.y - 20.0f };
            Vector2 c2 = { home.x, home.y - 40.0f };
            sampleBezier(e.path, rally, c1, c2, home, 12);
            e.pathLen = computeCum(e.path, e.cum);
            e.dist = 0; e.delay = delayAcc;
            e.pos = e.path.front();
            e.carrying = false;
            e.fireTimer = rng.range(0.5f, 1.5f);
            e.hp = (e.type == EnemyType::Boss) ? BOSS_HP : 1;
            e.fxTimer = 0;
            enemies.push_back(std::move(e));
            delayAcc += 0.13f;              // single-file spacing within the group
        }
        delayAcc += 0.5f;                  // gap before the next group enters
    }
}

void Game::spawnChallenging() {
    enemies.clear();
    // Exactly 40 enemies: 5 distinct waves of 8. Each wave shares one arc curve so
    // its 8 members stream across the screen single-file, then disappear off-side.
    for (int w = 0; w < CHALLENGE_WAVES; ++w) {
        std::vector<Vector2> arc = makeFlyThroughPath(w & 1, rng, w);
        std::vector<float>   cum;
        float len = computeCum(arc, cum);
        float waveStart = w * 1.3f;        // waves arrive one after another
        for (int i = 0; i < CHALLENGE_PER_WAVE; ++i) {
            Enemy e{};
            e.type = (EnemyType)((w + i) % 3);
            e.col = 0; e.row = 0;
            e.state = EnemyState::FlyThrough;
            e.path = arc;                  // shared curve -> single file
            e.cum = cum; e.pathLen = len;
            e.dist = 0;
            e.delay = waveStart + i * 0.16f;
            e.pos = e.path.front();
            e.carrying = false;
            e.hp = 1;
            e.fxTimer = 0;
            enemies.push_back(std::move(e));
        }
    }
    ftHits = 0;
    ftSpawned = CHALLENGE_TOTAL;
}

void Game::startStage() {
    ++stage;
    bullets.clear();
    bombs.clear();
    freed.active = false;
    challenging = (stage % 4 == 0);
    swayTime = 0.0f;
    diveTimer = std::max(0.6f, 2.0f - stage * 0.1f);
    player.x = SCREEN_W * 0.5f;
    playerAlive = true;
    if (challenging) spawnChallenging();
    else             spawnFormation();
}

// ---------- top-level update ----------
void Game::update(const Input& in) {
    swayTime += DT;
    // starfield always scrolls
    for (auto& s : stars) {
        s.pos.y += s.speed * DT;
        if (s.pos.y > SCREEN_H) { s.pos.y = 0; s.pos.x = rng.range(0, SCREEN_W); }
    }

    switch (mode) {
        case TITLE:
            if (in.startPressed) {
                score = 0; lives = START_LIVES; fighters = 1; stage = 0;
                extras = 0;
                startStage();
                mode = PLAYING;
            }
            break;
        case PLAYING:
            updatePlaying(in);
            break;
        case STAGE_CLEAR:
            modeTimer -= DT;
            if (modeTimer <= 0) { startStage(); mode = PLAYING; }
            break;
        case DYING:
            modeTimer -= DT;
            // let stray bombs keep falling so they clear off-screen
            for (auto& b : bombs) if (b.active) { b.pos.y += BOMB_SPEED * DT; if (b.pos.y > SCREEN_H + 20) b.active = false; }
            if (modeTimer <= 0) {
                if (lives <= 0) { mode = GAME_OVER; if (score > hiScore) hiScore = score; }
                else {
                    player.x = SCREEN_W * 0.5f; playerAlive = true; fighters = 1;
                    for (auto& b : bombs) b.active = false;
                    mode = PLAYING;
                }
            }
            break;
        case GAME_OVER:
            if (in.startPressed) mode = TITLE;
            break;
    }
}

void Game::updatePlaying(const Input& in) {
    // player movement
    if (playerAlive) {
        float half = PLAYER_W * 0.5f + (fighters == 2 ? DUAL_OFFSET : 0);
        if (in.left)  player.x -= PLAYER_SPEED * DT;
        if (in.right) player.x += PLAYER_SPEED * DT;
        player.x = std::min(std::max(player.x, half), (float)SCREEN_W - half);
        fireCooldown -= DT;
        if (in.firePressed && fireCooldown <= 0) fire();
    }

    // shots
    for (auto& b : bullets) if (b.active) { b.pos.y -= BULLET_SPEED * DT; if (b.pos.y < -20) b.active = false; }
    for (auto& b : bombs)   if (b.active) { b.pos.y += BOMB_SPEED * DT;   if (b.pos.y > SCREEN_H + 20) b.active = false; }

    // a captured fighter freed from a destroyed boss drifts down to rejoin
    if (freed.active) {
        freed.pos.y += 140 * DT;
        freed.pos.x += (player.x - freed.pos.x) * std::min(1.0f, 3.0f * DT);
        if (freed.pos.y >= PLAYER_Y) {
            freed.active = false;
            if (playerAlive) fighters = 2;
        }
    }

    updateEnemies();
    if (!challenging) scheduleDives();

    // bullet vs enemy
    for (auto& b : bullets) {
        if (!b.active) continue;
        for (auto& e : enemies) {
            if (e.state == EnemyState::Dead || e.state == EnemyState::Exploding) continue;
            if (aabb(b.pos, BULLET_W, BULLET_H, e.pos, ENEMY_W, ENEMY_H)) {
                b.active = false;
                // a boss soaks the first hit: damage tint + hit sound, no kill
                if (e.type == EnemyType::Boss && e.hp > 1) {
                    e.hp--;
                    playSfx(SfxId::BossHit);
                    break;
                }
                bool diving = e.state == EnemyState::Diving || e.state == EnemyState::CaptureDive ||
                              e.state == EnemyState::CaptureHold || e.state == EnemyState::Returning ||
                              e.state == EnemyState::FlyThrough;
                killEnemy(e, diving);
                break;
            }
        }
    }

    // bombs vs player
    if (playerAlive) {
        for (auto& b : bombs) {
            if (!b.active) continue;
            for (int f = 0; f < fighters; ++f) {
                float fx = player.x + (fighters == 2 ? (f == 0 ? -DUAL_OFFSET : DUAL_OFFSET) : 0);
                if (aabb(b.pos, BOMB_W, BOMB_H, { fx, player.y }, PLAYER_W, PLAYER_H)) {
                    b.active = false;
                    hitPlayer(false, nullptr);
                    break;
                }
            }
            if (!playerAlive) break;
        }
    }

    // diving enemy vs player
    if (playerAlive) {
        for (auto& e : enemies) {
            if (e.state != EnemyState::Diving && e.state != EnemyState::CaptureDive &&
                e.state != EnemyState::FlyThrough) continue;
            for (int f = 0; f < fighters; ++f) {
                float fx = player.x + (fighters == 2 ? (f == 0 ? -DUAL_OFFSET : DUAL_OFFSET) : 0);
                if (aabb(e.pos, ENEMY_W, ENEMY_H, { fx, player.y }, PLAYER_W, PLAYER_H)) {
                    killEnemy(e, true);
                    hitPlayer(false, nullptr);
                    break;
                }
            }
            if (!playerAlive) break;
        }
    }

    // stage clear?
    if (mode == PLAYING) {
        if (challenging) {
            if (aliveEnemies() == 0) stageClear();
        } else if (aliveEnemies() == 0) {
            stageClear();
        }
    }
}

// ---------- enemies ----------
void Game::updateEnemies() {
    float sway = std::sin(swayTime * SWAY_SPEED) * SWAY_AMP;
    for (auto& e : enemies) {
        switch (e.state) {
            case EnemyState::Entering:
                if (e.delay > 0) { e.delay -= DT; e.pos = e.path.front(); break; }
                e.dist += ENTER_SPEED * DT;
                e.pos = samplePath(e.path, e.cum, e.dist);
                if (e.dist >= e.pathLen) e.state = EnemyState::Formation;
                break;
            case EnemyState::Formation: {
                Vector2 h = formationHome(e.col, e.row);
                e.pos = { h.x + sway, h.y };
                break;
            }
            case EnemyState::Diving:
                e.dist += DIVE_SPEED * DT;
                e.pos = samplePath(e.path, e.cum, e.dist);
                e.fireTimer -= DT;
                if (e.fireTimer <= 0 && e.pos.y < SCREEN_H - 120) { dropBomb(e.pos); e.fireTimer = rng.range(0.4f, 0.9f); }
                if (e.dist >= e.pathLen) {
                    e.state = EnemyState::Returning;
                    e.path = makeReturnPath(formationHome(e.col, e.row), rng);
                    e.pathLen = computeCum(e.path, e.cum);
                    e.dist = 0;
                }
                break;
            case EnemyState::CaptureDive:
                e.dist += DIVE_SPEED * 0.75f * DT;
                e.pos = samplePath(e.path, e.cum, e.dist);
                if (e.dist >= e.pathLen) { e.state = EnemyState::CaptureHold; e.holdTimer = BEAM_HOLD; playSfx(SfxId::TractorBeam); }
                break;
            case EnemyState::CaptureHold:
                e.holdTimer -= DT;
                if (playerAlive && !freed.active && !anyCarrying()) {
                    if (std::fabs(player.x - e.pos.x) < BEAM_W * 0.5f && player.y > e.pos.y) {
                        hitPlayer(true, &e); // capture: boss starts carrying, costs a life
                    }
                }
                if (e.holdTimer <= 0 && e.state == EnemyState::CaptureHold) {
                    e.state = EnemyState::Returning;
                    e.path = makeReturnPath(formationHome(e.col, e.row), rng);
                    e.pathLen = computeCum(e.path, e.cum);
                    e.dist = 0;
                }
                break;
            case EnemyState::Returning:
                e.dist += ENTER_SPEED * DT;
                e.pos = samplePath(e.path, e.cum, e.dist);
                if (e.dist >= e.pathLen) e.state = EnemyState::Formation;
                break;
            case EnemyState::FlyThrough:
                if (e.delay > 0) { e.delay -= DT; e.pos = e.path.front(); break; }
                e.dist += ENTER_SPEED * DT;
                e.pos = samplePath(e.path, e.cum, e.dist);
                if (e.dist >= e.pathLen) e.state = EnemyState::Dead;
                break;
            case EnemyState::Exploding:
                e.fxTimer -= DT;             // frozen in place; tick the death animation
                if (e.fxTimer <= 0) e.state = EnemyState::Dead;
                break;
            case EnemyState::Dead: break;
        }
    }
}

void Game::scheduleDives() {
    diveTimer -= DT;
    if (diveTimer > 0) return;

    std::vector<int> formed;
    for (int i = 0; i < (int)enemies.size(); ++i)
        if (enemies[i].state == EnemyState::Formation) formed.push_back(i);
    if (formed.empty()) { diveTimer = 0.5f; return; }

    int idx = formed[rng.irange(0, (int)formed.size() - 1)];
    Enemy& e = enemies[idx];
    bool capture = e.type == EnemyType::Boss && !anyCarrying() && fighters == 1 &&
                   playerAlive && rng.f() < 0.5f;
    if (capture) {
        e.state = EnemyState::CaptureDive;
        e.path = makeCapturePath(e.pos, player.x, rng);
        e.pathLen = computeCum(e.path, e.cum);
        e.dist = 0;
    } else {
        bool isBoss  = e.type == EnemyType::Boss;
        int  bossCol = e.col;
        startDive(e);
        // a diving boss drags up to two adjacent butterfly escorts down with it
        if (isBoss) {
            int sent = 0;
            for (int i = 0; i < (int)enemies.size() && sent < 2; ++i) {
                Enemy& es = enemies[i];
                int dc = es.col - bossCol; if (dc < 0) dc = -dc;
                if (es.type == EnemyType::Butterfly && es.state == EnemyState::Formation &&
                    es.row <= 2 && dc <= 1) {
                    startDive(es);
                    ++sent;
                }
            }
        }
    }
    diveTimer = rng.range(0.8f, 2.0f) * std::max(0.4f, 1.0f - stage * 0.05f);
}

// Send a single enemy into a player-seeking dive from its current position.
void Game::startDive(Enemy& e) {
    e.state = EnemyState::Diving;
    e.targetX = player.x;
    e.path = makeDivePath(e.pos, player.x, rng);
    e.pathLen = computeCum(e.path, e.cum);
    e.dist = 0;
    e.fireTimer = rng.range(0.3f, 0.7f);
}

// ---------- combat ----------
void Game::fire() {
    int active = 0;
    for (auto& b : bullets) if (b.active) ++active;
    if (active >= MAX_BULLETS_PER_FIGHTER * fighters) return;

    auto spawnAt = [&](float x) {
        for (auto& b : bullets) {
            if (!b.active) { b.pos = { x, player.y - PLAYER_H * 0.5f }; b.active = true; return; }
        }
        bullets.push_back({ { x, player.y - PLAYER_H * 0.5f }, true });
    };
    if (fighters == 2) { spawnAt(player.x - DUAL_OFFSET); spawnAt(player.x + DUAL_OFFSET); }
    else                 spawnAt(player.x);
    fireCooldown = 0.18f;
    playSfx(SfxId::Fire);
}

void Game::dropBomb(Vector2 from) {
    for (auto& b : bombs) {
        if (!b.active) { b.pos = from; b.active = true; return; }
    }
    bombs.push_back({ from, true });
}

void Game::killEnemy(Enemy& e, bool diving) {
    int pts = 0;
    switch (e.type) {
        case EnemyType::Bee:       pts = diving ? 100 : 50;  break;
        case EnemyType::Butterfly: pts = diving ? 160 : 80;  break;
        case EnemyType::Boss:      pts = diving ? 400 : 150;  break;
    }
    score += pts;
    if (challenging) ftHits++;
    if (e.carrying) {            // destroying a captor frees the held fighter
        freed.active = true;
        freed.pos = e.pos;
        e.carrying = false;
    }
    // freeze in place and play the death animation before actually dying
    e.state = EnemyState::Exploding;
    e.fxTimer = EXPLODE_TIME;
    playSfx(SfxId::Kill);
    while (score >= (extras + 1) * EXTRA_LIFE_SCORE) { lives++; extras++; }
    if (score > hiScore) hiScore = score;
}

void Game::hitPlayer(bool captured, Enemy* captor) {
    if (!playerAlive) return;
    playerAlive = false;
    fighters = 1;
    lives--;
    playSfx(captured ? SfxId::Capture : SfxId::PlayerDeath);
    if (captured && captor) {
        captor->carrying = true;
        captor->state = EnemyState::Returning;
        captor->path = makeReturnPath(formationHome(captor->col, captor->row), rng);
        captor->pathLen = computeCum(captor->path, captor->cum);
        captor->dist = 0;
    }
    if (lives <= 0) { mode = GAME_OVER; if (score > hiScore) hiScore = score; }
    else            { mode = DYING; modeTimer = 1.4f; }
}

void Game::stageClear() {
    mode = STAGE_CLEAR;
    modeTimer = 2.0f;
}

bool Game::anyCarrying() const {
    for (auto& e : enemies) if (e.carrying) return true;
    return false;
}

int Game::aliveEnemies() const {
    int n = 0;
    for (auto& e : enemies) if (e.state != EnemyState::Dead) ++n;
    return n;
}

int Game::entityCount() const {
    int n = aliveEnemies() + (freed.active ? 1 : 0) + (playerAlive ? fighters : 0);
    for (auto& b : bullets) if (b.active) ++n;
    for (auto& b : bombs)   if (b.active) ++n;
    return n;
}

// ---------- rendering ----------
void Game::draw() const {
    for (auto& s : stars) drawStar(s);

    for (auto& e : enemies) {
        if (e.state == EnemyState::Dead) continue;
        if (e.state == EnemyState::Exploding) {
            drawExplosion(e.pos, 1.0f - e.fxTimer / EXPLODE_TIME);
            continue;
        }
        if (e.state == EnemyState::CaptureHold) {
            float a = e.holdTimer / BEAM_HOLD;
            drawBeam(e.pos, std::min(1.0f, a * 1.5f));
        }
        bool damaged = e.type == EnemyType::Boss && e.hp < BOSS_HP;
        drawBug(e.pos, e.type, damaged);
        if (e.carrying) drawShip({ e.pos.x, e.pos.y + ENEMY_H * 0.8f }, GREEN);
    }

    if (freed.active) drawShip(freed.pos, GREEN);

    if (playerAlive && mode == PLAYING) {
        if (fighters == 2) {
            drawShip({ player.x - DUAL_OFFSET, player.y }, RAYWHITE);
            drawShip({ player.x + DUAL_OFFSET, player.y }, RAYWHITE);
        } else {
            drawShip({ player.x, player.y }, RAYWHITE);
        }
    }

    for (auto& b : bullets) if (b.active) drawBullet(b.pos);
    for (auto& b : bombs)   if (b.active) drawBomb(b.pos);

    // ---- score / lives line ----
    DrawText(TextFormat("SCORE %d", score), 12, 8, 20, RAYWHITE);
    DrawText(TextFormat("HI %d", hiScore), SCREEN_W - 150, 8, 20, RED);
    for (int i = 0; i < lives - 1 && mode == PLAYING; ++i)
        drawShip({ 28.0f + i * 30.0f, SCREEN_H - 20.0f }, SKYBLUE);
    if (mode == PLAYING || mode == DYING)
        DrawText(TextFormat("STAGE %d", stage), SCREEN_W - 110, SCREEN_H - 28, 18, YELLOW);

    // ---- overlays ----
    auto center = [](const char* t, int y, int size, Color col) {
        int w = MeasureText(t, size);
        DrawText(t, SCREEN_W / 2 - w / 2, y, size, col);
    };
    if (mode == TITLE) {
        center("GALAGA", 200, 64, YELLOW);
        center("C++  /  raylib", 280, 28, SKYBLUE);
        center("PRESS  ENTER  TO  START", 420, 24, RAYWHITE);
        center("ARROWS / A,D  MOVE     SPACE  FIRE", 470, 18, GRAY);
        center("V  uncap FPS     H  toggle HUD", 500, 18, GRAY);
    } else if (mode == STAGE_CLEAR) {
        center(challenging ? "READY  -  CHALLENGING  STAGE!" : "STAGE  CLEAR", 340, 30, YELLOW);
    } else if (mode == GAME_OVER) {
        center("GAME  OVER", 320, 48, RED);
        center("PRESS  ENTER", 400, 24, RAYWHITE);
    }
    if (challenging && (mode == PLAYING || mode == DYING))
        center(TextFormat("CHALLENGING STAGE   HITS %d/%d", ftHits, ftSpawned), 60, 18, ORANGE);
}

} // namespace gg
