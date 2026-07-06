// paths.rs — curved motion paths sampled into constant-speed polylines.
// 1:1 port of galaga/cpp/src/paths.hpp.
use raylib::prelude::Vector2;
use crate::entities::*;

pub fn bezier(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, t: f32) -> Vector2 {
    let u = 1.0 - t;
    let a = u * u * u;
    let b = 3.0 * u * u * t;
    let c = 3.0 * u * t * t;
    let d = t * t * t;
    Vector2::new(
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    )
}

pub fn sample_bezier(out: &mut Vec<Vector2>, p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, n: i32) {
    let start = if out.is_empty() { 0 } else { 1 };
    for i in start..=n {
        out.push(bezier(p0, p1, p2, p3, i as f32 / n as f32));
    }
}

pub fn compute_cum(pts: &[Vector2], cum: &mut Vec<f32>) -> f32 {
    cum.clear();
    cum.resize(pts.len(), 0.0);
    let mut total = 0.0;
    for i in 1..pts.len() {
        let dx = pts[i].x - pts[i - 1].x;
        let dy = pts[i].y - pts[i - 1].y;
        total += (dx * dx + dy * dy).sqrt();
        cum[i] = total;
    }
    total
}

pub fn sample_path(pts: &[Vector2], cum: &[f32], dist: f32) -> Vector2 {
    if pts.is_empty() { return Vector2::new(0.0, 0.0); }
    if dist <= 0.0 { return pts[0]; }
    let total = *cum.last().unwrap();
    if dist >= total { return *pts.last().unwrap(); }
    let mut i = 1;
    while i < cum.len() && cum[i] < dist { i += 1; }
    let seg = cum[i] - cum[i - 1];
    let t = if seg > 0.0 { (dist - cum[i - 1]) / seg } else { 0.0 };
    Vector2::new(
        pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
    )
}

pub fn make_entry_path(side: i32, home: Vector2, rng: &mut Rng) -> Vec<Vector2> {
    let mut p = Vec::new();
    let left = side & 1 == 0;
    let start = Vector2::new(if left { -50.0 } else { FW + 50.0 }, rng.range(80.0, 200.0));
    let c1 = Vector2::new(FW * 0.5 + rng.range(-60.0, 60.0), FH * 0.72);
    let c2 = Vector2::new(if left { FW * 0.75 } else { FW * 0.25 }, FH * 0.45);
    let mid = Vector2::new(FW * 0.5, FH * 0.40);
    sample_bezier(&mut p, start, c1, c2, mid, 22);
    let c3 = Vector2::new(mid.x + rng.range(-40.0, 40.0), mid.y - 80.0);
    let c4 = Vector2::new(home.x, home.y + 70.0);
    sample_bezier(&mut p, mid, c3, c4, home, 18);
    p
}

pub fn make_dive_path(from: Vector2, target_x: f32, rng: &mut Rng) -> Vec<Vector2> {
    let mut p = Vec::new();
    let c1 = Vector2::new(from.x + rng.range(-90.0, 90.0), from.y + 90.0);
    let c2 = Vector2::new(target_x + rng.range(-70.0, 70.0), FH * 0.7);
    let end = Vector2::new(target_x + rng.range(-50.0, 50.0), FH + 50.0);
    sample_bezier(&mut p, from, c1, c2, end, 26);
    p
}

pub fn make_capture_path(from: Vector2, target_x: f32, rng: &mut Rng) -> Vec<Vector2> {
    let mut p = Vec::new();
    let stop = Vector2::new(target_x, FH * 0.5);
    let c1 = Vector2::new(from.x + rng.range(-60.0, 60.0), from.y + 120.0);
    let c2 = Vector2::new(target_x + rng.range(-40.0, 40.0), FH * 0.42);
    sample_bezier(&mut p, from, c1, c2, stop, 24);
    p
}

pub fn make_return_path(home: Vector2, rng: &mut Rng) -> Vec<Vector2> {
    let mut p = Vec::new();
    let start = Vector2::new(home.x + rng.range(-120.0, 120.0), -40.0);
    let c1 = Vector2::new(home.x + rng.range(-80.0, 80.0), 100.0);
    let c2 = Vector2::new(home.x, home.y - 60.0);
    sample_bezier(&mut p, start, c1, c2, home, 20);
    p
}

pub fn make_fly_through_path(side: i32, rng: &mut Rng) -> Vec<Vector2> {
    let mut p = Vec::new();
    let left = side & 1 == 0;
    let start = Vector2::new(if left { -50.0 } else { FW + 50.0 }, rng.range(80.0, 160.0));
    let c1 = Vector2::new(FW * 0.5, rng.range(FH * 0.55, FH * 0.8));
    let c2 = Vector2::new(FW * 0.5, rng.range(120.0, 260.0));
    let end = Vector2::new(if left { FW + 50.0 } else { -50.0 }, rng.range(80.0, 200.0));
    sample_bezier(&mut p, start, c1, c2, end, 30);
    p
}
