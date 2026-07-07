//! mesh_gen.rs — everything procedural: kart/wheel/item-box meshes, in-memory
//! textures, and a tiny pixel-font + icon set for the HUD.
//!
//! No external assets. Meshes are combined from primitives (box / cylinder /
//! sphere) into a single `Mesh` each, with simple Lambert lighting baked into
//! the vertex colors at build time (so no lighting shader is needed at runtime).
//!
//! Model space convention (shared with physics.rs / main.rs):
//!   +Z = forward,  +Y = up,  +X = right,  origin on the ground between wheels.
//! Wheels roll about the X axis (the axle).

use crate::combat::ChassisClass;
use macroquad::models::{Mesh, Vertex};
use macroquad::prelude::*;
use std::f32::consts::{PI, TAU};

/// Drift-spark colors, exposed so the HUD and particle system agree on them.
pub const BLUE_SPARK: Color = Color::new(0.30, 0.65, 1.00, 1.0);
pub const ORANGE_SPARK: Color = Color::new(1.00, 0.55, 0.10, 1.0);

/// A handful of body/accent color pairs to give the AI grid some variety.
pub const KART_PALETTE: [(Color, Color); 6] = [
    (Color::new(0.90, 0.15, 0.15, 1.0), Color::new(1.00, 0.85, 0.20, 1.0)), // red/yellow
    (Color::new(0.15, 0.45, 0.95, 1.0), Color::new(0.85, 0.95, 1.00, 1.0)), // blue/white
    (Color::new(0.15, 0.70, 0.30, 1.0), Color::new(0.05, 0.30, 0.12, 1.0)), // green
    (Color::new(0.85, 0.45, 0.85, 1.0), Color::new(1.00, 0.90, 1.00, 1.0)), // purple
    (Color::new(0.95, 0.55, 0.10, 1.0), Color::new(0.30, 0.18, 0.05, 1.0)), // orange
    (Color::new(0.10, 0.10, 0.12, 1.0), Color::new(0.80, 0.80, 0.85, 1.0)), // black/silver
];

// ============================================================================
// Mesh builder + primitives
// ============================================================================

/// Accumulates triangles for one model. Build with primitives, then `into_mesh`.
///
/// Vertices carry a model-space `normal` and an **unlit** base color (albedo).
/// Lighting is done on the GPU by the toon material ([`crate::shaders`]) — the
/// old baked-Lambert path is gone, so cel-shading has real normals to work with.
pub struct MeshBuilder {
    vertices: Vec<Vertex>,
    indices: Vec<u16>,
}

impl MeshBuilder {
    pub fn new() -> Self {
        Self {
            vertices: Vec::new(),
            indices: Vec::new(),
        }
    }

    pub fn into_mesh(self, texture: Option<Texture2D>) -> Mesh {
        debug_assert!(
            self.vertices.len() <= u16::MAX as usize,
            "model exceeds the u16 index range"
        );
        Mesh {
            vertices: self.vertices,
            indices: self.indices,
            texture,
        }
    }

    // -- low-level pushes ---------------------------------------------------

    /// Push a vertex carrying its model-space `normal` and unlit `base` albedo.
    #[inline]
    fn push_shaded(&mut self, pos: Vec3, normal: Vec3, uv: Vec2, base: Color) -> u16 {
        let idx = self.vertices.len() as u16;
        let mut v = Vertex::new(pos.x, pos.y, pos.z, uv.x, uv.y, base);
        v.normal = normal.normalize_or_zero().extend(0.0);
        self.vertices.push(v);
        idx
    }

    #[inline]
    fn push_raw(&mut self, pos: Vec3, uv: Vec2, color: Color) -> u16 {
        let idx = self.vertices.len() as u16;
        self.vertices.push(Vertex::new(pos.x, pos.y, pos.z, uv.x, uv.y, color));
        idx
    }

    /// Flat-shaded quad a->b->c->d.
    fn quad_flat(&mut self, a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, col: Color) {
        let i0 = self.push_shaded(a, n, vec2(0.0, 0.0), col);
        let i1 = self.push_shaded(b, n, vec2(1.0, 0.0), col);
        let i2 = self.push_shaded(c, n, vec2(1.0, 1.0), col);
        let i3 = self.push_shaded(d, n, vec2(0.0, 1.0), col);
        self.indices.extend_from_slice(&[i0, i1, i2, i0, i2, i3]);
    }

