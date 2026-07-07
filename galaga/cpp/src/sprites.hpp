// sprites.hpp — procedural immediate-mode sprite drawing (no asset files).
// Header-only inline; mirrored by galaga/rust/src/sprites.rs.
#pragma once
#include "entities.hpp"

namespace gg {

inline void drawShip(Vector2 c, Color tint) {
    float w = PLAYER_W, h = PLAYER_H;
    // hull
    DrawTriangle({ c.x, c.y - h * 0.5f },
                 { c.x - w * 0.5f, c.y + h * 0.5f },
                 { c.x + w * 0.5f, c.y + h * 0.5f }, tint);
    // wings
    DrawRectangle((int)(c.x - w * 0.5f), (int)(c.y + h * 0.2f), (int)w, 5, tint);
    // cockpit
    DrawRectangle((int)(c.x - 3), (int)(c.y - 4), 6, 12, RED);
}

// type-tinted "bug": body + two wings + antennae.
// `damaged` tints a boss blue/purple to show it survived its first hit.
inline void drawBug(Vector2 c, EnemyType type, bool damaged = false) {
    Color body, wing;
    float w = ENEMY_W, h = ENEMY_H;
    switch (type) {
        case EnemyType::Bee:       body = YELLOW;       wing = SKYBLUE; break;
        case EnemyType::Butterfly: body = RED;          wing = YELLOW;  break;
        default:                   body = GREEN; wing = BLUE; w += 4; h += 4; break;
    }
    if (type == EnemyType::Boss && damaged) { body = PURPLE; wing = DARKBLUE; }
    // wings (triangles flaring out and down)
    DrawTriangle({ c.x, c.y - h * 0.1f },
                 { c.x - w * 0.6f, c.y - h * 0.4f },
                 { c.x - w * 0.45f, c.y + h * 0.45f }, wing);
    DrawTriangle({ c.x, c.y - h * 0.1f },
                 { c.x + w * 0.45f, c.y + h * 0.45f },
                 { c.x + w * 0.6f, c.y - h * 0.4f }, wing);
    // body
    DrawRectangle((int)(c.x - w * 0.2f), (int)(c.y - h * 0.4f), (int)(w * 0.4f), (int)(h * 0.8f), body);
    // eyes
    DrawRectangle((int)(c.x - w * 0.18f), (int)(c.y - h * 0.15f), 4, 4, WHITE);
    DrawRectangle((int)(c.x + w * 0.18f - 4), (int)(c.y - h * 0.15f), 4, 4, WHITE);
    // antennae
    DrawLineEx({ c.x - 4, c.y - h * 0.4f }, { c.x - 9, c.y - h * 0.7f }, 2, wing);
    DrawLineEx({ c.x + 4, c.y - h * 0.4f }, { c.x + 9, c.y - h * 0.7f }, 2, wing);
}

// Expanding burst for the enemy death animation. t: 0 (start) -> 1 (gone).
inline void drawExplosion(Vector2 c, float t) {
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    float r = ENEMY_W * (0.3f + t * 0.9f);
    unsigned char a = (unsigned char)(255 * (1.0f - t));
    if (t < 0.3f) // brief white core flash
        DrawCircle((int)c.x, (int)c.y, ENEMY_W * 0.5f * (1.0f - t / 0.3f), Color{ 255,255,255,a });
    DrawCircleLines((int)c.x, (int)c.y, r,        Color{ 255,200,60,a });
    DrawCircleLines((int)c.x, (int)c.y, r * 0.6f, Color{ 255,120,0,a });
    for (int i = 0; i < 6; ++i) { // outward shards
        float ang = (PI / 3.0f) * i + t * 1.5f;
        Vector2 p = { c.x + cosf(ang) * r, c.y + sinf(ang) * r };
        DrawCircle((int)p.x, (int)p.y, 3.0f * (1.0f - t), Color{ 255,230,120,a });
    }
}

inline void drawBullet(Vector2 p) {
    DrawRectangle((int)(p.x - BULLET_W * 0.5f), (int)(p.y - BULLET_H * 0.5f),
                  (int)BULLET_W, (int)BULLET_H, RAYWHITE);
}

inline void drawBomb(Vector2 p) {
    DrawCircle((int)p.x, (int)p.y, BOMB_W * 0.6f, ORANGE);
    DrawCircleLines((int)p.x, (int)p.y, BOMB_W * 0.9f, RED);
}

inline void drawStar(const Star& s) {
    unsigned char b = (unsigned char)(120 + s.bright * 135);
    DrawPixel((int)s.pos.x, (int)s.pos.y, Color{ b, b, (unsigned char)(b > 230 ? 255 : b), 255 });
}

// Tractor beam: a downward-flaring translucent cone from a capturing boss.
inline void drawBeam(Vector2 bossPos, float alpha) {
    Color col = { 0, 200, 255, (unsigned char)(120 * alpha) };
    float topW = ENEMY_W * 0.6f;
    float botW = BEAM_W;
    float top = bossPos.y + ENEMY_H * 0.3f;
    float bot = SCREEN_H;
    DrawTriangle({ bossPos.x - topW * 0.5f, top },
                 { bossPos.x - botW * 0.5f, bot },
                 { bossPos.x + botW * 0.5f, bot }, col);
    DrawTriangle({ bossPos.x - topW * 0.5f, top },
                 { bossPos.x + botW * 0.5f, bot },
                 { bossPos.x + topW * 0.5f, top }, col);
}

} // namespace gg
