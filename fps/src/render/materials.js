// PBR material library. Texture SYNTHESIS lives in ./textures.js; this file is
// the registry that turns those raw buffers into GPU textures + materials.
//
// Two things here matter more than anything else for realism:
//  1. Albedo is authored LINEAR and sRGB-ENCODED on write (textures.js
//     `encodeSRGB`). Writing linear reflectance straight into an sRGB-tagged
//     texture makes the GPU linearize it a second time — that double-darkening
//     is what crushed the first build to black.
//  2. ORM packing: R=occlusion G=roughness B=metalness in ONE texture. three
//     samples .r/.g/.b for aoMap/roughnessMap/metalnessMap, so a single upload
//     replaces three.

import * as THREE from 'three';
import * as T from './textures.js';

// Physical tile size in metres for each material. level.js scales mesh UVs by
// world dimensions / tileSize, so texel density is consistent no matter how big
// the brush is — mismatched density between adjacent surfaces reads as amateur
// faster than almost any other error.
export const TILE = {
  concreteFloor: 2.4, concreteWall: 3.0, asphalt: 4.0, paintedMetal: 2.0,
  corrugated: 1.8, rustedSteel: 2.0, brick: 2.4, plaster: 2.6, canvas: 1.4,
  wood: 2.0, chainlink: 1.2, glass: 2.0, rubber: 1.0, gravel: 3.0, tile: 2.0,
};

const tex = (data, size, { srgb = false, aniso = 16 } = {}) => {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
};

// Blend a high-frequency detail normal over the base normal in tangent space.
// MeshStandardMaterial has no second-normal slot, so patch the shader. Whiteout
// blending (sum xy, multiply z) is the standard trick — it preserves the base
// shape while letting fine grain survive at close range, which is exactly the
// case an FPS lives in (the player's face is 40 cm from a wall constantly).
function attachDetail(mat, detailTex, scale, strength) {
  mat.userData.detail = { tex: detailTex, scale, strength };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailMap = { value: detailTex };
    shader.uniforms.uDetailScale = { value: scale };
    shader.uniforms.uDetailStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailMap; uniform float uDetailScale, uDetailStrength;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 dN = texture2D(uDetailMap, vMapUv * uDetailScale).xyz * 2.0 - 1.0;
          dN.xy *= uDetailStrength;
          vec3 bN = normal;
          // whiteout blend in tangent space, then re-apply the TBN basis
          vec3 t = vec3(bN.xy + dN.xy, bN.z * dN.z);
          normal = normalize(mix(bN, normalize(t), 0.85));
        }`);
    mat.userData.shader = shader;
  };
  // Distinct key so three doesn't share a program with an unpatched material.
  mat.customProgramCacheKey = () => `detail${scale}_${strength}`;
}

// Low-frequency breakup for large surfaces. The authored UVs are in material-tile
// units, so `scale = TILE / P` puts one macro repeat every P metres of world.
//
// `opt.scale2` adds a SECOND tap of the same map at an incommensurate period.
// One tap alone still repeats — fine on a 5 m wall panel, not fine on the 72 m
// ground plane, where a 14 m period is visible as a grid of identical blotches.
// Two taps at non-integer-ratio periods beat together and the combined field has
// no visible period across the whole yard, for one extra texture fetch and zero
// extra texture memory. Both taps are zero-mean (see textures.macroVariation), so
// any weighted sum stays zero-mean and cannot shift average exposure.
//
// `opt.tint` lets the albedo response carry a slight warm/cool shift with value:
// dry dust deposits read warmer and lighter, damp/oiled ground cooler and darker.
// A pure luminance multiply is monochrome and reads as a lighting artefact.
function attachMacro(mat, macroTex, scale, strength = 0.18, opt = {}) {
  const { rough = 0.09, scale2 = 0, w1 = 1, w2 = 0, tint = [1, 1, 1] } = opt;
  mat.userData.macro = { tex: macroTex, scale, strength, ...opt };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroMap = { value: macroTex };
    shader.uniforms.uMacroScale = { value: scale };
    shader.uniforms.uMacroStrength = { value: strength };
    shader.uniforms.uMacroRough = { value: rough };
    shader.uniforms.uMacroTint = { value: new THREE.Vector3(...tint) };
    if (scale2) {
      shader.uniforms.uMacroScale2 = { value: scale2 };
      shader.uniforms.uMacroW = { value: new THREE.Vector2(w1, w2) };
    }
    // Offset the second tap so the two fields' feature centres never coincide.
    const second = scale2 ? `
        bpMacro = bpMacro * uMacroW.x + (texture2D(uMacroMap,
          vMapUv * uMacroScale2 + vec2(0.37, 0.71)).r * 2.0 - 1.0) * uMacroW.y;` : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uMacroMap; uniform vec3 uMacroTint;
        uniform float uMacroScale, uMacroStrength, uMacroRough;
        ${scale2 ? 'uniform float uMacroScale2; uniform vec2 uMacroW;' : ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float bpMacro = texture2D(uMacroMap, vMapUv * uMacroScale).r * 2.0 - 1.0;${second}
        diffuseColor.rgb *= 1.0 + bpMacro * uMacroStrength * uMacroTint;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + bpMacro * uMacroRough, 0.08, 1.0);`);
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => `macro${scale}_${strength}_${rough}_${scale2}_${w1}_${w2}_${tint}`;
}