    /// Flat-shaded triangle.
    fn tri_flat(&mut self, a: Vec3, b: Vec3, c: Vec3, n: Vec3, col: Color) {
        let i0 = self.push_shaded(a, n, vec2(0.5, 0.0), col);
        let i1 = self.push_shaded(b, n, vec2(0.0, 1.0), col);
        let i2 = self.push_shaded(c, n, vec2(1.0, 1.0), col);
        self.indices.extend_from_slice(&[i0, i1, i2]);
    }

    /// Unlit, full-UV quad (for textured surfaces like the item box).
    fn quad_tex(&mut self, a: Vec3, b: Vec3, c: Vec3, d: Vec3, col: Color) {
        let i0 = self.push_raw(a, vec2(0.0, 0.0), col);
        let i1 = self.push_raw(b, vec2(1.0, 0.0), col);
        let i2 = self.push_raw(c, vec2(1.0, 1.0), col);
        let i3 = self.push_raw(d, vec2(0.0, 1.0), col);
        self.indices.extend_from_slice(&[i0, i1, i2, i0, i2, i3]);
    }

    // -- primitives ---------------------------------------------------------

    /// An axis-aligned box (in the part's local space) placed by `transform`.
    pub fn add_box(&mut self, transform: Mat4, half: Vec3, color: Color) {
        self.box_impl(transform, half, color, false);
    }

    /// Like [`add_box`], but unlit with per-face 0..1 UVs (for textures).
    pub fn add_box_unlit(&mut self, transform: Mat4, half: Vec3, color: Color) {
        self.box_impl(transform, half, color, true);
    }

    fn box_impl(&mut self, transform: Mat4, half: Vec3, color: Color, textured: bool) {
        let c = |sx: f32, sy: f32, sz: f32| {
            transform.transform_point3(vec3(sx * half.x, sy * half.y, sz * half.z))
        };
        let n = |v: Vec3| transform.transform_vector3(v).normalize();

        // 6 faces, each CCW from the outside.
        let faces: [([(f32, f32, f32); 4], Vec3); 6] = [
            ([(1., -1., -1.), (1., -1., 1.), (1., 1., 1.), (1., 1., -1.)], Vec3::X),
            ([(-1., -1., 1.), (-1., -1., -1.), (-1., 1., -1.), (-1., 1., 1.)], -Vec3::X),
            ([(-1., 1., -1.), (1., 1., -1.), (1., 1., 1.), (-1., 1., 1.)], Vec3::Y),
            ([(-1., -1., 1.), (1., -1., 1.), (1., -1., -1.), (-1., -1., -1.)], -Vec3::Y),
            ([(-1., -1., 1.), (1., -1., 1.), (1., 1., 1.), (-1., 1., 1.)], Vec3::Z),
            ([(1., -1., -1.), (-1., -1., -1.), (-1., 1., -1.), (1., 1., -1.)], -Vec3::Z),
        ];

        for (corners, normal) in faces {
            let p0 = c(corners[0].0, corners[0].1, corners[0].2);
            let p1 = c(corners[1].0, corners[1].1, corners[1].2);
            let p2 = c(corners[2].0, corners[2].1, corners[2].2);
            let p3 = c(corners[3].0, corners[3].1, corners[3].2);
            if textured {
                self.quad_tex(p0, p1, p2, p3, color);
            } else {
                self.quad_flat(p0, p1, p2, p3, n(normal), color);
            }
        }
    }

