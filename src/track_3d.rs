//! track_3d.rs — the 3D circuit.
//!
//! A closed racing loop built from cubic Bézier segments. It provides:
//!   * exact spline math (position / 1st / 2nd derivative),
//!   * arc-length re-parameterization (even spacing for the mesh **and** AI),
//!   * banked orientation frames (the road rolls *into* curves, MKWii-style),
//!   * a procedural road mesh (road surface + striped curbs, baked vertex
//!     lighting, no external textures),
//!   * fast "where am I on the track?" ground queries for the physics step.
//!
//! Allocation policy: the spline, the arc-length LUT, and the static mesh are
//! built once at load. Every per-frame query below is heap-free.

use macroquad::models::{Mesh, Vertex};
use macroquad::prelude::*;

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

/// Half-width of the drivable road surface, in world units.
pub const ROAD_HALF_WIDTH: f32 = 7.0;
/// Height of the curb / guard wall lining each edge.
pub const CURB_HEIGHT: f32 = 0.9;
/// Target arc-length distance between consecutive mesh rings.
pub const RING_SPACING: f32 = 2.2;
/// World units of road covered by one tile of the (procedural) road texture.
pub const UV_TILE: f32 = 12.0;

/// Boost pads placed around every circuit (M8). ≥4 per lap satisfies the DoD.
const N_BOOST_PADS: usize = 6;
/// Half-length (m) of a boost pad's footprint along the track.
const PAD_HALF_LEN: f32 = 4.0;
/// Half-width (m) of the boost-pad strip — centered on the road, so a kart must
/// drive roughly down the middle to catch it (hugging the curb misses).
pub const PAD_HALF_WIDTH: f32 = ROAD_HALF_WIDTH * 0.6;

/// Uniform scale applied to every circuit's control anchors (M9). >1 lengthens
/// each lap (and gentles the corners, since radius grows with it) while keeping the
/// road width, banking model and all derived data (LUT, mesh, pads, grid) intact.
const LAP_SCALE: f32 = 1.5;

/// How hard the track banks into curves. Higher = steeper banking.
const BANK_FACTOR: f32 = 14.0;
/// Banking is clamped so the road never rolls past this angle (radians).
const MAX_BANK: f32 = 0.62; // ~35.5 degrees

/// Fixed light direction used to bake vertex shading (the low-poly look).
const LIGHT_DIR: Vec3 = Vec3::new(-0.40, 1.0, 0.30);
/// Ambient floor so faces pointing away from the light are never pure black.
const AMBIENT: f32 = 0.45;

/// Bézier samples per segment used to build the arc-length table. Denser = more
/// accurate length/ground queries at the cost of a slightly bigger LUT.
const LUT_PER_SEG: usize = 24;

// Procedural surface colors (modulated by baked lighting).
const ROAD_COLOR: Color = Color::new(0.20, 0.20, 0.24, 1.0);
const CURB_RED: Color = Color::new(0.85, 0.12, 0.12, 1.0);
const CURB_WHITE: Color = Color::new(0.93, 0.93, 0.93, 1.0);

// ----------------------------------------------------------------------------
// Cubic Bézier segment
// ----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct BezierSegment {
    pub p0: Vec3,
    pub p1: Vec3,
    pub p2: Vec3,
    pub p3: Vec3,
}

impl BezierSegment {
    /// B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
    #[inline]
    pub fn point(&self, t: f32) -> Vec3 {
        let u = 1.0 - t;
        self.p0 * (u * u * u)
            + self.p1 * (3.0 * u * u * t)
            + self.p2 * (3.0 * u * t * t)
            + self.p3 * (t * t * t)
    }

    /// B'(t) — tangent (not normalized). Magnitude is the local "speed".
    #[inline]
    pub fn derivative(&self, t: f32) -> Vec3 {
        let u = 1.0 - t;
        (self.p1 - self.p0) * (3.0 * u * u)
            + (self.p2 - self.p1) * (6.0 * u * t)
            + (self.p3 - self.p2) * (3.0 * t * t)
    }

