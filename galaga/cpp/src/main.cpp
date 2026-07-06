// main.cpp — window, fixed-timestep loop, input and the performance HUD.
// Mirrored by galaga/rust/src/main.rs.
#include "raylib.h"
#include "game.hpp"

using namespace gg;

static Input readInput() {
    Input in;
    in.left  = IsKeyDown(KEY_LEFT)  || IsKeyDown(KEY_A);
    in.right = IsKeyDown(KEY_RIGHT) || IsKeyDown(KEY_D);
    in.firePressed  = IsKeyPressed(KEY_SPACE) || IsKeyPressed(KEY_LEFT_CONTROL);
    in.startPressed = IsKeyPressed(KEY_ENTER)  || IsKeyPressed(KEY_KP_ENTER);
    return in;
}

int main() {
    InitWindow(SCREEN_W, SCREEN_H, "Galaga - C++ / raylib");
    InitAudioDevice();
    SetExitKey(KEY_ESCAPE);
    bool uncapped = false;
    SetTargetFPS(60);

    Game game;
    game.init();
    if (IsAudioDeviceReady()) game.sfx.load();

    bool showHud = true;
    double acc = 0.0;

    while (!WindowShouldClose()) {
        if (IsKeyPressed(KEY_V)) { uncapped = !uncapped; SetTargetFPS(uncapped ? 0 : 60); }
        if (IsKeyPressed(KEY_H)) showHud = !showHud;

        // ---- fixed-timestep update, decoupled from render rate ----
        float ft = GetFrameTime();
        if (ft > 0.25f) ft = 0.25f;        // avoid spiral-of-death after a stall
        acc += ft;
        Input in = readInput();            // edge events read once per rendered frame
        bool firstStep = true;
        while (acc >= DT) {
            Input step = in;
            if (!firstStep) { step.firePressed = false; step.startPressed = false; }
            game.update(step);
            acc -= DT;
            firstStep = false;
        }

        // ---- render ----
        BeginDrawing();
        ClearBackground(BLACK);
        game.draw();

        if (showHud) {
            DrawRectangle(0, 0, 150, 78, Fade(BLACK, 0.55f));
            DrawText(TextFormat("FPS   %d", GetFPS()), 8, 4, 18, GREEN);
            DrawText(TextFormat("ms    %.2f", GetFrameTime() * 1000.0f), 8, 24, 18, GREEN);
            DrawText(TextFormat("ent   %d", game.entityCount()), 8, 44, 18, GREEN);
            DrawText(uncapped ? "UNCAPPED" : "VSYNC 60", 8, 60, 16, uncapped ? ORANGE : GRAY);
        }
        EndDrawing();
    }

    game.sfx.unload();
    CloseAudioDevice();
    CloseWindow();
    return 0;
}