    /// A cylinder along the local Y axis (reorient via `transform`).
    pub fn add_cylinder(
        &mut self,
        transform: Mat4,
        radius: f32,
        half_h: f32,
        segments: usize,
        color: Color,
    ) {
        let tp = |v: Vec3| transform.transform_point3(v);
        let tn = |v: Vec3| transform.transform_vector3(v).normalize();

        let top_c = tp(vec3(0.0, half_h, 0.0));
        let bot_c = tp(vec3(0.0, -half_h, 0.0));
        let up = tn(Vec3::Y);
        let down = tn(-Vec3::Y);

        for i in 0..segments {
            let a0 = (i as f32 / segments as f32) * TAU;
            let a1 = ((i + 1) as f32 / segments as f32) * TAU;
            let am = (a0 + a1) * 0.5;
            let nside = tn(vec3(am.cos(), 0.0, am.sin()));

            let b0 = tp(vec3(radius * a0.cos(), -half_h, radius * a0.sin()));
            let b1 = tp(vec3(radius * a1.cos(), -half_h, radius * a1.sin()));
            let t0 = tp(vec3(radius * a0.cos(), half_h, radius * a0.sin()));
            let t1 = tp(vec3(radius * a1.cos(), half_h, radius * a1.sin()));

            self.quad_flat(b0, b1, t1, t0, nside, color); // side
            self.tri_flat(top_c, t0, t1, up, color); // top cap
            self.tri_flat(bot_c, b1, b0, down, color); // bottom cap
        }
    }

    /// A UV sphere (smooth-shaded), placed by `transform`.
    pub fn add_sphere(
        &mut self,
        transform: Mat4,
        r: f32,
        stacks: usize,
        slices: usize,
        color: Color,
    ) {
        let tp = |v: Vec3| transform.transform_point3(v);
        let tn = |v: Vec3| transform.transform_vector3(v).normalize();
        let pos = |phi: f32, th: f32| {
            vec3(r * phi.cos() * th.cos(), r * phi.sin(), r * phi.cos() * th.sin())
        };
        let nrm = |phi: f32, th: f32| vec3(phi.cos() * th.cos(), phi.sin(), phi.cos() * th.sin());

        for i in 0..stacks {
            let phi0 = -PI / 2.0 + PI * (i as f32 / stacks as f32);
            let phi1 = -PI / 2.0 + PI * ((i + 1) as f32 / stacks as f32);
            for j in 0..slices {
                let th0 = TAU * (j as f32 / slices as f32);
                let th1 = TAU * ((j + 1) as f32 / slices as f32);

                let i0 = self.push_shaded(tp(pos(phi0, th0)), tn(nrm(phi0, th0)), vec2(0.0, 0.0), color);
                let i1 = self.push_shaded(tp(pos(phi0, th1)), tn(nrm(phi0, th1)), vec2(1.0, 0.0), color);
                let i2 = self.push_shaded(tp(pos(phi1, th1)), tn(nrm(phi1, th1)), vec2(1.0, 1.0), color);
                let i3 = self.push_shaded(tp(pos(phi1, th0)), tn(nrm(phi1, th0)), vec2(0.0, 1.0), color);
                self.indices.extend_from_slice(&[i0, i1, i2, i0, i2, i3]);
            }
        }
    }
}

impl Default for MeshBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Composite models
// ============================================================================

/// A low-poly kart (chassis + driver + class cannon) in the model space
/// described above. Wheels are a separate mesh ([`build_wheel_mesh`]) instanced
/// at the corners.
pub fn build_kart_mesh(body: Color, accent: Color, class: ChassisClass) -> Mesh {
    let mut b = MeshBuilder::new();

    let dark = Color::new(0.12, 0.12, 0.14, 1.0);
    let gray = Color::new(0.30, 0.30, 0.33, 1.0);
    let skin = Color::new(0.95, 0.78, 0.60, 1.0);
    let overalls = Color::new(0.15, 0.35, 0.85, 1.0);

    let t = |x: f32, y: f32, z: f32| Mat4::from_translation(vec3(x, y, z));

    b.add_box(t(0.0, 0.18, 0.0), vec3(0.95, 0.08, 1.35), dark); // floor pan
    b.add_box(t(0.0, 0.45, 0.0), vec3(0.85, 0.28, 1.20), body); // chassis
    b.add_box(t(0.0, 0.42, 1.05), vec3(0.60, 0.16, 0.45), accent); // nose / hood
    b.add_box(t(0.0, 0.30, 1.50), vec3(0.70, 0.12, 0.12), accent); // front bumper
    b.add_box(t(0.0, 0.55, -1.05), vec3(0.70, 0.30, 0.35), gray); // rear engine
    b.add_box(t(0.92, 0.38, 0.0), vec3(0.12, 0.18, 0.70), accent); // side pod R
    b.add_box(t(-0.92, 0.38, 0.0), vec3(0.12, 0.18, 0.70), accent); // side pod L
    b.add_box(t(0.0, 0.62, -0.35), vec3(0.45, 0.28, 0.30), dark); // seat

    // Driver.
    b.add_box(t(0.0, 0.95, -0.10), vec3(0.30, 0.34, 0.28), overalls); // torso
    b.add_sphere(t(0.0, 1.45, -0.05), 0.28, 8, 10, skin); // head
    b.add_box(t(0.0, 1.62, -0.05), vec3(0.30, 0.10, 0.30), body); // cap

    // Steering wheel (a thin tilted disc).
    b.add_cylinder(
        t(0.0, 0.85, 0.45) * Mat4::from_rotation_x(1.2),
        0.16,
        0.03,
        12,
        dark,
    );

    // Twin exhaust pipes, tilted up at the back.
    for sx in [-0.45_f32, 0.45] {
        b.add_cylinder(
            Mat4::from_translation(vec3(sx, 0.70, -1.25)) * Mat4::from_rotation_x(0.5),
            0.06,
            0.25,
            8,
            gray,
        );
    }

    // The class-defining cannon — every chassis wears its weapon.
    add_cannon(&mut b, class, accent, gray, dark);

    b.into_mesh(None)
}

