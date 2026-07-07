//! shaders.rs — Milestone 4: the stylized look, via custom GLSL materials.
//!
//! Three procedural materials (no textures, no external assets), built on
//! macroquad 0.4.14's `load_material` / `ShaderSource::Glsl`:
//!
//!   * [`Shaders::toon`] — cel/toon shading for karts & projectiles: Lambert
//!     quantized into hard bands plus a fresnel rim light. Reads the mesh's
//!     model-space `normal` (now populated by [`crate::mesh_gen`]) and unlit
//!     vertex-color albedo.
//!   * [`Shaders::road`] — procedural value-noise asphalt grain over the
//!     baked-lit road color, keyed off world-space position.
//!   * [`Shaders::crate_pulse`] — GPU vertex displacement + emissive pulse for
//!     the energy crates, driven by the built-in `_Time` uniform (so the
//!     zero-allocation CPU loop is never touched).
//!
//! ## macroquad shader contract (verified against 0.4.14 source)
//! The 3D mesh pipeline binds attributes `position` (vec3), `texcoord` (vec2),
//! `color0` (Byte4 → divide by 255), `normal` (vec4). Every pipeline also gets
//! the built-in uniforms `Model` (mat4), `Projection` (mat4) and `_Time` (vec4,
//! `.x` = elapsed seconds), auto-updated each frame. GLSL ES `#version 100`.

use macroquad::prelude::*;

/// Light direction for the toon/crate materials (was the mesh bake direction, so
/// karts and the road read consistently lit).
pub const LIGHT_DIR: Vec3 = Vec3::new(-0.40, 1.0, 0.30);

/// The loaded material set. Each is `None` if its shader failed to compile, in
/// which case that draw group falls back to macroquad's default material rather
/// than crashing — GPU compilation can't be checked offline, so degrade safely.
pub struct Shaders {
    toon: Option<Material>,
    road: Option<Material>,
    crate_pulse: Option<Material>,
}

impl Shaders {
    /// Compile & link the materials on the GPU. Must be called after the
    /// window/GL context exists (i.e. inside `#[macroquad::main]`).
    pub fn load() -> Self {
        let toon = try_load(
            "toon",
            TOON_VERT,
            TOON_FRAG,
            vec![
                UniformDesc::new("LightDir", UniformType::Float4),
                UniformDesc::new("CamPos", UniformType::Float4),
            ],
        );
        let road = try_load("road", ROAD_VERT, ROAD_FRAG, vec![]);
        let crate_pulse = try_load(
            "crate",
            CRATE_VERT,
            CRATE_FRAG,
            vec![UniformDesc::new("LightDir", UniformType::Float4)],
        );

        let s = Shaders { toon, road, crate_pulse };
        s.set_light(LIGHT_DIR);
        s
    }

    /// Push the (constant) light direction into the materials that light.
    pub fn set_light(&self, dir: Vec3) {
        let d = dir.normalize_or_zero();
        let v = vec4(d.x, d.y, d.z, 0.0);
        if let Some(m) = &self.toon {
            m.set_uniform("LightDir", v);
        }
        if let Some(m) = &self.crate_pulse {
            m.set_uniform("LightDir", v);
        }
    }

    /// Update the per-frame camera position (drives the toon rim light).
    pub fn set_camera(&self, eye: Vec3) {
        if let Some(m) = &self.toon {
            m.set_uniform("CamPos", vec4(eye.x, eye.y, eye.z, 0.0));
        }
    }

    /// Bind a draw group's material (or the default if it didn't compile).
    pub fn use_toon(&self) {
        bind(&self.toon);
    }
    pub fn use_road(&self) {
        bind(&self.road);
    }
    pub fn use_crate(&self) {
        bind(&self.crate_pulse);
    }
}

/// Bind `m`, or fall back to the default material when the shader is absent.
fn bind(m: &Option<Material>) {
    match m {
        Some(mat) => gl_use_material(mat),
        None => gl_use_default_material(),
    }
}

