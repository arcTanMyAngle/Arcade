// BP-15 simulation + procedural first-person viewmodel.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, damp, springDamp } from '../core/mathx.js';
import { W, RELOAD, SPREAD, PATTERN, RECOIL, POSE, ANIM, VM_LAYER } from './tuning.js';

const ease = (t) => t * t * (3 - 2 * t);

function buildViewmodel(scene, camera) {
  const root = new THREE.Group();
  root.name = 'viewmodel.bp15';
  root.scale.setScalar(0.66);
  camera.add(root);
  if (!camera.parent) scene.add(camera);

  const owned = [];

  // --------------------------------------------------------------------------
  // Material response. A service carbine is anodised aluminium, phosphated steel
  // and glass-filled polymer: dark albedo, HIGH roughness, and an env weight at
  // parity with the level (1.7 there is compensating for a dark scene; a weapon
  // filling a third of the screen must not double-count the sky). Low-roughness
  // bright metal is reserved for parts smaller than a thumbnail — bolt face,
  // pins, latch — where a hot glint reads as a machined detail and not a mirror.
  // --------------------------------------------------------------------------
  const std = (o) => { const m = new THREE.MeshStandardMaterial({ dithering: true, ...o }); owned.push(m); return m; };

  // Procedural surface breakup. Uniform roughness across a whole weapon is the
  // "CG plastic" tell critic.md names. Three terms, all evaluated in OBJECT space
  // so the feature size is metric and independent of each part's UV layout:
  //
  //   mottle  — 2-octave value noise, ~4 cm and ~1.2 cm features. Deliberately
  //             LOW frequency: micro-noise on a viewmodel that renders after TAA
  //             would shimmer, and shimmer costs more than it buys.
  //   streak  — the same field stretched along local Z, so anodised extrusions
  //             (rail, receiver, handguard) brush along the bore and the flats
  //             stop sharing one mirror-smooth specular response.
  //   wear    — PATCHES, not a gradient. Only the top decile of the noise field
  //             rubs through, biased toward upward-facing faces. Applying wear to
  //             every up-facing texel instead just re-lights the whole receiver
  //             deck as one hot plate, which is the defect we came here to kill.
  //   bump    — the same field re-read as a height, turned into a normal with
  //             Mikkelsen's tangent-free screen-derivative trick. `bump` is in
  //             METRES of relief, so the number is a physical claim: 2 mm over a
  //             2 cm feature is a casting/blast texture, not a dent. Roughness
  //             and tint alone are nearly invisible on an albedo this dark — the
  //             normal is what actually stops the flats reading as one smooth
  //             gradient. Low frequency on purpose: this pass runs after TAA, so
  //             anything near texel size would shimmer with nothing to filter it.
  //
  // Cost: ~35 ALU on viewmodel fragments only; one program per distinct tuple.
  const NOISE = `
varying vec3 vBpP;
float bpH(vec3 p){return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453);}
float bpN(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(mix(bpH(i),bpH(i+vec3(1,0,0)),f.x),mix(bpH(i+vec3(0,1,0)),bpH(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(bpH(i+vec3(0,0,1)),bpH(i+vec3(1,0,1)),f.x),mix(bpH(i+vec3(0,1,1)),bpH(i+vec3(1,1,1)),f.x),f.y),f.z);}`;
  const F = (n) => n.toFixed(3);
  const grain = (mat, { s = 20, streak = 1, rough = 0.20, tint = 0.24, wear = 0, bump = 0, rim = 0 } = {}) => {
    const key = `bpvm:${s}:${streak}:${rough}:${tint}:${wear}:${bump}:${rim}`;
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBpP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBpP = transformed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>${NOISE}`)
        // map_fragment runs before roughness/metalness, so the field is sampled
        // once here and reused; `diffuseColor` is the F0 tint for the metals.
        .replace('#include <map_fragment>', `#include <map_fragment>
{vec3 q=vBpP*${F(s)};q.z/=${F(streak)};
 bpG=bpN(q)*.62+bpN(q*3.3+7.0)*.38;
 bpW=${F(wear)}*smoothstep(0.66,0.92,bpG)*(0.35+0.65*max(vNormal.y,0.0));
 diffuseColor.rgb*=(1.0+(bpG-0.5)*${F(tint)})*(1.0+bpW*0.9);}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
 roughnessFactor=clamp(roughnessFactor+(bpG-0.5)*${F(rough)}-bpW*0.16,0.06,1.0);`)
        // Declared ahead of the first chunk that writes them.
        .replace('void main() {', 'void main() {\n\tfloat bpG=0.5, bpW=0.0;');
      if (bump > 0) sh.fragmentShader = sh.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{vec3 P=-vViewPosition,dx=dFdx(P),dy=dFdy(P);
 vec3 r1=cross(dy,normal),r2=cross(normal,dx);float det=dot(dx,r1);
 vec3 g=sign(det)*(dFdx(bpG)*r1+dFdy(bpG)*r2);
 normal=normalize(abs(det)*normal-${F(bump)}*g);}`);
      // Grazing-angle sky reflection on a near-vertical flank is physically real,
      // but the split-sum environment BRDF hands the whole lobe back at FULL
      // CHROMA, so a clear blue sky paints a saturated blue stripe down every
      // silhouette edge of the receiver. Real microfacet shadowing at grazing
      // incidence both attenuates that lobe and smears it across the hemisphere,
      // which desaturates it. Fold the grazing part toward its own luminance and
      // dim it: the edge keeps a sheen, it stops being a blue outline. Applied
      // only to the metals — the polymer and fabric never showed the artefact.
      if (rim > 0) sh.fragmentShader = sh.fragmentShader
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{float bpF=pow(1.0-clamp(dot(geometryNormal,geometryViewDir),0.0,1.0),3.0);
 vec3 bpS=reflectedLight.indirectSpecular;
 reflectedLight.indirectSpecular=mix(bpS,mix(bpS,vec3(dot(bpS,vec3(0.2126,0.7152,0.0722))),0.88)*${F(1 - rim)},bpF);}`);
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  };

  // Hard-anodised aluminium upper/lower. Broad dim sheen, not a mirror.
  const recv = grain(std({ color: 0x393937, metalness: 0.78, roughness: 0.60, envMapIntensity: 0.95 }),
    { s: 34, streak: 4, rough: 0.22, tint: 0.30, wear: 0.55, bump: 0.0022, rim: 0.62 });
  // Rail extrusion: same anodise, bead-blasted flatter so the receiver flat and
  // the rail flat never share one specular response.
  const rail = grain(std({ color: 0x2f302d, metalness: 0.82, roughness: 0.69, envMapIntensity: 0.92 }),
    { s: 42, streak: 7, rough: 0.26, tint: 0.32, wear: 0.60, bump: 0.0016, rim: 0.55 });
  // Tooth crowns wear to bright aluminium — the one place a glint belongs.
  const crown = grain(std({ color: 0x5a5a55, metalness: 0.90, roughness: 0.44, envMapIntensity: 1.0 }),
    { s: 45, streak: 3, rough: 0.18, tint: 0.24, wear: 0.40, rim: 0.34 });
  // Manganese phosphate: warm, matte, and the roughest metal on the gun.
  const park = grain(std({ color: 0x2b2825, metalness: 0.88, roughness: 0.71, envMapIntensity: 0.90 }),
    { s: 40, streak: 6, rough: 0.26, tint: 0.34, wear: 0.30, bump: 0.0020, rim: 0.50 });
  // M-LOK handguard — anodised, but a different batch and finish to the receiver.
  const hand = grain(std({ color: 0x2a2a27, metalness: 0.66, roughness: 0.58, envMapIntensity: 0.92 }),
    { s: 30, streak: 5, rough: 0.28, tint: 0.30, wear: 0.42, bump: 0.0026, rim: 0.55 });
  // Glass-filled polymer: dielectric, coarse mould texture, no streak.
  const poly = grain(std({ color: 0x20201d, metalness: 0.0, roughness: 0.86, envMapIntensity: 1.25 }),
    { s: 40, rough: 0.18, tint: 0.26, wear: 0.18, bump: 0.0024 });
  const magMat = grain(std({ color: 0x282a24, metalness: 0.03, roughness: 0.81, envMapIntensity: 1.15 }),
    { s: 45, rough: 0.18, tint: 0.28, wear: 0.20, bump: 0.0022 });
  const optic = grain(std({ color: 0x1e1e1c, metalness: 0.58, roughness: 0.72, envMapIntensity: 0.85 }),
    { s: 60, streak: 2, rough: 0.16, tint: 0.24, wear: 0.28, rim: 0.48 });
  const inset = std({ color: 0x0a0c0d, metalness: 0.35, roughness: 0.58, envMapIntensity: 0.7 });
  // Bare machined steel. SMALL PARTS ONLY — bolt face, pins, charging latch.
  const bright = std({ color: 0x82817c, metalness: 1.0, roughness: 0.27, envMapIntensity: 1.0 });
  // Glove leather, a hard rubber/kevlar gauntlet, and ripstop sleeve. The three
  // must separate by VALUE, not just hue — the cuff is the darkest band on the
  // arm so the sleeve->cuff->glove transition survives as a silhouette read at
  // hero framing, where hue is nearly gone in the shadowed near-camera zone.
  const glove = grain(std({ color: 0x4a4436, metalness: 0, roughness: 0.88, envMapIntensity: 1.2 }),
    { s: 45, rough: 0.16, tint: 0.28, bump: 0.0022 });
  const rubber = std({ color: 0x191c1e, metalness: 0, roughness: 0.92, envMapIntensity: 1.15 });
  const cuffM = grain(std({ color: 0x14170f, metalness: 0.04, roughness: 0.78, envMapIntensity: 1.0 }),
    { s: 55, rough: 0.14, tint: 0.22, bump: 0.0026 });
  const sleeve = grain(std({ color: 0x232a20, metalness: 0, roughness: 0.94, envMapIntensity: 1.25 }),
    { s: 26, rough: 0.14, tint: 0.26, bump: 0.0030 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffd39a, transparent: true, opacity: 0 });
  owned.push(glow);

  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = false; m.receiveShadow = false; m.layers.set(VM_LAYER);
    root.add(m); owned.push(geo); return m;
  };
  const bx = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => part(new THREE.BoxGeometry(w, h, d, 1, 1, 1), mat, x, y, z, rx, ry, rz);
  const rb = (w, h, d, r, mat, x, y, z, rx = 0, ry = 0, rz = 0) => part(new RoundedBoxGeometry(w, h, d, 2, r), mat, x, y, z, rx, ry, rz);
  const cy = (r, h, mat, x, y, z, rx = Math.PI * 0.5, ry = 0, rz = 0, sides = 12) => part(new THREE.CylinderGeometry(r, r, h, sides), mat, x, y, z, rx, ry, rz);
  const profile = (pts, w, mat) => {
    const s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: w, steps: 1, bevelEnabled: true, bevelSegments: 1, bevelSize: 0.005, bevelThickness: 0.005, curveSegments: 1 });
    g.translate(0, 0, -w * 0.5); g.rotateY(Math.PI * 0.5);
    return part(g, mat, 0, 0, 0);
  };
  const limb = (r, a, b, mat, sides = 10) => {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av), len = v.length();
    const m = part(new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 5, sides), mat, 0, 0, 0);
    m.position.copy(av).add(bv).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
    return m;
  };
  const taper = (ra, rb0, a, b, mat, sides = 12) => {
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av);
    const m = part(new THREE.CylinderGeometry(rb0, ra, v.length(), sides), mat, 0, 0, 0);
    m.position.copy(av).add(bv).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
    return m;
  };
  const V = (a) => new THREE.Vector3(...a);
  const UZ = new THREE.Vector3(0, 0, 1);
  // A ring bulge normal to `dir`. Used for fabric bunching and hard cuff lips —
  // the two things that stop a limb reading as an extruded cone.
  const ring = (R, t, at, dir, mat, seg = 12) => {
    const m = part(new THREE.TorusGeometry(R, t, 6, seg), mat, at[0], at[1], at[2]);
    m.quaternion.setFromUnitVectors(UZ, V(dir).normalize());
    return m;
  };
  const dirOf = (a, b) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const along = (a, d, t) => { const n = V(d).normalize().multiplyScalar(t); return [a[0] + n.x, a[1] + n.y, a[2] + n.z]; };

  // Bevelled, split receiver with an extruded upper profile and a flared magwell.
  rb(0.108, 0.086, 0.285, 0.012, recv, 0, -0.005, -0.485);
  profile([[0.335, -0.012], [0.365, 0.055], [0.585, 0.055], [0.64, 0.028], [0.625, -0.030], [0.39, -0.042]], 0.096, recv);
  rb(0.116, 0.096, 0.105, 0.014, recv, 0, -0.020, -0.625, -0.08);
  // Ejection port, bolt face, forward assist and mirrored fire controls.
  rb(0.007, 0.043, 0.128, 0.006, inset, 0.057, 0.013, -0.505);
  rb(0.009, 0.026, 0.084, 0.005, bright, 0.061, 0.014, -0.515);
  cy(0.016, 0.016, park, 0.061, 0.002, -0.355, 0, 0, Math.PI * 0.5, 12);
  cy(0.012, 0.014, bright, -0.060, -0.018, -0.46, 0, 0, Math.PI * 0.5, 12);
  rb(0.012, 0.032, 0.014, 0.003, bright, -0.061, 0.007, -0.535);
  rb(0.075, 0.014, 0.035, 0.005, rail, 0, 0.055, -0.315);
  // The upper's deck was ONE flat plane, so the whole receiver top answered the
  // sky with a single broad specular lobe — the "CG plastic" tell. A real
  // flat-top upper carries the rail all the way back to the optic; continuing
  // the same 20 mm ladder here splits that lobe into slot-and-crown bands at
  // 1 cm feature size, which is coarse enough to survive the post-TAA pass.
  rb(0.076, 0.010, 0.136, 0.003, rail, 0, 0.058, -0.430);
  for (let z = -0.368; z >= -0.492; z -= 0.030) rb(0.072, 0.009, 0.015, 0.002, crown, 0, 0.066, z);
  // Trigger group. The bow is authored as three struts rather than a torus so the
  // guard reads as bent stock with visible corner radii, and it gives the firing
  // hand's index finger something true to rest inside.
  limb(0.0085, [0, -0.048, -0.523], [0, -0.099, -0.502], park, 8);
  limb(0.0085, [0, -0.099, -0.502], [0, -0.106, -0.452], park, 8);
  limb(0.0085, [0, -0.106, -0.452], [0, -0.078, -0.424], park, 8);
  limb(0.0055, [0, -0.050, -0.472], [0, -0.086, -0.466], bright, 8);

  // Octagonal M-LOK handguard, recessed slots and a properly toothed top rail.
  cy(0.061, 0.49, hand, 0, 0.006, -0.885, Math.PI * 0.5, 0, 0, 8);
  for (const z of [-0.72, -0.82, -0.92, -1.02]) {
    rb(0.009, 0.019, 0.058, 0.006, inset, 0.058, 0.004, z);
    rb(0.009, 0.019, 0.058, 0.006, inset, -0.058, 0.004, z);
  }
  rb(0.080, 0.014, 0.72, 0.004, rail, 0, 0.066, -0.71);
  // Picatinny ladder. The old 30 mm pitch read as Lego at hero framing; 20 mm
  // with a 10 mm crown is close to MIL-STD-1913's real 10.008 mm pitch once the
  // 0.66 viewmodel scale is applied, and the worn `crown` finish makes the rungs
  // read by tone as well as by silhouette. +5 meshes over the coarse version.
  for (let z = -0.63; z >= -1.06; z -= 0.030) rb(0.075, 0.010, 0.016, 0.002, crown, 0, 0.077, z);
  // Barrel, gas block, muzzle brake.
  cy(0.018, 0.47, park, 0, 0.01, -1.22, Math.PI * 0.5, 0, 0, 14);
  rb(0.055, 0.06, 0.075, 0.008, park, 0, 0.018, -1.07);
  cy(0.032, 0.105, park, 0, 0.01, -1.49, Math.PI * 0.5, 0, 0, 12);
  for (const x of [-0.025, 0.025]) rb(0.012, 0.025, 0.055, 0.003, inset, x, 0.01, -1.535);

  // Rear hardware stays wholly behind the virtual eye in every authored pose.
  cy(0.026, 0.31, park, 0, 0.02, 0.68, Math.PI * 0.5, 0, 0, 12);
  rb(0.112, 0.15, 0.22, 0.018, poly, 0, -0.02, 0.73, -0.08);
  // Shaped pistol grip and a four-section curved magazine.
  rb(0.080, 0.205, 0.092, 0.018, poly, 0, -0.132, -0.382, -0.23);
  const mag = new THREE.Group(); root.add(mag);
  for (let i = 0; i < 4; i++) {
    const m = rb(0.086 - i * 0.004, 0.070, 0.132, 0.012, magMat, 0, -0.105 - i * 0.062, -0.575 - i * 0.012, -0.11 - i * 0.025);
    root.remove(m); mag.add(m);
  }
  rb(0.082, 0.022, 0.142, 0.005, poly, 0, -0.352, -0.628, -0.20);

  // Compact red-dot with actual glass and a centred emissive reticle.
  rb(0.094, 0.025, 0.13, 0.006, recv, 0, 0.086, -0.55);
  // Open optic housing: four bars around a transparent lens. A solid box here
  // becomes a target-obscuring black rectangle the moment ADS aligns it.
  rb(0.012, 0.082, 0.075, 0.005, optic, -0.037, 0.145, -0.55);
  rb(0.012, 0.082, 0.075, 0.005, optic, 0.037, 0.145, -0.55);
  rb(0.064, 0.012, 0.075, 0.005, optic, 0, 0.180, -0.55);
  rb(0.064, 0.012, 0.075, 0.005, optic, 0, 0.110, -0.55);
  // Machined chamfers on the housing's OUTER front and rear edges only. A milled
  // 45-deg break on anodised aluminium wears to bright metal and is the single
  // cheapest thing that stops the four bars reading as flat slabs — it puts a
  // hard 2 mm highlight on an edge that otherwise has none. Kept strictly
  // outboard of the aperture (x +-0.031, y 0.116-0.174) so the sight picture and
  // the four-bar arrangement are untouched.
  for (const z of [-0.5895, -0.5105]) {
    rb(0.015, 0.086, 0.005, 0.002, crown, -0.0405, 0.145, z);
    rb(0.015, 0.086, 0.005, 0.002, crown, 0.0405, 0.145, z);
    rb(0.096, 0.014, 0.005, 0.002, crown, 0, 0.1845, z);
    rb(0.096, 0.014, 0.005, 0.002, crown, 0, 0.1055, z);
  }
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x172c30, metalness: 0.05, roughness: 0.08, transmission: 0.28, transparent: true, opacity: 0.7 });
  owned.push(lensMat);
  cy(0.030, 0.006, lensMat, 0, 0.145, -0.59, Math.PI * 0.5, 0, 0, 20);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }); owned.push(dotMat);
  part(new THREE.SphereGeometry(0.003, 8, 6), dotMat, 0, 0.145, -0.595);

  // --------------------------------------------------------------------------
  // ARMS. The previous pair were two smooth tapered tubes and read as PVC pipe:
  // a perfect cone has one continuous silhouette and one continuous specular
  // sweep, so nothing on it can be named. Four things fix that, in order of how
  // much each buys at hero framing:
  //
  //  1. The chain now starts BEHIND the near plane's screen edge. The old left
  //     sleeve's start cap landed at ndc y ~ -0.79, i.e. a flat dark ellipse in
  //     frame — literally a pipe mouth. Every arm now begins off-screen.
  //  2. NON-MONOTONIC radii. Fabric bunches; it does not taper linearly. The
  //     radius list rises and falls along the arm and `ring` bulges sit at the
  //     crook and mid-forearm, so the silhouette has named features.
  //  3. A hard GAUNTLET CUFF that is WIDER than the sleeve it terminates, with a
  //     rolled lip and a strap. This is the single strongest silhouette event on
  //     the arm and it is what separates sleeve from hand.
  //  4. A WRIST that steps back down narrower than the cuff, and breaks angle
  //     from the forearm axis, before the hand steps out again.
  //
  // All feature sizes are >= ~1 cm on screen: the viewmodel pass runs after TAA
  // and GTAO, so anything finer would alias with nothing left to filter it.
  // --------------------------------------------------------------------------
  const armSleeve = (pts, rr, folds, side) => {
    for (let i = 0; i < pts.length - 1; i++) taper(rr[i], rr[i + 1], pts[i], pts[i + 1], sleeve, 14);
    for (const [i, dr, t] of folds) ring(rr[i] + dr, t, pts[i], dirOf(pts[i - 1], pts[i + 1]), sleeve);
    const n = pts.length - 1, w = pts[n], d = dirOf(pts[n - 1], w);
    const a0 = along(w, d, -0.016), a1 = along(w, d, 0.050);
    taper(0.080, 0.068, a0, a1, cuffM, 14);              // flared gauntlet shell
    ring(0.066, 0.011, a1, d, cuffM, 12);                 // rolled forward lip
    ring(0.077, 0.009, along(w, d, 0.010), d, glove, 12); // retention strap
    const ax = V(d).normalize(), out = new THREE.Vector3(side, 0, 0);
    out.addScaledVector(ax, -out.dot(ax)).normalize().multiplyScalar(0.076)
      .add(V(a0)).add(V(a1).sub(V(a0)).multiplyScalar(0.5));
    rb(0.016, 0.024, 0.030, 0.005, glove, out.x, out.y, out.z, 0, 0, side * 0.4);
  };

  // ---- support arm: forearm enters low-left, C-clamps the handguard ----------
  armSleeve(
    [[-0.480, -0.780, -0.220], [-0.352, -0.548, -0.392], [-0.266, -0.362, -0.556],
      [-0.206, -0.214, -0.678], [-0.168, -0.120, -0.762]],
    [0.086, 0.070, 0.077, 0.062, 0.059],
    [[1, 0.013, 0.014], [2, 0.010, 0.013], [3, 0.007, 0.011]], -1);
  limb(0.050, [-0.160, -0.104, -0.776], [-0.104, -0.030, -0.836], glove, 12);
  // Back-of-hand plate laid on the guard's left flat; the row of knuckle domes is
  // what the eye actually names as "a hand" in the silhouette.
  rb(0.044, 0.114, 0.166, 0.020, glove, -0.084, 0.002, -0.872, -0.10, 0.06, 0.14);
  for (let i = 0; i < 4; i++) {
    const z = -0.928 + i * 0.036;
    part(new THREE.SphereGeometry(0.0165 - i * 0.0008, 8, 6), glove, -0.098, -0.024 - i * 0.004, z);
    // Two segments per finger so there is a real proximal/distal break, curling
    // UNDER the octagonal guard rather than hovering beside it.
    const r = 0.0145 - i * 0.0012;
    limb(r, [-0.074, -0.038, z], [-0.044, -0.070, z], glove, 8);
    limb(r * 0.86, [-0.044, -0.070, z], [0.014, -0.061, z], glove, 8);
  }
  // Thumb rides forward along the guard's upper-left facet, clear of the rail.
  limb(0.017, [-0.070, 0.004, -0.798], [-0.058, 0.036, -0.848], glove, 8);
  limb(0.013, [-0.058, 0.036, -0.848], [-0.048, 0.045, -0.912], glove, 8);

  // ---- firing arm: fingers close on the grip, index rests inside the guard ---
  armSleeve(
    [[0.400, -0.660, -0.060], [0.300, -0.452, -0.088], [0.222, -0.330, -0.182],
      [0.156, -0.238, -0.268], [0.112, -0.186, -0.324]],
    [0.086, 0.070, 0.076, 0.062, 0.058],
    [[1, 0.013, 0.014], [2, 0.010, 0.013], [3, 0.007, 0.011]], 1);
  limb(0.050, [0.106, -0.174, -0.334], [0.070, -0.148, -0.374], glove, 12);
  // Grip-local frame: u across, v up the grip, w toward the muzzle. Authoring the
  // firing hand in the grip's own raked frame is the only way the fingers land on
  // the front strap instead of near it.
  const GA = -0.23, GC = Math.cos(GA), GS = Math.sin(GA);
  const gp = (u, v, w) => [u, -0.132 + v * GC - w * GS, -0.382 + v * GS + w * GC];
  rb(0.048, 0.134, 0.092, 0.018, glove, ...gp(0.062, -0.010, 0.004), GA, 0, 0.06);
  for (let i = 0; i < 4; i++) {
    const v = 0.038 - i * 0.030, r = 0.0145 - i * 0.0012;
    part(new THREE.SphereGeometry(r + 0.003, 8, 6), glove, ...gp(0.078, v, -0.042));
    if (i === 0) {   // trigger finger: reaches forward into the guard bow
      limb(r, gp(0.075, 0.038, -0.050), gp(0.044, 0.020, -0.086), glove, 8);
      limb(r * 0.85, gp(0.044, 0.020, -0.086), gp(0.006, 0.010, -0.096), glove, 8);
    } else {         // remaining three close around the front strap
      limb(r, gp(0.072, v, -0.048), gp(0.042, v - 0.012, -0.066), glove, 8);
      limb(r * 0.86, gp(0.042, v - 0.012, -0.066), gp(-0.026, v - 0.024, -0.056), glove, 8);
    }
  }
  limb(0.017, gp(0.068, 0.048, 0.012), gp(0.036, 0.070, -0.024), glove, 8);
  limb(0.013, gp(0.036, 0.070, -0.024), gp(0.014, 0.078, -0.062), glove, 8);
  const muzzle = part(new THREE.ConeGeometry(0.085, 0.24, 10, 1, true), glow, 0, 0.01, -1.66, -Math.PI * 0.5);
  muzzle.visible = false;

  root.traverse((o) => o.layers?.set(VM_LAYER));
  return {
    root, mag, muzzle, glow,
    dispose() {
      camera.remove(root);
      for (const o of owned) o.dispose?.();
    },
  };
}

export function createWeapons({ scene, camera, bus, rng, player, level }) {
  const vm = buildViewmodel(scene, camera);
  const state = {
    ammo: W.capacity, mag: W.capacity, reserve: W.reserveMax,
    firing: false, reloading: false, reloadStage: '', forceAds: undefined,
    ads: 0, spreadDeg: 0, bloom: 0, muzzle: 0, shot: 0,
  };
  let fireCd = 0, sinceFire = 99, reloadT = 0, reloadCredited = false;
  let ads = 0, adsFrom = 0, adsTo = 0, adsClock = 1;
  let kickZ = 0, kickZV = 0, kickY = 0, kickYV = 0, kickP = 0, kickPV = 0, kickR = 0, kickRV = 0;
  let prevYaw = player.state.yaw, prevPitch = player.state.pitch;
  let swayX = 0, swayXV = 0, swayY = 0, swayYV = 0;
  const o = new THREE.Vector3(), d = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3();

  function spreadFor() {
    const ps = player.state;
    const a = state.ads;
    const base = SPREAD.hipBase + (SPREAD.adsBase - SPREAD.hipBase) * a;
    let move = Math.min(1, ps.speed / SPREAD.moveRef) * SPREAD.moveMax * (1 + (SPREAD.moveAdsMul - 1) * a);
    let air = ps.grounded ? 0 : SPREAD.air * (1 + (SPREAD.airAdsMul - 1) * a);
    let s = base + move + air + state.bloom;
    if (ps.crouched) s *= SPREAD.crouchMul;
    return s;
  }

  function trace() {
    camera.getWorldPosition(o); camera.getWorldQuaternion(q);
    d.set(0, 0, -1).applyQuaternion(q);
    right.set(1, 0, 0).applyQuaternion(q); up.set(0, 1, 0).applyQuaternion(q);
    const cone = spreadFor(), a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * Math.tan(cone);
    d.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const hit = level.raycast(o, d, W.maxDist);
    const dist = hit?.dist ?? W.maxDist;
    p.copy(o).addScaledVector(d, dist);
    bus.emit('weapon:fire', { pos: o.clone(), dir: d.clone(), weapon: 'rifle', ammo: state.ammo, maxDist: dist, damage: W.damage });
    if (hit) bus.emit('weapon:impact', { point: p.clone(), pos: p.clone(), normal: hit.normal.clone(), mat: hit.mat ?? 'concrete', dir: d.clone(), damage: W.damage });
  }

  function shoot() {
    if (state.ammo <= 0 || state.reloading) { bus.emit('weapon:dry', {}); return; }
    state.ammo--; state.mag = state.ammo; state.shot++; state.muzzle = 0.045;
    fireCd += W.shotDt; sinceFire = 0;
    state.bloom = Math.min(state.bloom + (state.ads > 0.5 ? SPREAD.bloomAds : SPREAD.bloomHip), state.ads > 0.5 ? SPREAD.bloomCapAds : SPREAD.bloomCapHip);
    const pat = PATTERN[Math.min(PATTERN.length - 1, state.shot - 1)];
    const mul = (state.ads > 0.5 ? RECOIL.adsMul : 1) * (player.state.crouched ? RECOIL.crouchMul : 1);
    player.state.yaw -= (pat[0] + (rng() * 2 - 1) * RECOIL.jitterYaw) * mul;
    player.state.pitch = clamp(player.state.pitch + (pat[1] + (rng() * 2 - 1) * RECOIL.jitterPitch) * mul, -1.52, 1.52);
    kickZV += RECOIL.kickBack * 180 * (state.ads > 0.5 ? RECOIL.kickAdsMul : 1);
    kickYV += RECOIL.kickUp * 160; kickPV += RECOIL.kickPitch * 150; kickRV += (rng() < 0.5 ? -1 : 1) * RECOIL.kickRoll * 110;
    trace();
  }

  function beginReload() {
    if (state.reloading || state.ammo >= W.capacity + 1 || state.reserve <= 0) return;
    state.reloading = true; reloadT = 0; reloadCredited = false; state.reloadStage = 'magout';
    bus.emit('weapon:reload', { stage: 'magout', pos: player.position.clone() });
  }

  function stepReload(dt) {
    const R = state.ammo === 0 ? RELOAD.empty : RELOAD.tac;
    reloadT += dt;
    let stage = R.stages[0][1];
    for (const [t, s] of R.stages) if (reloadT >= t) stage = s;
    if (stage !== state.reloadStage) { state.reloadStage = stage; bus.emit('weapon:reload', { stage, pos: player.position.clone() }); }
    if (!reloadCredited && reloadT >= R.credit) {
      const want = W.capacity + (state.ammo > 0 ? 1 : 0) - state.ammo;
      const got = Math.min(want, state.reserve); state.ammo += got; state.reserve -= got; state.mag = state.ammo; reloadCredited = true;
    }
    if (reloadT >= R.done) { state.reloading = false; state.reloadStage = ''; }
  }

  return {
    state,
    setState(s = {}) {
      if (s.ammo != null) state.ammo = state.mag = clamp(s.ammo, 0, W.capacity + 1);
      if (s.reserve != null) state.reserve = Math.max(0, s.reserve | 0);
      if (s.ads != null) {
        state.forceAds = !!s.ads; state.ads = +!!s.ads;
        adsFrom = adsTo = state.ads; adsClock = 1; player.state.adsT = state.ads;
      }
    },
    step(dt, f) {
      fireCd = Math.max(0, fireCd - dt); sinceFire += dt; state.muzzle = Math.max(0, state.muzzle - dt);
      const wantAds = state.forceAds ?? (f.ads && !player.state.sprinting && !state.reloading);
      if (+wantAds !== adsTo) { adsFrom = state.ads; adsTo = +wantAds; adsClock = 0; }
      adsClock += dt / (adsTo ? ANIM.adsInT : ANIM.adsOutT); state.ads = adsFrom + (adsTo - adsFrom) * ease(Math.min(1, adsClock));
      player.state.adsT = state.ads;
      if (f.pressed?.has('reload')) beginReload();
      if (state.reloading) stepReload(dt);
      state.firing = !!f.fire && !state.reloading;
      if (state.firing && fireCd <= 0) shoot();
      if (state.ammo === 0 && state.firing) beginReload();
      if (sinceFire > SPREAD.bloomHold) state.bloom = damp(state.bloom, 0, SPREAD.bloomRecover, dt);
      state.spreadDeg = spreadFor() * 180 / Math.PI;

      [kickZ, kickZV] = springDamp(kickZ, kickZV, 0, RECOIL.omega, dt);
      [kickY, kickYV] = springDamp(kickY, kickYV, 0, RECOIL.omega, dt);
      [kickP, kickPV] = springDamp(kickP, kickPV, 0, RECOIL.omega, dt);
      [kickR, kickRV] = springDamp(kickR, kickRV, 0, RECOIL.omega, dt);
      const dy = player.state.yaw - prevYaw, dp = player.state.pitch - prevPitch; prevYaw = player.state.yaw; prevPitch = player.state.pitch;
      const sm = 1 + (ANIM.swayAdsMul - 1) * state.ads;
      [swayX, swayXV] = springDamp(swayX, swayXV, clamp(-dy * ANIM.swayGain / dt, -ANIM.swayMax, ANIM.swayMax) * sm, ANIM.swayOmega, dt);
      [swayY, swayYV] = springDamp(swayY, swayYV, clamp(dp * ANIM.swayGain / dt, -ANIM.swayMax, ANIM.swayMax) * sm, ANIM.swayOmega, dt);
    },
    render() {
      const a = state.ads;
      // Optic centre is (0,.145,-.55); solve its screen-centred eye relief.
      const ax = 0, ay = -0.145 * 0.66, az = 0.55 * 0.66 - POSE.adsDist;
      const hp = POSE.hip.p;
      p.set(hp[0] + (ax - hp[0]) * a, hp[1] + (ay - hp[1]) * a, hp[2] + (az - hp[2]) * a);
      let px = p.x + swayX, py = p.y + swayY, pz = p.z + kickZ;
      let rx = POSE.hip.r[0] * (1 - a) + kickP, ry = POSE.hip.r[1] * (1 - a), rz = POSE.hip.r[2] * (1 - a) + kickR;
      if (player.state.sprinting && !state.reloading) {
        const s = 1 - a; px += (POSE.sprint.p[0] - hp[0]) * s; py += (POSE.sprint.p[1] - hp[1]) * s;
        rx += POSE.sprint.r[0] * s; ry += POSE.sprint.r[1] * s; rz += POSE.sprint.r[2] * s;
      }
      if (state.reloading) {
        const s = Math.sin(Math.min(1, reloadT / 0.28) * Math.PI * 0.5);
        px += (POSE.reload.p[0] - hp[0]) * s; py += (POSE.reload.p[1] - hp[1]) * s;
        rx += POSE.reload.r[0] * s; ry += POSE.reload.r[1] * s; rz += POSE.reload.r[2] * s;
        vm.mag.position.y = -Math.sin(Math.min(1, reloadT / 1.2) * Math.PI) * 0.22;
      } else vm.mag.position.y = 0;
      vm.root.position.set(px, py + kickY, pz); vm.root.rotation.set(rx, ry, rz);
      vm.muzzle.visible = state.muzzle > 0; vm.glow.opacity = Math.min(1, state.muzzle * 24);
    },
    dispose() { vm.dispose(); },
  };
}