/// Bolt the chassis's signature cannon onto the kart. Pointed along +Z (forward)
/// except the Phantom's rear mine dispenser.
fn add_cannon(b: &mut MeshBuilder, class: ChassisClass, accent: Color, gray: Color, dark: Color) {
    // `from_rotation_x(PI/2)` maps a cylinder's local +Y axis onto +Z (forward).
    let fwd = Mat4::from_rotation_x(PI / 2.0);
    let glow = class_glow(class);
    match class {
        ChassisClass::Juggernaut => {
            // A fat mortar barrel on a turret base, tilted up to lob shells.
            b.add_box(Mat4::from_translation(vec3(0.0, 0.92, -0.1)), vec3(0.42, 0.22, 0.5), gray);
            let tilt = Mat4::from_translation(vec3(0.0, 1.18, 0.15))
                * Mat4::from_rotation_x(-0.35)
                * fwd;
            b.add_cylinder(tilt, 0.24, 0.55, 14, dark);
            b.add_cylinder(
                Mat4::from_translation(vec3(0.0, 1.34, 0.7)) * Mat4::from_rotation_x(-0.35) * fwd,
                0.28,
                0.10,
                14,
                glow,
            );
        }
        ChassisClass::Stinger => {
            // Twin slender laser emitters flanking the nose.
            for sx in [-0.32_f32, 0.32] {
                b.add_cylinder(
                    Mat4::from_translation(vec3(sx, 0.72, 0.9)) * fwd,
                    0.07,
                    0.45,
                    10,
                    accent,
                );
                b.add_cylinder(
                    Mat4::from_translation(vec3(sx, 0.72, 1.32)) * fwd,
                    0.10,
                    0.06,
                    10,
                    glow,
                );
            }
        }
        ChassisClass::Warden => {
            // A boxy missile launcher with a single guidance tube.
            b.add_box(Mat4::from_translation(vec3(0.0, 0.95, 0.1)), vec3(0.30, 0.20, 0.45), gray);
            b.add_cylinder(
                Mat4::from_translation(vec3(0.0, 1.02, 0.6)) * fwd,
                0.13,
                0.30,
                12,
                dark,
            );
            b.add_cylinder(
                Mat4::from_translation(vec3(0.0, 1.02, 0.9)) * fwd,
                0.15,
                0.05,
                12,
                glow,
            );
        }
        ChassisClass::Phantom => {
            // A rear drum that dispenses mines (axle along X, like a wheel).
            let lay = Mat4::from_translation(vec3(0.0, 0.78, -1.15)) * Mat4::from_rotation_z(PI / 2.0);
            b.add_cylinder(lay, 0.30, 0.42, 16, gray);
            b.add_cylinder(lay, 0.16, 0.46, 12, glow);
        }
    }
}

/// The emissive accent color for a class's cannon glow (matches combat FX).
fn class_glow(class: ChassisClass) -> Color {
    match class {
        ChassisClass::Juggernaut => Color::new(1.0, 0.60, 0.15, 1.0),
        ChassisClass::Stinger => Color::new(0.40, 0.95, 1.00, 1.0),
        ChassisClass::Warden => Color::new(0.75, 0.50, 1.00, 1.0),
        ChassisClass::Phantom => Color::new(0.40, 1.00, 0.55, 1.0),
    }
}