// Per-material macro-breakup config, keyed by material name.
//  P  = primary macro period in metres, P2 = secondary (0 = single tap)
//  s  = albedo strength, r = roughness offset, w = tap weights, t = albedo tint
//
// Walls keep their original single 14 m tap: they are broken up by pilasters,
// capstones and props, and a wall is never seen at the 60 m extent the ground is.
// The ground gets much LARGER periods (27 m / 61 m) because the defect it fixes
// is precisely "one repeating frequency across a 72 x 62 m plane" — a breakup
// layer that itself repeats six times is just a second tile. The 27/61 pair
// yields soft regions ~3 m to ~20 m across, which is the scale at which real
// wheel paths, dust drift and standing-water staining actually vary.
const MACRO = {
  concreteWall: { P: 14, s: 0.22 },
  concreteFloor: { P: 14, s: 0.14 },
  plaster: { P: 14, s: 0.14 },
  brick: { P: 14, s: 0.14 },
  asphalt: { P: 27, P2: 61, s: 0.24, r: 0.16, w: [0.70, 0.52], t: [1.05, 1.0, 0.93] },
  asphaltLane: { P: 27, P2: 61, s: 0.24, r: 0.16, w: [0.70, 0.52], t: [1.05, 1.0, 0.93] },
  gravel: { P: 20, P2: 47, s: 0.20, r: 0.13, w: [0.70, 0.52], t: [1.06, 1.0, 0.92] },
};

// Detail-normal blending is opt-in while its tangent-space correctness is being
// verified — see attachDetail's note. ?detail=1 to enable.
const DETAIL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('detail') === '1';