    /// B''(t) — used for curvature (banking).
    #[inline]
    pub fn second_derivative(&self, t: f32) -> Vec3 {
        let u = 1.0 - t;
        (self.p2 - self.p1 * 2.0 + self.p0) * (6.0 * u)
            + (self.p3 - self.p2 * 2.0 + self.p1) * (6.0 * t)
    }
}

// ----------------------------------------------------------------------------
// Orientation frame along the track
// ----------------------------------------------------------------------------

/// A right-handed coordinate frame riding along the spline, already banked.
/// `up` is the road's surface normal; `right` points to the road's right edge.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub position: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub up: Vec3,
}

// ----------------------------------------------------------------------------
// Boost pad (Milestone 8)
// ----------------------------------------------------------------------------

/// A speed pad embedded in the road. Detection is a pure interval test in
/// spline-parameter space (it reuses the kart's `track_u` + `lateral` from the
/// per-frame ground query — **no new broadphase**); `frame` is cached so the
/// renderer can place the pad mesh flush on the (possibly banked) road.
#[derive(Clone, Copy, Debug)]
pub struct BoostPad {
    /// Spline parameter at the pad's center.
    pub u_center: f32,
    /// Half-extent of the pad in spline-parameter space (longitudinal).
    pub u_half: f32,
    /// Half-width of the drivable strip (lateral, world units).
    pub half_width: f32,
    /// Banked road frame at the pad center (for rendering).
    pub frame: Frame,
}

// ----------------------------------------------------------------------------
// Ground query result (consumed by physics.rs)
// ----------------------------------------------------------------------------

/// The result of projecting a world point onto the road surface.
#[derive(Clone, Copy, Debug)]
pub struct GroundInfo {
    /// Global spline parameter of the foot point (segment index + local t).
    pub u: f32,
    /// Center-line point at `u`.
    pub center: Vec3,
    /// Nearest point on the (width-clamped) road surface.
    pub surface: Vec3,
    /// Road surface normal at `u` (banked).
    pub normal: Vec3,
    pub right: Vec3,
    pub forward: Vec3,
    /// Signed lateral offset from the center line along `right`.
    pub lateral: f32,
    /// Signed height of the query point above the surface along `normal`.
    pub height: f32,
    /// Whether the query point is within the drivable width.
    pub on_road: bool,
}

// ----------------------------------------------------------------------------
// The spline
// ----------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct LutEntry {
    u: f32,
    pos: Vec3,
    cum_len: f32,
}

pub struct TrackSpline {
    segments: Vec<BezierSegment>,
    closed: bool,
    lut: Vec<LutEntry>,
    total_length: f32,
    boost_pads: Vec<BoostPad>,
}

impl TrackSpline {
    /// Build a smooth, **closed** loop through `anchors`.
    ///
    /// Tangents are derived Catmull-Rom style and converted to Bézier control
    /// points, giving C1 continuity across the whole loop with no seam.
    pub fn new_closed(anchors: &[Vec3]) -> Self {
        assert!(anchors.len() >= 3, "a closed circuit needs at least 3 anchors");
        let n = anchors.len();
        let mut segments = Vec::with_capacity(n);

        for i in 0..n {
            // Scale every anchor uniformly so all three circuits run longer laps
            // off a single knob (M9). Done here, at build time, so nothing in the
            // hot path changes.
            let prev = anchors[(i + n - 1) % n] * LAP_SCALE;
            let cur = anchors[i] * LAP_SCALE;
            let next = anchors[(i + 1) % n] * LAP_SCALE;
            let next2 = anchors[(i + 2) % n] * LAP_SCALE;

            // Catmull-Rom -> Bézier control points (tension 0.5).
            let p1 = cur + (next - prev) / 6.0;
            let p2 = next - (next2 - cur) / 6.0;
            segments.push(BezierSegment { p0: cur, p1, p2, p3: next });
        }

        let mut spline = Self {
            segments,
            closed: true,
            lut: Vec::new(),
            total_length: 0.0,
            boost_pads: Vec::new(),
        };
        spline.build_lut();
        spline.place_boost_pads(N_BOOST_PADS);
        spline
    }