fn try_load(name: &str, vertex: &str, fragment: &str, uniforms: Vec<UniformDesc>) -> Option<Material> {
    match load_material(
        ShaderSource::Glsl { vertex, fragment },
        MaterialParams { uniforms, ..Default::default() },
    ) {
        Ok(m) => Some(m),
        Err(e) => {
            eprintln!("[shaders] '{name}' failed to compile; using flat shading. {e:?}");
            None
        }
    }
}

// ----------------------------------------------------------------------------
// GLSL ES 100 sources
// ----------------------------------------------------------------------------

const TOON_VERT: &str = r#"#version 100
precision highp float;
attribute vec3 position;
attribute vec4 color0;
attribute vec4 normal;

varying lowp vec4 color;
varying vec3 world_normal;
varying vec3 world_pos;

uniform mat4 Model;
uniform mat4 Projection;

void main() {
    vec4 wp = Model * vec4(position, 1.0);
    world_pos = wp.xyz;
    world_normal = normalize((Model * vec4(normal.xyz, 0.0)).xyz);
    color = color0 / 255.0;
    gl_Position = Projection * wp;
}
"#;

const TOON_FRAG: &str = r#"#version 100
precision highp float;
varying lowp vec4 color;
varying vec3 world_normal;
varying vec3 world_pos;

uniform vec4 LightDir;
uniform vec4 CamPos;

void main() {
    vec3 N = normalize(world_normal);
    vec3 L = normalize(LightDir.xyz);
    float ndl = max(dot(N, L), 0.0);

    // Hard toon bands.
    float band = ndl > 0.66 ? 1.0 : (ndl > 0.33 ? 0.72 : 0.48);
    vec3 base = color.rgb * band;

    // Fresnel rim light toward the camera — the cartoon "pop".
    vec3 V = normalize(CamPos.xyz - world_pos);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 lit = base + vec3(1.0) * rim * 0.35;

    gl_FragColor = vec4(lit, color.a);
}
"#;

const ROAD_VERT: &str = r#"#version 100
precision highp float;
attribute vec3 position;
attribute vec4 color0;

varying lowp vec4 color;
varying vec3 world_pos;

uniform mat4 Model;
uniform mat4 Projection;

void main() {
    vec4 wp = Model * vec4(position, 1.0);
    world_pos = wp.xyz;
    color = color0 / 255.0;
    gl_Position = Projection * wp;
}
"#;

const ROAD_FRAG: &str = r#"#version 100
precision highp float;
varying lowp vec4 color;
varying vec3 world_pos;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec2 p = world_pos.xz;
    // A few octaves of value noise → asphalt speckle / curb wear.
    float n = vnoise(p * 0.7) * 0.6 + vnoise(p * 3.1) * 0.3 + vnoise(p * 11.0) * 0.1;
    float grain = 0.82 + 0.36 * n;
    gl_FragColor = vec4(color.rgb * grain, color.a);
}
"#;

const CRATE_VERT: &str = r#"#version 100
precision highp float;
attribute vec3 position;
attribute vec4 color0;
attribute vec4 normal;

varying lowp vec4 color;
varying vec3 world_normal;

uniform mat4 Model;
uniform mat4 Projection;
uniform vec4 _Time;

void main() {
    // Breathe along the surface normal — pure GPU vertex displacement.
    float pulse = sin(_Time.x * 4.0 + position.y * 3.0) * 0.06;
    vec3 displaced = position + normal.xyz * pulse;
    vec4 wp = Model * vec4(displaced, 1.0);
    world_normal = normalize((Model * vec4(normal.xyz, 0.0)).xyz);
    color = color0 / 255.0;
    gl_Position = Projection * wp;
}
"#;

const CRATE_FRAG: &str = r#"#version 100
precision highp float;
varying lowp vec4 color;
varying vec3 world_normal;

uniform vec4 LightDir;
uniform vec4 _Time;

void main() {
    vec3 N = normalize(world_normal);
    float ndl = max(dot(N, normalize(LightDir.xyz)), 0.0);
    float band = ndl > 0.5 ? 1.0 : 0.6;
    float glow = 0.78 + 0.22 * sin(_Time.x * 5.0);
    gl_FragColor = vec4(color.rgb * band * glow, color.a);
}
"#;