export async function createMaterialLibrary({ renderer, rng }) {
  const seed = Math.floor(rng() * 1e9);
  const sunDir = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();
  const t0 = performance.now();

  // ---- environment / IBL -------------------------------------------------
  // Float equirect -> PMREM. This drives ALL ambient specular; without it PBR
  // surfaces read as flat plastic regardless of how good the albedo is.
  const skyData = T.skyEquirect(sunDir);
  const skyTex = new THREE.DataTexture(
    skyData.data, skyData.width, skyData.height, THREE.RGBAFormat, THREE.FloatType
  );
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  skyTex.colorSpace = THREE.LinearSRGBColorSpace;
  skyTex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(skyTex).texture;
  pmrem.dispose();
  skyTex.dispose();

  // ---- shared micro-detail ----------------------------------------------
  const det = T.detailNormal(seed + 900);
  const detailTex = tex(det.data, det.size);
  detailTex.anisotropy = 8;
  const macro = T.macroVariation(seed + 1200);
  // aniso 8, not 4: the macro map is now sampled on the ground plane, which is
  // seen at extreme grazing angles where an under-filtered low-frequency field
  // smears into visible bands along the view direction.
  const macroTex = tex(macro.data, macro.size, { aniso: 8 });

  // ---- material set ------------------------------------------------------
  // [generator, { metal, extra material params }]
  const DEFS = {
    concreteFloor: [() => T.concreteFloor(seed + 1, 512), {}],
    concreteWall: [() => T.concreteWall(seed + 2, 1024), {}],
    asphalt: [() => T.asphalt(seed + 3, 512, 0), {}],
    asphaltLane: [() => T.asphalt(seed + 4, 512, 1), {}],
    paintedMetal: [() => T.paintedMetal(seed + 5, 512), { metalness: 1 }],
    corrugated: [() => T.corrugated(seed + 6, 512), { metalness: 1 }],
    rustedSteel: [() => T.rustedSteel(seed + 7, 512), { metalness: 1 }],
    brick: [() => T.brick(seed + 8, 1024), {}],
    plaster: [() => T.plaster(seed + 9, 512), {}],
    canvas: [() => T.canvas(seed + 10, 512), {}],
    wood: [() => T.wood(seed + 11, 512), {}],
    chainlink: [() => T.chainlink(seed + 12, 512), {
      metalness: 1, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
    }],
    glass: [() => T.glass(seed + 13, 512), {
      metalness: 0, transparent: true, opacity: 0.28, roughness: 0.06,
    }],
    rubber: [() => T.rubber(seed + 14, 512), {}],
    gravel: [() => T.gravel(seed + 15, 512), {}],
    tile: [() => T.tile(seed + 16, 512), {}],
  };

  const cache = new Map();
  const owned = [];                    // every GPU resource we must dispose

  for (const [name, [gen, extra]] of Object.entries(DEFS)) {
    const g = gen();
    const albedo = tex(g.albedo, g.size, { srgb: true });
    const normal = tex(g.normal, g.size);
    const orm = tex(g.orm, g.size);
    owned.push(albedo, normal, orm);

    const m = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      aoMap: orm,                      // .r
      roughnessMap: orm,               // .g
      metalnessMap: orm,               // .b
      roughness: 1,                    // scalar multiplies the map — keep at 1
      metalness: extra.metalness ?? 1, // ditto; non-metal maps carry b=0
      aoMapIntensity: 1,
      // three adds getIBLIrradiance() (this PMREM env, scaled PI * envMapIntensity)
      // INTO the same `irradiance` accumulator hemisphere-light fill lands in
      // (lights_fragment_maps.glsl + lights_fragment_begin.glsl) — envMapIntensity
      // was pushed to 1.7 to fix shadow-side black-crush without realizing it was
      // stacking a second, MORE saturated sky term (zenith B:R ~8.8:1 vs the
      // hemisphere sky's own tint) on top of the hemisphere light at PI x the
      // multiplier. That double-counted, PI-amplified blue is the shadowed-trim
      // colour-cast root cause. Fill now lives in the hemisphere/bounce lights
      // (lighting.js) where it can be colour-balanced directly; this only needs to
      // cover indirect SPECULAR sheen, so it drops close to the physical default.
      envMapIntensity: 1.0,
      normalScale: new THREE.Vector2(1, 1),
      dithering: true,
      ...extra,
    });
    // aoMap defaults to UV channel 0 in modern three; be explicit so a future
    // uv1 on any geometry can't silently blank the occlusion.
    orm.channel = 0;

    const mc = MACRO[name];
    if (mc) {
      const tile = TILE[name] ?? 2;
      attachMacro(m, macroTex, tile / mc.P, mc.s, {
        rough: mc.r ?? 0.09,
        scale2: mc.P2 ? tile / mc.P2 : 0,
        w1: mc.w ? mc.w[0] : 1, w2: mc.w ? mc.w[1] : 0,
        tint: mc.t ?? [1, 1, 1],
      });
    } else if (DETAIL) attachDetail(m, detailTex, 9, 0.55);
    m.name = name;
    cache.set(name, m);
  }

  // Back-compat aliases for names the level/blockout already asks for.
  cache.set('concrete', cache.get('concreteFloor'));
  cache.set('metal', cache.get('paintedMetal'));

  const genMs = performance.now() - t0;
  console.log(`[materials] ${cache.size} materials, ${owned.length} textures, ${genMs.toFixed(0)} ms`);

  return {
    env, sunDir, TILE,
    genMs,
    get(name) {
      const m = cache.get(name);
      if (!m) throw new Error(`[materials] unknown material "${name}" (have: ${[...cache.keys()].join(', ')})`);
      return m;
    },
    has(name) { return cache.has(name); },
    tileOf(name) { return TILE[name] ?? 2.0; },
    list() { return [...cache.keys()]; },
    dispose() {
      for (const t of owned) t.dispose();
      detailTex.dispose();
      macroTex.dispose();
      for (const m of new Set(cache.values())) m.dispose();
      env.dispose();
      cache.clear();
    },
  };
}