    /// A ready-made demo circuit with hills, drops and sweeping (banked) turns.
    /// The original "CIRCUIT" — technical, undulating, a big hill crest.
    pub fn demo_circuit() -> Self {
        let anchors = [
            Vec3::new(0.0, 0.0, -90.0),
            Vec3::new(70.0, 6.0, -70.0),
            Vec3::new(95.0, 10.0, 0.0),
            Vec3::new(70.0, 4.0, 75.0),
            Vec3::new(0.0, 0.0, 100.0),
            Vec3::new(-65.0, 8.0, 80.0),
            Vec3::new(-100.0, 18.0, 0.0), // big hill crest
            Vec3::new(-70.0, 5.0, -75.0),
        ];
        Self::new_closed(&anchors)
    }

    /// "SPEEDWAY" — a big, gentle, near-flat oval. Wide sweepers, top-speed
    /// focused; the easiest track to learn and the fastest to lap.
    pub fn speedway() -> Self {
        let anchors = [
            Vec3::new(0.0, 0.0, -110.0),
            Vec3::new(80.0, 2.0, -95.0),
            Vec3::new(110.0, 0.0, 0.0),
            Vec3::new(80.0, 2.0, 95.0),
            Vec3::new(0.0, 0.0, 110.0),
            Vec3::new(-80.0, 2.0, 95.0),
            Vec3::new(-110.0, 0.0, 0.0),
            Vec3::new(-80.0, 2.0, -95.0),
        ];
        Self::new_closed(&anchors)
    }

    /// "SERPENTINE" — a twistier, hillier loop. Anchors alternate big/small
    /// radius (every 45°, so it stays star-convex → no XZ self-intersection, which
    /// the 2D collision hash relies on) for tight-then-open rhythm and elevation.
    pub fn serpentine() -> Self {
        let anchors = [
            Vec3::new(0.0, 0.0, -85.0),
            Vec3::new(50.0, 6.0, -50.0),
            Vec3::new(88.0, 10.0, 0.0),
            Vec3::new(45.0, 2.0, 45.0),
            Vec3::new(0.0, 12.0, 90.0),
            Vec3::new(-48.0, 16.0, 48.0),
            Vec3::new(-88.0, 6.0, 0.0),
            Vec3::new(-46.0, 3.0, -46.0),
        ];
        Self::new_closed(&anchors)
    }

    // -- basic accessors ----------------------------------------------------

    #[inline]
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    #[inline]
    pub fn total_length(&self) -> f32 {
        self.total_length
    }

    /// Number of cross-section rings the mesh/AI sampler will produce.
    #[inline]
    pub fn ring_count(&self) -> usize {
        ((self.total_length / RING_SPACING).round() as usize).max(8)
    }

    // -- spline evaluation --------------------------------------------------

    /// Map a global parameter `u` to (segment index, local t), wrapping/clamping.
    #[inline]
    fn seg_and_t(&self, u: f32) -> (usize, f32) {
        let n = self.segments.len();
        let max_u = n as f32;
        let uu = if self.closed {
            u.rem_euclid(max_u)
        } else {
            u.clamp(0.0, max_u - 1e-4)
        };
        let seg = (uu.floor() as usize).min(n - 1);
        (seg, uu - seg as f32)
    }

    #[inline]
    pub fn point(&self, u: f32) -> Vec3 {
        let (s, t) = self.seg_and_t(u);
        self.segments[s].point(t)
    }

    #[inline]
    pub fn tangent(&self, u: f32) -> Vec3 {
        let (s, t) = self.seg_and_t(u);
        self.segments[s].derivative(t)
    }