/// One wheel: dark tire + bright hub caps protruding on both sides. The cylinder
/// is rotated so its axle lies along X (matching the model convention).
pub fn build_wheel_mesh() -> Mesh {
    let mut b = MeshBuilder::new();
    let lay = Mat4::from_rotation_z(-PI / 2.0); // local Y axis -> X axle
    let tire = Color::new(0.06, 0.06, 0.07, 1.0);
    let hub = Color::new(0.85, 0.78, 0.30, 1.0);
    b.add_cylinder(lay, 0.38, 0.16, 16, tire);
    b.add_cylinder(lay, 0.17, 0.17, 12, hub); // slightly wider so caps show
    b.into_mesh(None)
}

/// A floating item box: a glowing, textured cube (rotate/pulse it in main.rs).
pub fn build_item_box_mesh(texture: Texture2D) -> Mesh {
    let mut b = MeshBuilder::new();
    b.add_box_unlit(Mat4::IDENTITY, vec3(0.6, 0.6, 0.6), WHITE);
    b.into_mesh(Some(texture))
}

/// An ammo crate: a bright energy core caged in a dark metal frame. Replaces the
/// Mario-Kart "?" box — this is shared ammunition the class cannons consume.
pub fn build_ammo_crate_mesh() -> Mesh {
    let mut b = MeshBuilder::new();
    let core = Color::new(0.55, 0.95, 1.00, 1.0); // glowing energy cell
    let frame = Color::new(0.16, 0.17, 0.20, 1.0); // dark metal cage
    b.add_box(Mat4::IDENTITY, vec3(0.42, 0.42, 0.42), core);
    add_cube_cage(&mut b, 0.6, 0.07, frame);
    b.into_mesh(None)
}

/// A boost pad (M8): a glowing plate with three forward-pointing chevrons. Built
/// in the road frame's local space (+Z forward, +X right, +Y up, lying flat) so
/// `main` can drop it onto the banked surface. Drawn with the crate-pulse
/// material, so it throbs in place.
pub fn build_boost_pad_mesh() -> Mesh {
    let half_w = crate::track_3d::PAD_HALF_WIDTH;
    let half_len = 4.0; // matches the pad footprint in track_3d
    let mut b = MeshBuilder::new();
    let plate = Color::new(0.10, 0.28, 0.45, 1.0);
    let glow = Color::new(0.35, 0.90, 1.00, 1.0);

    // Base plate, just above the road.
    b.add_box(Mat4::from_translation(vec3(0.0, 0.03, 0.0)), vec3(half_w, 0.03, half_len), plate);

    // Three chevrons (">>>") pointing forward (+Z): two angled arms each.
    let arm = vec3(0.30, 0.06, half_len * 0.42);
    for k in 0..3 {
        let zc = -half_len * 0.5 + k as f32 * (half_len * 0.5);
        b.add_box(
            Mat4::from_translation(vec3(-half_w * 0.42, 0.10, zc)) * Mat4::from_rotation_y(-0.7),
            arm,
            glow,
        );
        b.add_box(
            Mat4::from_translation(vec3(half_w * 0.42, 0.10, zc)) * Mat4::from_rotation_y(0.7),
            arm,
            glow,
        );
    }
    b.into_mesh(None)
}

