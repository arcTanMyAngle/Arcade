// paths.hpp — curved motion paths, sampled into constant-speed polylines.
// Header-only inline; mirrored by galaga/rust/src/paths.rs.
#pragma once
#include "entities.hpp"

namespace gg {

// Cubic Bezier point.
inline Vector2 bezier(Vector2 p0, Vector2 p1, Vector2 p2, Vector2 p3, float t) {
    float u = 1.0f - t;
    float a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return { a * p0.x + b * p1.x + c * p2.x + d * p3.x,
             a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

inline void sampleBezier(std::vector<Vector2>& out,
                         Vector2 p0, Vector2 p1, Vector2 p2, Vector2 p3, int n) {
    int start = out.empty() ? 0 : 1; // avoid duplicating the join point
    for (int i = start; i <= n; ++i)
        out.push_back(bezier(p0, p1, p2, p3, (float)i / n));
}

// Cumulative arc length for a polyline, returns total length.
inline float computeCum(const std::vector<Vector2>& pts, std::vector<float>& cum) {
    cum.assign(pts.size(), 0.0f);
    float total = 0.0f;
    for (size_t i = 1; i < pts.size(); ++i) {
        float dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
        total += std::sqrt(dx * dx + dy * dy);
        cum[i] = total;
    }
    return total;
}

// Position at arc-length `dist` along the polyline.
inline Vector2 samplePath(const std::vector<Vector2>& pts, const std::vector<float>& cum,
                          float dist) {
    if (pts.empty()) return { 0, 0 };
    if (dist <= 0) return pts.front();
    float total = cum.back();
    if (dist >= total) return pts.back();
    size_t i = 1;
    while (i < cum.size() && cum[i] < dist) ++i;
    float seg = cum[i] - cum[i - 1];
    float t = seg > 0 ? (dist - cum[i - 1]) / seg : 0.0f;
    return { pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
             pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
}

// Entry swoop: come in from a screen side, loop, then settle into `home`.
inline std::vector<Vector2> makeEntryPath(int side, Vector2 home, Rng& rng) {
    std::vector<Vector2> p;
    bool left = (side & 1) == 0;
    Vector2 start = { left ? -50.0f : SCREEN_W + 50.0f, rng.range(80.0f, 200.0f) };
    Vector2 c1    = { SCREEN_W * 0.5f + rng.range(-60, 60), SCREEN_H * 0.72f };
    Vector2 c2    = { left ? SCREEN_W * 0.75f : SCREEN_W * 0.25f, SCREEN_H * 0.45f };
    Vector2 mid   = { SCREEN_W * 0.5f, SCREEN_H * 0.40f };
    sampleBezier(p, start, c1, c2, mid, 22);
    Vector2 c3 = { mid.x + rng.range(-40, 40), mid.y - 80 };
    Vector2 c4 = { home.x, home.y + 70 };
    sampleBezier(p, mid, c3, c4, home, 18);
    return p;
}

// Append a sampled 360-degree loop to a path, curling off the current heading.
// The loop centre sits 90 degrees to one side of the travel direction.
inline void appendLoop(std::vector<Vector2>& p, float radius, bool clockwise) {
    Vector2 last = p.back();
    Vector2 prev = p.size() >= 2 ? p[p.size() - 2] : Vector2{ last.x, last.y - 1.0f };
    float heading = atan2f(last.y - prev.y, last.x - prev.x);
    float side = clockwise ? -PI / 2.0f : PI / 2.0f;
    Vector2 center = { last.x + cosf(heading + side) * radius,
                       last.y + sinf(heading + side) * radius };
    float a0 = atan2f(last.y - center.y, last.x - center.x);
    const int N = 20;
    for (int i = 1; i <= N; ++i) {
        float a = a0 + (clockwise ? -1.0f : 1.0f) * (2.0f * PI) * i / N;
        p.push_back({ center.x + cosf(a) * radius, center.y + sinf(a) * radius });
    }
}

// Shared "trunk" entry curve for a single-file group: swoop in from one side,
// optionally do a full 360 loop, and end at a rally point above the formation.
// All members of a group fly this identical curve (staggered) before peeling off.
inline std::vector<Vector2> makeGroupTrunk(int side, bool withLoop, Rng& rng) {
    std::vector<Vector2> p;
    bool left = (side & 1) == 0;
    Vector2 start = { left ? -50.0f : SCREEN_W + 50.0f, rng.range(60.0f, 120.0f) };
    Vector2 c1    = { SCREEN_W * 0.5f + rng.range(-50, 50), SCREEN_H * 0.65f };
    Vector2 c2    = { left ? SCREEN_W * 0.70f : SCREEN_W * 0.30f, SCREEN_H * 0.50f };
    Vector2 mid   = { SCREEN_W * 0.5f, SCREEN_H * 0.45f };
    sampleBezier(p, start, c1, c2, mid, 24);
    if (withLoop) appendLoop(p, 55.0f, left);
    Vector2 rally = { SCREEN_W * 0.5f, FORM_TOP - 30.0f };
    Vector2 c3 = { p.back().x + rng.range(-30, 30), p.back().y - 60.0f };
    Vector2 c4 = { rally.x, rally.y + 60.0f };
    sampleBezier(p, p.back(), c3, c4, rally, 16);
    return p;
}

// Dive at the player, sweeping down and off the bottom of the screen.
inline std::vector<Vector2> makeDivePath(Vector2 from, float targetX, Rng& rng) {
    std::vector<Vector2> p;
    Vector2 c1 = { from.x + rng.range(-90, 90), from.y + 90 };
    Vector2 c2 = { targetX + rng.range(-70, 70), SCREEN_H * 0.7f };
    Vector2 end = { targetX + rng.range(-50, 50), SCREEN_H + 50 };
    sampleBezier(p, from, c1, c2, end, 26);
    return p;
}

// Boss capture dive: descend and stop part-way to open the tractor beam.
inline std::vector<Vector2> makeCapturePath(Vector2 from, float targetX, Rng& rng) {
    std::vector<Vector2> p;
    Vector2 stop = { targetX, SCREEN_H * 0.5f };
    Vector2 c1 = { from.x + rng.range(-60, 60), from.y + 120 };
    Vector2 c2 = { targetX + rng.range(-40, 40), SCREEN_H * 0.42f };
    sampleBezier(p, from, c1, c2, stop, 24);
    return p;
}

// Re-enter from the top and fly back to the formation slot.
inline std::vector<Vector2> makeReturnPath(Vector2 home, Rng& rng) {
    std::vector<Vector2> p;
    Vector2 start = { home.x + rng.range(-120, 120), -40 };
    Vector2 c1 = { home.x + rng.range(-80, 80), 100 };
    Vector2 c2 = { home.x, home.y - 60 };
    sampleBezier(p, start, c1, c2, home, 20);
    return p;
}

// Challenging-stage fly-through: enter one side, big arc, exit the other side.
// `variant` shifts the arc band so each of the 5 waves traces a distinct path.
inline std::vector<Vector2> makeFlyThroughPath(int side, Rng& rng, int variant = 0) {
    std::vector<Vector2> p;
    bool left = (side & 1) == 0;
    float entryY = rng.range(70, 150) + variant * 6.0f;
    float dip    = SCREEN_H * (0.55f + 0.06f * variant);   // how low the arc swings
    Vector2 start = { left ? -50.0f : SCREEN_W + 50.0f, entryY };
    Vector2 c1 = { SCREEN_W * 0.5f, std::min((float)SCREEN_H * 0.85f, dip) };
    Vector2 c2 = { SCREEN_W * 0.5f, rng.range(120, 260) };
    Vector2 end = { left ? SCREEN_W + 50.0f : -50.0f, entryY + rng.range(-30, 30) };
    sampleBezier(p, start, c1, c2, end, 30);
    return p;
}

} // namespace gg