    /// Full banked orientation frame at `u`.
    pub fn frame(&self, u: f32) -> Frame {
        let (s, t) = self.seg_and_t(u);
        let seg = &self.segments[s];

        let position = seg.point(t);
        let d1 = seg.derivative(t);
        let d2 = seg.second_derivative(t);

        let forward = normalize_or(d1, Vec3::Z);

        // Unbanked base frame, referenced to world up.
        let world_up = Vec3::Y;
        let mut right = forward.cross(world_up);
        if right.length_squared() < 1e-5 {
            // Track points (nearly) straight up — pick any stable reference.
            right = forward.cross(Vec3::X);
        }
        right = right.normalize();
        let up = right.cross(forward).normalize();

        // Bank into the curve. Signed curvature = lateral accel / speed^2, and
        // since `right` ⟂ `forward`, lateral·right == d2·right.
        let speed2 = d1.length_squared().max(1e-5);
        let signed_curv = d2.dot(right) / speed2;
        let bank = (signed_curv * BANK_FACTOR).clamp(-MAX_BANK, MAX_BANK);
        let roll = Quat::from_axis_angle(forward, bank);

        Frame {
            position,
            forward,
            right: (roll * right).normalize(),
            up: (roll * up).normalize(),
        }
    }

    // -- arc-length re-parameterization ------------------------------------

    fn build_lut(&mut self) {
        let n = self.segments.len();
        let mut lut = Vec::with_capacity(n * LUT_PER_SEG + 1);

        let mut prev_pos = self.segments[0].point(0.0);
        let mut cum = 0.0;
        lut.push(LutEntry { u: 0.0, pos: prev_pos, cum_len: 0.0 });

        for s in 0..n {
            for k in 1..=LUT_PER_SEG {
                let t = k as f32 / LUT_PER_SEG as f32;
                let pos = self.segments[s].point(t);
                cum += pos.distance(prev_pos);
                lut.push(LutEntry { u: s as f32 + t, pos, cum_len: cum });
                prev_pos = pos;
            }
        }

        self.total_length = cum;
        self.lut = lut;
    }