/// Four projectile meshes in [`crate::combat::ProjKind`] index order
/// (Mortar, Laser, Dart, Mine). Built once, instanced per live projectile.
pub fn build_projectile_meshes() -> Vec<Mesh> {
    let mortar = {
        let mut b = MeshBuilder::new();
        b.add_sphere(Mat4::IDENTITY, 0.34, 8, 10, Color::new(0.20, 0.20, 0.23, 1.0));
        b.add_sphere(Mat4::from_scale(Vec3::splat(0.6)), 0.34, 6, 8, class_glow(ChassisClass::Juggernaut));
        b.into_mesh(None)
    };
    let laser = {
        let mut b = MeshBuilder::new();
        // A bright bolt elongated along +Z (oriented to velocity at draw time).
        b.add_box(Mat4::IDENTITY, vec3(0.08, 0.08, 0.55), class_glow(ChassisClass::Stinger));
        b.into_mesh(None)
    };
    let dart = {
        let mut b = MeshBuilder::new();
        let c = class_glow(ChassisClass::Warden);
        b.add_box(Mat4::from_translation(vec3(0.0, 0.0, -0.1)), vec3(0.07, 0.07, 0.28), c);
        // Faceted nose cone pointing +Z.
        let tip = vec3(0.0, 0.0, 0.42);
        for k in 0..4 {
            let a0 = k as f32 / 4.0 * TAU;
            let a1 = (k + 1) as f32 / 4.0 * TAU;
            let r = 0.12;
            let p0 = vec3(r * a0.cos(), r * a0.sin(), 0.18);
            let p1 = vec3(r * a1.cos(), r * a1.sin(), 0.18);
            let n = (p0 + p1) * 0.5 + tip * 0.0;
            b.tri_flat(tip, p1, p0, n.normalize_or_zero(), c);
        }
        b.into_mesh(None)
    };
    let mine = {
        let mut b = MeshBuilder::new();
        let body = class_glow(ChassisClass::Phantom);
        let dark = Color::new(0.10, 0.14, 0.10, 1.0);
        b.add_sphere(Mat4::from_scale(vec3(1.0, 0.55, 1.0)), 0.30, 6, 10, body);
        // Trigger spikes.
        for k in 0..4 {
            let a = k as f32 / 4.0 * TAU;
            let dir = vec3(a.cos(), 0.0, a.sin());
            b.add_box(
                Mat4::from_translation(dir * 0.3 + vec3(0.0, 0.05, 0.0)),
                vec3(0.05, 0.05, 0.12),
                dark,
            );
        }
        b.into_mesh(None)
    };
    vec![mortar, laser, dart, mine]
}

/// Add the 12 edge bars of a cube of half-extent `half`, each a thin box of
/// half-thickness `bar`.
fn add_cube_cage(b: &mut MeshBuilder, half: f32, bar: f32, color: Color) {
    let t = |x: f32, y: f32, z: f32| Mat4::from_translation(vec3(x, y, z));
    for &sy in &[-half, half] {
        for &sz in &[-half, half] {
            b.add_box(t(0.0, sy, sz), vec3(half, bar, bar), color); // edges along X
        }
    }
    for &sx in &[-half, half] {
        for &sz in &[-half, half] {
            b.add_box(t(sx, 0.0, sz), vec3(bar, half, bar), color); // edges along Y
        }
    }
    for &sx in &[-half, half] {
        for &sy in &[-half, half] {
            b.add_box(t(sx, sy, 0.0), vec3(bar, bar, half), color); // edges along Z
        }
    }
}

// ============================================================================
// Procedural textures (generated into memory at startup)
// ============================================================================

/// A square checkerboard texture (start/finish banner, debug surfaces).
pub fn gen_checker(size: u16, tiles: u16, a: Color, b: Color) -> Texture2D {
    let mut img = Image::gen_image_color(size, size, a);
    let cell = (size / tiles.max(1)).max(1);
    for y in 0..size {
        for x in 0..size {
            let cx = (x / cell) % 2;
            let cy = (y / cell) % 2;
            let col = if (cx + cy) % 2 == 0 { a } else { b };
            img.set_pixel(x as u32, y as u32, col);
        }
    }
    let tex = Texture2D::from_image(&img);
    tex.set_filter(FilterMode::Nearest);
    tex
}

/// A vertical top->bottom gradient (great as a sky backdrop).
pub fn gen_vertical_gradient(w: u16, h: u16, top: Color, bottom: Color) -> Texture2D {
    let mut img = Image::gen_image_color(w, h, top);
    let denom = (h.max(2) - 1) as f32;
    for y in 0..h {
        let f = y as f32 / denom;
        let c = lerp_color(top, bottom, f);
        for x in 0..w {
            img.set_pixel(x as u32, y as u32, c);
        }
    }
    let tex = Texture2D::from_image(&img);
    tex.set_filter(FilterMode::Linear);
    tex
}

/// Convenience sky gradient.
pub fn gen_sky_gradient(w: u16, h: u16) -> Texture2D {
    gen_vertical_gradient(
        w,
        h,
        Color::new(0.35, 0.65, 1.00, 1.0), // zenith blue
        Color::new(0.85, 0.93, 1.00, 1.0), // horizon haze
    )
}

/// The classic rainbow "?" item box face.
pub fn gen_item_box_texture(size: u16) -> Texture2D {
    let mut img = Image::gen_image_color(size, size, WHITE);
    let denom = (2 * size).max(1) as f32;
    for y in 0..size {
        for x in 0..size {
            let h = ((x as f32 + y as f32) / denom) * 360.0;
            img.set_pixel(x as u32, y as u32, hsv_to_rgb(h, 0.55, 1.0));
        }
    }
    // Centered "?" glyph.
    let scale = (size / 10).max(1) as i32;
    let gw = GLYPH_W as i32 * scale;
    let gh = GLYPH_H as i32 * scale;
    blit_glyph(
        &mut img,
        glyph('?'),
        (size as i32 - gw) / 2,
        (size as i32 - gh) / 2,
        scale,
        WHITE,
    );
    let tex = Texture2D::from_image(&img);
    tex.set_filter(FilterMode::Linear);
    tex
}

// ============================================================================
// HUD: procedural 5x7 pixel font
// ============================================================================

const GLYPH_W: usize = 5;
const GLYPH_H: usize = 7;

/// Draw `text` as crisp pixel blocks. `scale` is the size of one font pixel.
pub fn draw_pixel_text(text: &str, x: f32, y: f32, scale: f32, color: Color) {
    let mut cx = x;
    for ch in text.chars() {
        let g = glyph(ch);
        for row in 0..GLYPH_H {
            let bits = g[row];
            for col in 0..GLYPH_W {
                if bits & (1u8 << (GLYPH_W - 1 - col)) != 0 {
                    draw_rectangle(cx + col as f32 * scale, y + row as f32 * scale, scale, scale, color);
                }
            }
        }
        cx += (GLYPH_W as f32 + 1.0) * scale;
    }
}

/// Pixel width of `text` at `scale` (for right-/center-aligning the HUD).
pub fn pixel_text_width(text: &str, scale: f32) -> f32 {
    text.chars().count() as f32 * (GLYPH_W as f32 + 1.0) * scale
}

/// Stamp one glyph into an image (used to bake the "?" into the item texture).
fn blit_glyph(img: &mut Image, g: [u8; 7], x0: i32, y0: i32, scale: i32, color: Color) {
    let (w, h) = (img.width as i32, img.height as i32);
    for row in 0..GLYPH_H {
        for col in 0..GLYPH_W {
            if g[row] & (1u8 << (GLYPH_W - 1 - col)) == 0 {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    let px = x0 + col as i32 * scale + dx;
                    let py = y0 + row as i32 * scale + dy;
                    if px >= 0 && py >= 0 && px < w && py < h {
                        img.set_pixel(px as u32, py as u32, color);
                    }
                }
            }
        }
    }
}