    /// Global parameter `u` at a given arc-length distance along the track.
    pub fn u_at_distance(&self, dist: f32) -> f32 {
        let total = self.total_length;
        let d = if self.closed {
            dist.rem_euclid(total)
        } else {
            dist.clamp(0.0, total)
        };

        // Binary search the cumulative-length column, then lerp `u`.
        let lut = &self.lut;
        let (mut lo, mut hi) = (0usize, lut.len() - 1);
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if lut[mid].cum_len < d {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (a, b) = (&lut[lo], &lut[hi]);
        let span = (b.cum_len - a.cum_len).max(1e-6);
        let f = ((d - a.cum_len) / span).clamp(0.0, 1.0);
        a.u + (b.u - a.u) * f
    }

    /// Banked frame at an arc-length distance (evenly spaced sampling).
    #[inline]
    pub fn frame_at_distance(&self, dist: f32) -> Frame {
        self.frame(self.u_at_distance(dist))
    }

    /// Where karts start the race (banked frame at the loop's origin).
    #[inline]
    pub fn start_frame(&self) -> Frame {
        self.frame(0.0)
    }

    // -- boost pads (Milestone 8) -------------------------------------------

    /// Place `count` boost pads evenly around the loop (offset half a spacing from
    /// the start line). Called once at build time. The longitudinal half-extent is
    /// derived from the local tangent (meters-per-unit-u) so a fixed metric pad
    /// length maps correctly into parameter space regardless of segment scale.
    fn place_boost_pads(&mut self, count: usize) {
        let total = self.total_length;
        let mut pads = Vec::with_capacity(count);
        for k in 0..count {
            let d = total * (k as f32 + 0.5) / count as f32;
            let u_center = self.u_at_distance(d);
            let mpu = self.tangent(u_center).length().max(1e-3); // meters per unit-u
            let u_half = (PAD_HALF_LEN / mpu).clamp(0.02, 0.45);
            pads.push(BoostPad {
                u_center,
                u_half,
                half_width: PAD_HALF_WIDTH,
                frame: self.frame(u_center),
            });
        }
        self.boost_pads = pads;
    }

    /// The boost pads on this circuit (renderer reads positions/frames).
    #[inline]
    pub fn boost_pads(&self) -> &[BoostPad] {
        &self.boost_pads
    }

    /// True when a point at spline parameter `track_u` with signed `lateral`
    /// offset lies on a boost pad. Pure O(pads) interval test in u-space — reuses
    /// the kart's existing ground-query outputs, adding no broadphase.
    pub fn boost_at(&self, track_u: f32, lateral: f32) -> bool {
        let n = self.segments.len() as f32;
        let u = track_u.rem_euclid(n);
        for p in &self.boost_pads {
            let mut d = (u - p.u_center).abs();
            d = d.min(n - d); // shortest distance around the closed loop
            if d <= p.u_half && lateral.abs() <= p.half_width {
                return true;
            }
        }
        false
    }

    // -- ground queries (physics) ------------------------------------------

    /// Project a world point onto the track with no prior knowledge (O(n) scan).
    /// Use for spawning / respawns; prefer [`Self::ground_query_hint`] per frame.
    pub fn ground_query(&self, p: Vec3) -> GroundInfo {
        let mut best = 0usize;
        let mut best_d = f32::INFINITY;
        for (i, e) in self.lut.iter().enumerate() {
            let d = e.pos.distance_squared(p);
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        self.ground_from_u(self.lut[best].u, p)
    }

    /// Project a world point onto the track, scanning only a small window of LUT
    /// samples around `hint_u` (the kart's last known `u`). Heap-free and O(1).
    pub fn ground_query_hint(&self, p: Vec3, hint_u: f32, window: usize) -> GroundInfo {
        let n = self.lut.len() as isize;
        let (seg, t) = self.seg_and_t(hint_u);
        let approx = ((seg as f32 + t) * LUT_PER_SEG as f32).round() as isize;

        let mut best = approx.rem_euclid(n) as usize;
        let mut best_d = f32::INFINITY;
        let w = window as isize;
        for off in -w..=w {
            let i = if self.closed {
                (approx + off).rem_euclid(n)
            } else {
                let v = approx + off;
                if v < 0 || v >= n {
                    continue;
                }
                v
            };
            let d = self.lut[i as usize].pos.distance_squared(p);
            if d < best_d {
                best_d = d;
                best = i as usize;
            }
        }
        self.ground_from_u(self.lut[best].u, p)
    }

    /// Refine an initial `u0` so the foot point is perpendicular to the track,
    /// then decompose the offset into lateral / height.
    fn ground_from_u(&self, u0: f32, p: Vec3) -> GroundInfo {
        let mut u = u0;
        // A couple of Newton-style slides along the tangent converge fast.
        for _ in 0..2 {
            let f = self.frame(u);
            let along = (p - f.position).dot(f.forward);
            let speed = self.tangent(u).length().max(1e-3);
            u += along / speed;
        }

        let f = self.frame(u);
        let rel = p - f.position;
        let lateral = rel.dot(f.right);
        let height = rel.dot(f.up);
        let clamped = lateral.clamp(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH);

        GroundInfo {
            u,
            center: f.position,
            surface: f.position + f.right * clamped,
            normal: f.up,
            right: f.right,
            forward: f.forward,
            lateral,
            height,
            on_road: lateral.abs() <= ROAD_HALF_WIDTH,
        }
    }
}

// ----------------------------------------------------------------------------
// Procedural road mesh
// ----------------------------------------------------------------------------

/// Reusable CPU-side vertex/index buffers. Build once, or call
/// [`generate_into`] repeatedly to regenerate without reallocating.
pub struct RoadMeshData {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u16>,
}

impl RoadMeshData {
    pub fn new() -> Self {
        Self { vertices: Vec::new(), indices: Vec::new() }
    }
}

impl Default for RoadMeshData {
    fn default() -> Self {
        Self::new()
    }
}

/// Max ring-to-ring spans per mesh chunk. macroquad's immediate-mode batcher
/// caps the size of a single `draw_mesh` call, so the circuit is split into a
/// few sub-meshes, each safely under that limit (48 spans -> 196 verts / 864
/// indices per chunk).
pub const CHUNK_RINGS: usize = 48;

/// Build the circuit as a list of mesh chunks — draw each with `draw_mesh`.
/// Assign a procedural road texture to a chunk's `texture` field if desired.
pub fn build_track_meshes(spline: &TrackSpline) -> Vec<Mesh> {
    let rings = spline.ring_count();
    let ring_len = spline.total_length() / rings as f32;
    let light = LIGHT_DIR.normalize();

    let mut meshes = Vec::new();
    let mut start = 0usize;
    while start < rings {
        let quads = CHUNK_RINGS.min(rings - start); // ring-to-ring spans here
        let mut verts: Vec<Vertex> = Vec::with_capacity((quads + 1) * 4);
        let mut indices: Vec<u16> = Vec::with_capacity(quads * 18);

        // One extra ring closes the chunk against the next without a seam; the
        // final chunk's closing ring lands at distance == total (== ring 0).
        for r in 0..=quads {
            let ring = start + r;
            let dist = ring as f32 * ring_len;
            push_ring(&mut verts, &spline.frame_at_distance(dist), dist, ring, light);
        }
        for r in 0..quads {
            let bi = (r * 4) as u16;
            let bj = ((r + 1) * 4) as u16;
            quad(&mut indices, bi, bi + 1, bj + 1, bj); // road surface
            quad(&mut indices, bi + 2, bi, bj, bj + 2); // left curb wall
            quad(&mut indices, bi + 1, bi + 3, bj + 3, bj + 1); // right curb wall
        }

        meshes.push(Mesh { vertices: verts, indices, texture: None });
        start += quads;
    }
    meshes
}

/// Fill `out` with the *entire* circuit as one buffer pair, reusing capacity.
/// Handy for collision/export; for rendering prefer [`build_track_meshes`],
/// which stays under macroquad's per-draw-call size limit.
///
/// Layout: 4 vertices per ring — road left/right edges plus the two curb tops.
/// Consecutive rings are stitched into the road surface and two curb walls; the
/// last ring wraps to the first so the loop closes seamlessly.
pub fn generate_into(spline: &TrackSpline, out: &mut RoadMeshData) {
    out.vertices.clear();
    out.indices.clear();

    let rings = spline.ring_count();
    let ring_len = spline.total_length() / rings as f32;
    let light = LIGHT_DIR.normalize();

    out.vertices.reserve(rings * 4);
    out.indices.reserve(rings * 18);

    for i in 0..rings {
        let dist = i as f32 * ring_len;
        push_ring(&mut out.vertices, &spline.frame_at_distance(dist), dist, i, light);
    }
    for i in 0..rings {
        let j = (i + 1) % rings; // wrap closes the loop
        let bi = (i * 4) as u16;
        let bj = (j * 4) as u16;
        quad(&mut out.indices, bi, bi + 1, bj + 1, bj);
        quad(&mut out.indices, bi + 2, bi, bj, bj + 2);
        quad(&mut out.indices, bi + 1, bi + 3, bj + 3, bj + 1);
    }
}

/// Append one cross-section ring (4 vertices) at `dist` along the track.
fn push_ring(verts: &mut Vec<Vertex>, f: &Frame, dist: f32, ring: usize, light: Vec3) {
    let v_uv = dist / UV_TILE;
    let l_edge = f.position - f.right * ROAD_HALF_WIDTH;
    let r_edge = f.position + f.right * ROAD_HALF_WIDTH;
    let l_top = l_edge + f.up * CURB_HEIGHT;
    let r_top = r_edge + f.up * CURB_HEIGHT;

    let road_col = shade(ROAD_COLOR, f.up, light);
    // Curbs alternate red/white per ring for the classic rumble-strip look.
    let curb_base = if ring % 2 == 0 { CURB_RED } else { CURB_WHITE };
    let l_curb = shade(curb_base, f.right, light); // inner face -> +right
    let r_curb = shade(curb_base, -f.right, light); // inner face -> -right

    verts.push(Vertex::new(l_edge.x, l_edge.y, l_edge.z, 0.0, v_uv, road_col));
    verts.push(Vertex::new(r_edge.x, r_edge.y, r_edge.z, 1.0, v_uv, road_col));
    verts.push(Vertex::new(l_top.x, l_top.y, l_top.z, 0.0, v_uv, l_curb));
    verts.push(Vertex::new(r_top.x, r_top.y, r_top.z, 1.0, v_uv, r_curb));
}

/// Emit two triangles for a quad with consistent winding a->b->c->d.
#[inline]
fn quad(indices: &mut Vec<u16>, a: u16, b: u16, c: u16, d: u16) {
    indices.extend_from_slice(&[a, b, c, a, c, d]);
}

/// Bake simple Lambert shading into a vertex color (no runtime lighting needed).
#[inline]
fn shade(base: Color, normal: Vec3, light: Vec3) -> Color {
    let d = normal.normalize().dot(light).max(0.0);
    let f = (AMBIENT + (1.0 - AMBIENT) * d).clamp(0.0, 1.0);
    Color::new(base.r * f, base.g * f, base.b * f, base.a)
}

// ----------------------------------------------------------------------------
// Free helpers
// ----------------------------------------------------------------------------

#[inline]
fn normalize_or(v: Vec3, fallback: Vec3) -> Vec3 {
    let len2 = v.length_squared();
    if len2 > 1e-12 {
        v / len2.sqrt()
    } else {
        fallback
    }
}

// ----------------------------------------------------------------------------
// Tests (pure math — run with `cargo test`, no window required)
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_loop_wraps_to_start() {
        let s = TrackSpline::demo_circuit();
        let start = s.point(0.0);
        let wrapped = s.point(s.segment_count() as f32); // u == n wraps to 0
        assert!(start.distance(wrapped) < 1e-3);
    }

    #[test]
    fn has_positive_length() {
        let s = TrackSpline::demo_circuit();
        assert!(s.total_length() > 100.0);
    }

    #[test]
    fn frame_is_orthonormal() {
        let s = TrackSpline::demo_circuit();
        let f = s.frame(2.3);
        assert!(f.forward.dot(f.right).abs() < 1e-3);
        assert!(f.forward.dot(f.up).abs() < 1e-3);
        assert!(f.right.dot(f.up).abs() < 1e-3);
        assert!((f.forward.length() - 1.0).abs() < 1e-3);
    }

    #[test]
    fn ground_query_recovers_centerline() {
        let s = TrackSpline::demo_circuit();
        let f = s.frame(2.3);
        let g = s.ground_query(f.position);
        assert!(g.on_road);
        assert!(g.lateral.abs() < 0.5);
        assert!(g.height.abs() < 0.5);
    }

    #[test]
    fn arc_length_sampling_is_even() {
        let s = TrackSpline::demo_circuit();
        let total = s.total_length();
        let a = s.frame_at_distance(0.0).position;
        let b = s.frame_at_distance(total * 0.25).position;
        // quarter-distance point should be meaningfully far from the start
        assert!(a.distance(b) > 10.0);
    }

    /// Every selectable circuit (M8) is a valid closed, orthonormal-framed loop
    /// over 100 m — the per-track DoD, run across the whole roster at once.
    #[test]
    fn all_tracks_are_valid_loops() {
        for make in [TrackSpline::demo_circuit, TrackSpline::speedway, TrackSpline::serpentine] {
            let s = make();
            assert!(s.total_length() > 100.0, "track too short: {}", s.total_length());
            // closed loop wraps to its start
            assert!(s.point(0.0).distance(s.point(s.segment_count() as f32)) < 1e-3);
            // banked frame stays orthonormal at an arbitrary parameter
            let f = s.frame(2.3);
            assert!(f.forward.dot(f.right).abs() < 1e-3);
            assert!(f.forward.dot(f.up).abs() < 1e-3);
            assert!(f.right.dot(f.up).abs() < 1e-3);
            assert!(s.boost_pads().len() >= 4, "need >=4 boost pads per lap");
        }
    }

    /// Boost-pad detection: on a pad when centered, off it when hugging the curb
    /// or sitting between pads. Pure parameter-space test (no sim needed).
    #[test]
    fn boost_pad_footprint_is_localized() {
        let s = TrackSpline::demo_circuit();
        let pads = s.boost_pads();
        let pad = pads[0];
        assert!(s.boost_at(pad.u_center, 0.0), "centered on a pad → detected");
        assert!(
            !s.boost_at(pad.u_center, pad.half_width + 2.0),
            "off to the side of the strip → not detected"
        );
        // Midway between the first two pads is clear of both.
        let mid = 0.5 * (pads[0].u_center + pads[1].u_center);
        assert!(!s.boost_at(mid, 0.0), "between pads → not detected");
    }
}