/// 5x7 bitmaps. Each row uses the low 5 bits; bit 4 (0b10000) is the left column.
/// Unknown characters render as blank. Easy to extend — just add a match arm.
fn glyph(c: char) -> [u8; 7] {
    match c.to_ascii_uppercase() {
        '0' => [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        '2' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
        '3' => [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
        '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        '5' => [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        '6' => [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
        'A' => [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'B' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
        'C' => [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
        'D' => [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
        'E' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
        'F' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
        'G' => [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
        'H' => [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'I' => [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        'J' => [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
        'K' => [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
        'L' => [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
        'M' => [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
        'N' => [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
        'O' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        'P' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
        'Q' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
        'R' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
        'S' => [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
        'T' => [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
        'U' => [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        'V' => [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
        'W' => [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
        'X' => [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
        'Y' => [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
        'Z' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
        ':' => [0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000],
        '/' => [0b00001, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000],
        '-' => [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
        '.' => [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00100, 0b00100],
        '!' => [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
        '?' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b00000, 0b00100],
        _ => [0; 7], // space + unknowns
    }
}

// ============================================================================
// HUD: procedural icons (immediate-mode 2D shapes)
// ============================================================================

#[derive(Clone, Copy)]
pub enum HudIcon {
    Mushroom,
    Coin,
    GreenShell,
    Boost,
}

/// Draw a HUD icon centered at (cx, cy) roughly `size` pixels tall.
pub fn draw_hud_icon(icon: HudIcon, cx: f32, cy: f32, size: f32) {
    match icon {
        HudIcon::Mushroom => draw_mushroom(cx, cy, size),
        HudIcon::Coin => draw_coin(cx, cy, size * 0.5),
        HudIcon::GreenShell => draw_green_shell(cx, cy, size * 0.5),
        HudIcon::Boost => draw_boost_spark(cx, cy, size * 0.5, ORANGE_SPARK),
    }
}

fn draw_mushroom(cx: f32, cy: f32, size: f32) {
    let stem_w = size * 0.5;
    let stem_h = size * 0.45;
    draw_rectangle(cx - stem_w * 0.5, cy, stem_w, stem_h, Color::new(0.96, 0.93, 0.80, 1.0));
    draw_circle(cx, cy, size * 0.55, Color::new(0.90, 0.15, 0.15, 1.0)); // cap
    draw_circle(cx - size * 0.22, cy - size * 0.12, size * 0.12, WHITE); // spots
    draw_circle(cx + size * 0.20, cy - size * 0.18, size * 0.10, WHITE);
    draw_circle(cx + size * 0.02, cy - size * 0.32, size * 0.09, WHITE);
}

fn draw_coin(cx: f32, cy: f32, r: f32) {
    draw_circle(cx, cy, r, Color::new(1.0, 0.84, 0.18, 1.0));
    draw_circle_lines(cx, cy, r, r * 0.18, Color::new(0.75, 0.55, 0.05, 1.0));
}

fn draw_green_shell(cx: f32, cy: f32, r: f32) {
    draw_circle(cx, cy, r, Color::new(0.15, 0.75, 0.30, 1.0));
    draw_poly_lines(cx, cy, 6, r * 0.7, 0.0, r * 0.14, Color::new(0.05, 0.30, 0.12, 1.0));
    draw_circle_lines(cx, cy, r, r * 0.16, Color::new(0.05, 0.30, 0.12, 1.0));
}

/// A four-point burst — also used to render the drift-spark HUD pip; pass
/// [`BLUE_SPARK`] / [`ORANGE_SPARK`] for the two mini-turbo stages.
pub fn draw_boost_spark(cx: f32, cy: f32, size: f32, color: Color) {
    draw_poly(cx, cy, 4, size, 45.0, color);
    draw_poly(cx, cy, 4, size * 0.6, 0.0, Color::new(1.0, 1.0, 1.0, 0.9));
}

// ============================================================================
// Color helpers
// ============================================================================

#[inline]
fn lerp_color(a: Color, b: Color, t: f32) -> Color {
    Color::new(
        a.r + (b.r - a.r) * t,
        a.g + (b.g - a.g) * t,
        a.b + (b.b - a.b) * t,
        a.a + (b.a - a.a) * t,
    )
}

/// HSV (h in degrees, s/v in 0..1) -> RGBA Color.
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> Color {
    let h = h.rem_euclid(360.0) / 60.0;
    let c = v * s;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    Color::new(r + m, g + m, b + m, 1.0)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_has_expected_geometry() {
        let mut b = MeshBuilder::new();
        b.add_box(Mat4::IDENTITY, vec3(1.0, 1.0, 1.0), WHITE);
        assert_eq!(b.vertices.len(), 24); // 6 faces * 4 verts
        assert_eq!(b.indices.len(), 36); // 6 faces * 2 tris * 3
    }

    #[test]
    fn kart_mesh_within_index_range() {
        let m = build_kart_mesh(RED, YELLOW, ChassisClass::Juggernaut);
        assert!(!m.vertices.is_empty());
        assert!(m.vertices.len() <= u16::MAX as usize);
        assert_eq!(m.indices.len() % 3, 0);
    }

    #[test]
    fn glyph_digit_zero_is_nonblank() {
        assert!(glyph('0').iter().any(|&row| row != 0));
        assert_eq!(glyph(' '), [0; 7]);
    }

    #[test]
    fn hsv_primaries() {
        let red = hsv_to_rgb(0.0, 1.0, 1.0);
        assert!(red.r > 0.99 && red.g < 0.01 && red.b < 0.01);
        let green = hsv_to_rgb(120.0, 1.0, 1.0);
        assert!(green.g > 0.99 && green.r < 0.01);
    }
}
