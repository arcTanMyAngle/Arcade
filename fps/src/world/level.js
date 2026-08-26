// Procedural CQB yard. Every solid helper emits visible geometry and collision
// from the same arguments; decorative-only calls must opt out explicitly.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCollider } from './collision.js';

const FACE_DIMS = (w, h, d) => [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];

function scaleBoxUVs(g, w, h, d, tile) {
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const [su, sv] = FACE_DIMS(w, h, d)[f];
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, uv.getX(i) * su / tile, uv.getY(i) * sv / tile);
  }
  uv.needsUpdate = true;
}

export function createLevel({ scene, rng, mats }) {
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);
  const brushes = [];
  const batches = new Map();
  const owned = [];
  const batch = (mat, g) => {
    let a = batches.get(mat);
    if (!a) batches.set(mat, (a = []));
    a.push(g);
  };

  function box(mat, x, y, z, w, h, d, opt = {}) {
    const { collide = true, ry = 0 } = opt;
    const g = new THREE.BoxGeometry(w, h, d);
    scaleBoxUVs(g, w, h, d, mats.tileOf?.(mat) ?? 2);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    g.translate(x, y + h * 0.5, z);
    batch(mat, g);
    if (collide) {
      const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
      const aw = w * c + d * s, ad = w * s + d * c;
      brushes.push({
        min: new THREE.Vector3(x - aw * 0.5, y, z - ad * 0.5),
        max: new THREE.Vector3(x + aw * 0.5, y + h, z + ad * 0.5), mat,
      });
    }
  }

  function cyl(mat, x, y, z, r, h, opt = {}) {
    const { collide = true, sides = 12, rx = 0, rz = 0 } = opt;
    const g = new THREE.CylinderGeometry(r, r, h, sides, 1, false);
    const uv = g.attributes.uv, tile = mats.tileOf?.(mat) ?? 2;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r / tile, uv.getY(i) * h / tile);
    g.applyMatrix4(new THREE.Matrix4().makeRotationX(rx));
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(rz));
    g.translate(x, y + h * 0.5, z);
    batch(mat, g);
    if (collide) brushes.push({
      min: new THREE.Vector3(x - r, y, z - r), max: new THREE.Vector3(x + r, y + h, z + r), mat,
    });
  }

  function beam(mat, a, b, r, opt = {}) {
    const { collide = true, sides = 8 } = opt;
    const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av);
    const g = new THREE.CylinderGeometry(r, r, v.length(), sides, 1, false);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize()));
    const c = av.clone().add(bv).multiplyScalar(0.5); g.translate(c.x, c.y, c.z); batch(mat, g);
    if (collide) brushes.push({
      min: new THREE.Vector3(Math.min(av.x, bv.x) - r, Math.min(av.y, bv.y) - r, Math.min(av.z, bv.z) - r),
      max: new THREE.Vector3(Math.max(av.x, bv.x) + r, Math.max(av.y, bv.y) + r, Math.max(av.z, bv.z) + r), mat,
    });
  }

  const rail = (x, y, z, len, alongX = true) => {
    box('rustedSteel', x, y + 0.92, z, alongX ? len : 0.08, 0.08, alongX ? 0.08 : len, { collide: false });
    for (let q = -len * 0.5; q <= len * 0.5 + 0.01; q += 1.7) {
      box('rustedSteel', x + (alongX ? q : 0), y, z + (alongX ? 0 : q), 0.07, 1, 0.07, { collide: false });
    }
  };
  const stairs = (x, z, n, dx, dz, w, rise = 0.24, run = 0.34) => {
    for (let i = 0; i < n; i++) box('paintedMetal', x + dx * run * i, 0, z + dz * run * i, dx ? run : w, rise * (i + 1), dz ? run : w);
  };
  const pallet = (x, y, z, ry = 0) => {
    for (let i = -2; i <= 2; i++) box('wood', x + Math.cos(ry) * i * 0.23, y + 0.08, z - Math.sin(ry) * i * 0.23, 0.18, 0.08, 1.05, { ry, collide: false });
    for (const q of [-0.42, 0, 0.42]) box('wood', x - Math.sin(ry) * q, y, z - Math.cos(ry) * q, 1.2, 0.09, 0.12, { ry, collide: false });
  };
  const crate = (x, y, z, s = 1) => {
    box('wood', x, y, z, s, s, s);
    for (const yy of [0.05, s - 0.11]) {
      box('rustedSteel', x, y + yy, z - s * 0.505, s + 0.04, 0.07, 0.04, { collide: false });
      box('rustedSteel', x, y + yy, z + s * 0.505, s + 0.04, 0.07, 0.04, { collide: false });
    }
  };
  const drum = (x, y, z, mat = 'paintedMetal') => {
    cyl(mat, x, y, z, 0.29, 0.86, { sides: 18 });
    for (const yy of [0.08, 0.39, 0.73]) cyl('rustedSteel', x, y + yy, z, 0.302, 0.045, { sides: 18, collide: false });
  };
  const equipmentCase = (x, y, z, ry = 0, s = 1) => {
    box('paintedMetal', x, y, z, 1.15 * s, 0.48 * s, 0.72 * s, { ry });
    for (const q of [-0.47, 0.47]) box('rustedSteel', x + Math.cos(ry) * q * s, y + 0.05, z - Math.sin(ry) * q * s, 0.07 * s, 0.42 * s, 0.75 * s, { ry, collide: false });
    box('rustedSteel', x, y + 0.45 * s, z, 1.05 * s, 0.045 * s, 0.66 * s, { ry, collide: false });
  };
  // Perimeter wall trim. The walls were untrimmed slabs — one flush capstone and
  // a 0.27 m pilaster — at a scale that fills most of the frame width.
  //
  // The relief has to read WHILE IN SHADOW. sunDir is (-0.42, 0.78, 0.46), so
  // only the east and north inner faces are sunlit; the west and south inner
  // faces are carried entirely by the hemisphere fill. On a shadowed face
  // vertical relief separates by almost nothing — that is precisely why the
  // bulkhead brick experiment failed (see below). Horizontal relief does
  // separate, because the fill is bright sky (0x9ec4f5) over dark ground
  // (0x4a4034): an up-face and an oversailing soffit land at very different
  // values with no sun involved at all. So every band here pairs an up-face with
  // a soffit, and the pilasters get caps so even the vertical members read.
  const wallTrim = (c, len, face, axis, s, opt = {}) => {
    const { lamps = false } = opt;
    // a/b = near/far projection from the wall face; along/alen run with the wall.
    const put = (mat, y, h, a, b, along, alen, collide = false) => {
      const o = face + s * (a + b) * 0.5, t = b - a;
      if (axis === 'x') box(mat, along, y, o, alen, h, t, { collide });
      else box(mat, o, y, along, t, h, alen, { collide });
    };
    put('concrete', 0.00, 0.62, 0, 0.20, c, len, true);   // plinth
    put('concrete', 0.62, 0.10, 0, 0.30, c, len);         // plinth drip
    put('concrete', 3.42, 0.20, 0, 0.14, c, len);         // string course
    put('concrete', 3.62, 0.07, 0, 0.21, c, len);         // its drip
    put('concrete', 7.10, 0.16, 0, 0.22, c, len);         // cornice bed
    put('concrete', 7.26, 0.34, 0, 0.40, c, len);         // corona — the deep soffit
    put('concrete', 7.60, 0.14, 0, 0.26, c, len);         // fillet under the capstone
    const n = Math.max(2, Math.round(len / 5.3));
    for (let i = 0; i <= n; i++) {
      const a = c - len * 0.5 + (len / n) * i;
      put('concrete', 0, 7.10, 0, 0.50, a, 0.55, true);
      put('concrete', 7.10, 0.18, 0, 0.62, a, 0.72);
    }
    // Service layer: a conduit run at 6.35 (above the west wall's 5.2 m pipes),
    // junction boxes, and drops to wall boxes at head height.
    const cy = 6.35, co = 0.40;
    const at = (a, y) => (axis === 'x' ? [a, y, face + s * co] : [face + s * co, y, a]);
    beam('rustedSteel', at(c - len * 0.5 + 0.6, cy), at(c + len * 0.5 - 0.6, cy), 0.075, { collide: false });
    const m = Math.max(1, Math.round(len / 13));
    for (let i = 0; i < m; i++) {
      const a = c - len * 0.5 + (len / m) * (i + 0.5);
      put('rustedSteel', cy - 0.27, 0.54, 0.06, 0.52, a, 0.40);
      beam('rustedSteel', at(a + 0.55, 2.30), at(a + 0.55, cy), 0.045, { collide: false });
      put('rustedSteel', 1.98, 0.40, 0.06, 0.38, a + 0.55, 0.30);
    }
    if (lamps) for (let i = 2; i < n; i += 4) {
      const a = c - len * 0.5 + (len / n) * i;
      put('rustedSteel', 6.05, 0.09, 0.06, 0.80, a, 0.13);   // bracket arm
      put('paintedMetal', 5.72, 0.34, 0.34, 0.86, a, 0.56);  // hood
      put('tile', 5.68, 0.06, 0.40, 0.80, a, 0.46);          // lens
    }
  };

  const container = (x, y, z, ry = 0) => {
    box('corrugated', x, y, z, 6.05, 2.55, 2.44, { ry });
    for (const q of [-2.95, 2.95]) for (const zz of [-1.16, 1.16]) {
      const lx = Math.cos(ry) * q + Math.sin(ry) * zz, lz = -Math.sin(ry) * q + Math.cos(ry) * zz;
      box('rustedSteel', x + lx, y, z + lz, 0.12, 2.62, 0.12, { collide: false });
    }
    for (let q = -2.4; q <= 2.4; q += 0.8) box('paintedMetal', x + Math.cos(ry) * q, y + 2.54, z - Math.sin(ry) * q, 0.05, 0.09, 2.5, { ry, collide: false });
  };

  // Ground, perimeter shell, capstones, pilasters, and a broken north gateway.
  box('asphalt', 0, -1.6, 0, 72, 1.6, 62);
  box('concreteWall', -31, 0, 0, 1.2, 8, 54);
  box('concreteWall', 31, 0, 0, 1.2, 8, 54);
  box('concreteWall', 0, 0, 27, 63, 8, 1.2);
  box('concreteWall', -18, 0, -27, 27, 8, 1.2);
  box('concreteWall', 18, 0, -27, 27, 8, 1.2);
  box('paintedMetal', 0, 5.8, -27, 9, 2.2, 1.3);
  for (const x of [-31, 31]) box('concreteFloor', x, 7.85, 0, 1.55, 0.22, 55);
  box('concreteFloor', 0, 7.85, 27, 63, 0.22, 1.55);
  box('concreteFloor', -18, 7.85, -27, 27, 0.22, 1.55);
  box('concreteFloor', 18, 7.85, -27, 27, 0.22, 1.55);
  // Trim every inner face. Runs stop at the adjoining wall's inner face so no
  // band is buried inside the wall it meets, and the north runs stop at the
  // gateway jambs (|x| = 4.5) so the 9 m portal stays clear.
  wallTrim(0, 52.8, -30.4, 'z', 1, { lamps: true });   // west
  wallTrim(0, 52.8, 30.4, 'z', -1);                    // east
  wallTrim(0, 60.8, 26.4, 'x', -1, { lamps: true });   // south
  wallTrim(-17.45, 25.9, -26.4, 'x', 1);               // north, west of the gateway
  wallTrim(17.45, 25.9, -26.4, 'x', 1);                // north, east of the gateway

  // ---- north sally port ---------------------------------------------------
  // The 9 m gateway used to open onto 4 m of asphalt and then nothing: through it
  // you saw the world edge and the sky dome below the horizon (measured min-luma
  // 0 — the only crushed region in any frame). It is now the mouth of a roofed
  // vehicle sally port whose far bulkhead has partly collapsed.
  //
  // The bounding argument, which the regression test in test/gameplay.test.mjs
  // enforces: port side walls bound every sightline laterally, the roof slab and
  // the bulkhead's intact lower course bound it vertically, and what remains —
  // the breach — frames a backdrop mass placed close enough behind that the
  // widest ray through the breach still lands on it. No ray with dir.y <= 0 fired
  // from any standing eye position escapes the level.
  const PORT_H = 5.8;              // ceiling underside; matches the gate lintel
  const BULK_Z = -35.1;            // bulkhead centre, 0.6 thick, inner face -34.8

  box('asphalt', 0, -1.6, -37.2, 40, 1.6, 12.4);                  // ground out to z=-43.4
  for (const x of [-5.0, 5.0]) box('concreteWall', x, 0, -31.2, 1.0, PORT_H, 7.2);
  box('concreteFloor', 0, PORT_H, -31.2, 11.0, 0.5, 7.2);         // roof slab
  // Bulkhead. The first version of this was a clean rectangular hole in a flat
  // slab and read as a window, not a collapse, so the profile is authored as
  // per-column heights: the sill tears down to the right and the standing return
  // tears back up, leaving an irregular opening. Columns merge into the same
  // batch as everything else, so the silhouette is free.
  box('concreteWall', 0, 0, BULK_Z, 11.0, 1.85, 0.6);               // intact course below the tear
  for (const [x, w, h] of [
    [-5.02, 0.96, 3.95], [-4.06, 0.96, 3.95], [-3.10, 0.96, 3.95], [-2.14, 0.96, 3.95],
    [-1.20, 0.92, 3.62], [-0.42, 0.64, 2.34], [0.18, 0.56, 1.02], [0.78, 0.64, 0.55],
    [1.50, 0.80, 0.28], [2.30, 0.80, 0.42], [3.08, 0.76, 0.30], [3.80, 0.68, 0.74],
    [4.44, 0.60, 1.36], [5.06, 0.88, 2.05],
  ]) box('concreteWall', x, 1.85, BULK_Z, w, h, 0.6);
  // The four leftmost columns reach 5.8 and close the left half against the roof
  // slab, so the tear has no separate return piece.
  // Torn rebar and slumped spall off the broken course.
  for (const [x0, x1, dy] of [[-0.55, 0.5, 0.62], [0.75, 1.75, 0.44], [2.1, 3.3, 0.71]]) {
    beam('rustedSteel', [x0, 1.9, BULK_Z + 0.1], [x1, 2.0 + dy, BULK_Z - 0.05], 0.022, { collide: false });
  }
  // Face articulation — a proud string course and pilasters. Without these the
  // bulkhead is one flat plane, which is the same untrimmed-slab signal the
  // perimeter walls already carry.
  box('concrete', 0, 1.62, BULK_Z - 0.36, 11.0, 0.22, 0.16, { collide: false });
  for (const x of [-4.7, -2.35, 5.05]) box('concrete', x, 0, BULK_Z - 0.34, 0.44, 5.6, 0.14, { collide: false });
  for (const [x, z, w, h, d, r] of [
    [-1.5, -34.15, 1.7, 0.58, 1.4, 0.31], [0.95, -34.35, 2.0, 0.82, 1.6, -0.52],
    [2.75, -33.85, 1.35, 0.44, 1.15, 0.88], [-0.3, -33.35, 1.15, 0.3, 0.95, 0.14],
  ]) box('concrete', x, 0, z, w, h, d, { ry: r });
  // Port interior trim — kerbs, a ceiling conduit run and lane chevrons, so the
  // passage reads as built rather than as a corridor of bare slabs.
  for (const x of [-4.32, 4.32]) box('concrete', x, 0, -31.2, 0.36, 0.34, 7.2, { collide: false });
  // Hung 0.42 below the slab, not 0.2. Jammed against the ceiling they sat in an
  // occlusion pocket no light reached and crushed to luma 0 along every edge.
  for (const z of [-28.6, -30.6, -32.6, -34.2]) box('rustedSteel', 0, PORT_H - 0.42, z, 10.9, 0.12, 0.14, { collide: false });
  beam('rustedSteel', [-3.9, PORT_H - 0.44, -27.7], [-3.9, PORT_H - 0.44, -34.7], 0.055, { collide: false });
  for (const x of [-4.44, 4.44]) for (let i = 0; i < 5; i++) {
    box(i % 2 ? 'asphaltLane' : 'rustedSteel', x, 0.42, -28.5 - i * 1.45, 0.06, 0.9, 0.62, { collide: false });
  }
  // Two jersey barriers narrow the mouth into a real vehicle chicane.
  box('concrete', -2.6, 0, -28.9, 0.62, 0.92, 3.0, { collide: true });
  box('concrete', 2.9, 0, -32.3, 0.62, 0.92, 3.0, { collide: true });

  // Exterior backdrop, seen only through the breach. The rear slab spans the full
  // visible cone and is the guaranteed backstop; everything in front of it is
  // silhouette massing and may be arranged freely.
  // These were swapped to 'brick' to try to buy hue separation from the bulkhead
  // framing them, and it was measured as a REGRESSION: breach-left fell 85.3 -> 68.2
  // mean and stayed cool (rgb 67/67/79). These masses are in shadow, so they are
  // carried by the cool hemisphere fill (0x9ec4f5) and a lower-albedo material
  // only darkens them. Separation here has to come from light, not material — see
  // handoff.md, "unresolved". Reverted; do not re-try the material swap.
  box('concreteWall', 2, 0, -40.4, 40, 13, 0.8);
  box('concreteFloor', 2, 13, -40.4, 40, 0.45, 1.5, { collide: false });
  box('concreteWall', -3.5, 0, -39.2, 7, 8.5, 1.0);
  box('concreteFloor', -3.5, 8.5, -39.2, 7.5, 0.4, 1.6, { collide: false });
  box('concreteWall', 8.5, 0, -39.0, 8, 11, 1.2);
  box('concreteFloor', 8.5, 11, -39.0, 8.5, 0.4, 1.8, { collide: false });
  for (const x of [-5.6, -1.4, 6.1, 10.9]) box('concrete', x, 0, -38.5, 0.5, 7.6, 0.42, { collide: false });
  // Midground layer: a stack and a lattice mast read against the lit slab and give
  // the breach real depth instead of a painted wall 5 m back.
  container(4.7, 0, -38.0, 0.28);
  container(4.4, 2.58, -38.2, 0.28);
  // The mast sat on the breach centreline and read as a scratch across it. Moved
  // to graze the left jamb, thickened, and given crossarms wide enough to
  // silhouette against the lit slab behind.
  beam('rustedSteel', [-1.15, 0, -36.9], [-1.15, 9.4, -36.9], 0.15);
  for (const y of [3.2, 6.1, 8.7]) box('rustedSteel', -1.15, y, -36.9, 2.3, 0.13, 0.13, { collide: false });
  for (const [y, dx] of [[3.2, 1.0], [6.1, 0.85]]) {
    beam('rustedSteel', [-1.15 + dx, y, -36.9], [-1.15, y + 1.15, -36.9], 0.05, { collide: false });
    beam('rustedSteel', [-1.15 - dx, y, -36.9], [-1.15, y + 1.15, -36.9], 0.05, { collide: false });
  }

  // Central operations building: a true 2.5 m-deep entry recess, not a door
  // painted onto a solid brush. Wings, lintel and rear block author their own
  // matching collision while the opening itself remains traversable.
  box('brick', -4.8, 0, -9.25, 10.6, 4.4, 5.3);
  box('brick', -8.08, 0, -5.35, 4.05, 4.4, 2.5);
  box('brick', -1.52, 0, -5.35, 4.05, 4.4, 2.5);
  box('brick', -4.8, 3.0, -5.35, 2.5, 1.4, 2.5);
  // Broken plaster skin stops around the void; the brick returns stay visible.
  box('plaster', -8.08, 0, -3.98, 4.12, 4.55, 0.24, { collide: false });
  box('plaster', -1.52, 0, -3.98, 4.12, 4.55, 0.24, { collide: false });
  box('plaster', -4.8, 3.0, -3.98, 2.5, 1.55, 0.24, { collide: false });
  box('paintedMetal', -4.8, 0, -6.48, 2.05, 2.82, 0.12);
  box('concreteFloor', -4.8, 0.005, -5.28, 2.38, 0.075, 2.42, { collide: false });
  box('paintedMetal', -6.01, 0, -5.26, 0.10, 3.02, 2.5, { collide: false });
  box('paintedMetal', -3.59, 0, -5.26, 0.10, 3.02, 2.5, { collide: false });
  box('paintedMetal', -4.8, 2.90, -5.26, 2.52, 0.11, 2.5, { collide: false });
  // Deep jamb shadows, threshold wear and a projecting rain hood frame the focal point.
  box('rustedSteel', -6.08, 0, -3.83, 0.16, 3.12, 0.36, { collide: false });
  box('rustedSteel', -3.52, 0, -3.83, 0.16, 3.12, 0.36, { collide: false });
  box('rustedSteel', -4.8, 2.96, -3.76, 2.72, 0.17, 0.52, { collide: false });
  box('paintedMetal', -4.8, 3.18, -3.55, 3.65, 0.16, 1.05, { collide: false });
  beam('rustedSteel', [-6.45, 2.95, -3.2], [-6.0, 3.2, -3.75], 0.045, { collide: false });
  beam('rustedSteel', [-3.15, 2.95, -3.2], [-3.6, 3.2, -3.75], 0.045, { collide: false });
  box('concreteFloor', -4.8, 4.4, -8, 11.2, 0.35, 8.4);
  for (const x of [-9.8, 0.2]) box('concreteFloor', x, 0, -3.7, 0.28, 4.7, 0.5, { collide: false });
  box('tile', -4.8, 0.02, -3.48, 2.15, 0.08, 0.7, { collide: false });

  // Localized OPS-01 sign, assembled from emissive-looking tile strokes.
  box('paintedMetal', -4.8, 3.48, -3.69, 3.05, 0.62, 0.10, { collide: false });
  for (const x of [-5.78, -5.52, -5.26]) box('tile', x, 3.68, -3.61, 0.17, 0.08, 0.035, { collide: false });
  box('tile', -5.78, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const x of [-4.65, -4.31]) box('tile', x, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const y of [3.42, 3.84]) box('tile', -4.48, y, -3.61, 0.42, 0.07, 0.035, { collide: false });
  for (const x of [-3.72, -3.38]) box('tile', x, 3.39, -3.61, 0.08, 0.50, 0.035, { collide: false });
  for (const y of [3.42, 3.84]) box('tile', -3.55, y, -3.61, 0.42, 0.07, 0.035, { collide: false });
  // Conduit and a sagging temporary power lead break the clean facade silhouette.
  beam('rustedSteel', [-9.65, 3.65, -3.72], [-7.5, 3.65, -3.72], 0.035, { collide: false });
  beam('rubber', [-7.5, 3.65, -3.70], [-6.2, 2.65, -3.55], 0.025, { collide: false });
  beam('rubber', [-6.2, 2.65, -3.55], [-4.9, 2.45, -3.45], 0.025, { collide: false });

  // West catwalk and playable stairs.
  box('paintedMetal', -24.4, 3.05, -4, 10.8, 0.32, 3.0);
  for (const x of [-29.2, -24.4, -19.6]) for (const z of [-5.1, -2.9]) box('rustedSteel', x, 0, z, 0.16, 3.1, 0.16);
  rail(-24.4, 3.35, -5.38, 10.4, true); rail(-24.4, 3.35, -2.62, 10.4, true);
  stairs(-18.95, -3.95, 13, 1, 0, 2.6, 0.235, 0.34);
  rail(-16.9, 0.25, -5.42, 4.2, true);

  // East loading lane: stacked containers create strong diagonals and depth.
  container(20.4, 0, -16.6, 0.12);
  container(20.0, 2.58, -16.8, 0.12);
  container(22.5, 0, -8.7, Math.PI * 0.5);
  container(22.2, 0, 8.2, -0.08);
  box('concrete', 13.6, 0, -15.0, 3.2, 1.05, 1.0);
  box('concrete', 11.8, 0, -13.0, 3.2, 1.05, 1.0, { ry: 0.18 });
  for (const x of [9.8, 15.5, 27]) for (const z of [-20, 13]) cyl('rustedSteel', x, 0, z, 0.34, 0.9, { sides: 16 });

  // Pipes and HVAC make the long west wall read as authored architecture.
  // Stood off to x=-29.5 so the run passes in front of the new pilasters (which
  // project to -29.9) instead of through them; the bracket now spans wall to
  // pipe. z=16 moved to 17.4 for the same reason — it sat on a pilaster.
  for (const z of [-19, -13, 4, 10, 17.4]) {
    cyl('rustedSteel', -29.5, 1.0, z, 0.13, 4.2, { sides: 10, collide: false });
    box('paintedMetal', -29.95, 1.2, z, 0.9, 0.12, 0.28, { collide: false });
    box('paintedMetal', -29.95, 4.35, z, 0.9, 0.12, 0.28, { collide: false });
  }
  for (const x of [-15, -11.6]) {
    box('paintedMetal', x, 0, 18.7, 2.7, 1.5, 2.1);
    for (let q = -1; q <= 1; q += 0.33) box('rustedSteel', x + q, 1.48, 18.7, 0.05, 0.18, 1.9, { collide: false });
    cyl('rustedSteel', x, 1.55, 18.7, 0.48, 0.18, { sides: 14, collide: false });
  }

  // Foreground storytelling clutter, cover, and silhouette breakup.
  pallet(7.2, 0, 14.5, 0.18); pallet(8.0, 0.18, 14.4, 0.18);
  crate(5.9, 0.2, 14.5, 1.15); crate(7.4, 0.2, 13.5, 0.9);
  // Was the lone prop at (-15.5, 9). Now a sunlit pair on the bay's forecourt —
  // inside the bay both faces crushed to luma 0 (see the bay block below).
  crate(-15.2, 0, 5.0, 1.3); crate(-13.9, 0, 4.6, 0.95);
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2, rr = 0.4 + rng() * 2.4, s = 0.10 + rng() * 0.22;
    box(i % 3 ? 'concrete' : 'rustedSteel', -12 + Math.cos(a) * rr, 0.02, -18 + Math.sin(a) * rr, s, s * (0.5 + rng()), s * 1.4, { ry: a, collide: false });
  }
  // Cluster one: powered breach-staging station beside OPS-01. The generator,
  // cases and cable route tell one compact story while leaving the portal clear.
  box('paintedMetal', -7.55, 0, -2.35, 1.45, 0.86, 0.82, { ry: 0.08 });
  box('rustedSteel', -7.55, 0.82, -2.35, 1.50, 0.07, 0.86, { ry: 0.08, collide: false });
  for (let i = -3; i <= 3; i++) box('rustedSteel', -7.18, 0.18 + (i + 3) * 0.075, -1.94, 0.56, 0.025, 0.035, { ry: 0.08, collide: false });
  for (const x of [-8.05, -7.06]) for (const z of [-2.70, -2.00]) cyl('rubber', x, 0.04, z, 0.19, 0.14, { sides: 14, rx: Math.PI * 0.5, collide: false });
  equipmentCase(-2.72, 0, -2.62, -0.12, 0.86);
  equipmentCase(-2.48, 0.42, -2.72, 0.05, 0.67);
  drum(-8.72, 0, -2.65, 'rustedSteel');
  // Tripod work lamp and power cable, all decorative and batched.
  beam('rustedSteel', [-3.15, 0.05, -2.0], [-3.15, 1.75, -2.0], 0.035, { collide: false });
  beam('rustedSteel', [-3.15, 0.72, -2.0], [-3.62, 0.02, -2.35], 0.025, { collide: false });
  beam('rustedSteel', [-3.15, 0.72, -2.0], [-2.68, 0.02, -2.35], 0.025, { collide: false });
  box('paintedMetal', -3.15, 1.74, -2.02, 0.58, 0.34, 0.18, { collide: false });
  box('tile', -3.15, 1.79, -1.91, 0.42, 0.20, 0.035, { collide: false });
  beam('rubber', [-7.42, 0.05, -1.92], [-6.2, 0.025, -2.25], 0.032, { collide: false });
  beam('rubber', [-6.2, 0.025, -2.25], [-4.8, 0.025, -3.25], 0.032, { collide: false });

  // Cluster two: wrecked utility vehicle and improvised recovery station.
  box('paintedMetal', 9.8, 0.55, 4.8, 4.2, 1.0, 1.85, { ry: -0.22 });
  box('paintedMetal', 9.2, 1.52, 4.95, 2.1, 0.85, 1.72, { ry: -0.22, collide: false });
  for (const q of [-1.45, 1.25]) for (const zz of [-0.88, 0.88]) cyl('rubber', 9.8 + q * 0.976 + zz * -0.218, 0.18, 4.8 + q * 0.218 + zz * 0.976, 0.42, 0.22, { sides: 16, rx: Math.PI * 0.5, collide: false });
  box('glass', 9.22, 1.70, 4.08, 1.45, 0.43, 0.035, { ry: -0.22, collide: false });
  box('glass', 9.22, 1.70, 5.82, 1.45, 0.43, 0.035, { ry: -0.22, collide: false });
  box('rustedSteel', 11.93, 0.63, 4.31, 0.22, 0.28, 2.05, { ry: -0.22, collide: false });
  box('rustedSteel', 7.70, 0.63, 5.28, 0.22, 0.28, 2.05, { ry: -0.22, collide: false });
  // A-frame hoist, hanging cable, detached wheel and service supplies.
  beam('rustedSteel', [13.0, 0, 6.25], [13.0, 2.85, 6.25], 0.095);
  beam('rustedSteel', [15.25, 0, 6.25], [15.25, 2.85, 6.25], 0.095);
  beam('rustedSteel', [13.0, 2.85, 6.25], [15.25, 2.85, 6.25], 0.11);
  beam('rustedSteel', [14.13, 2.82, 6.25], [12.0, 1.70, 5.30], 0.055, { collide: false });
  beam('rubber', [12.0, 1.70, 5.30], [10.75, 1.35, 5.05], 0.025, { collide: false });
  equipmentCase(14.15, 0, 7.10, 0.04, 0.9);
  drum(15.55, 0, 7.20, 'paintedMetal');
  drum(16.18, 0, 7.32, 'rustedSteel');
  cyl('rubber', 12.55, 0.08, 7.32, 0.44, 0.24, { sides: 18, rx: Math.PI * 0.5, collide: false });
  for (const [x, z] of [[11.9, 6.4], [12.4, 6.9], [16.7, 6.7]]) {
    const g = new THREE.ConeGeometry(0.19, 0.55, 10); g.translate(x, 0.275, z); batch('asphaltLane', g);
  }
  // Utility pole and deliberately sagged service run connect both work zones
  // and put a thin silhouette break across the otherwise empty courtyard air.
  beam('rustedSteel', [3.2, 0, 0.8], [3.2, 4.65, 0.8], 0.085);
  beam('rustedSteel', [2.55, 4.48, 0.8], [3.85, 4.48, 0.8], 0.055, { collide: false });
  beam('rubber', [-0.25, 4.18, -3.85], [1.45, 3.72, -1.45], 0.026, { collide: false });
  beam('rubber', [1.45, 3.72, -1.45], [3.2, 4.38, 0.8], 0.026, { collide: false });
  beam('rubber', [3.2, 4.38, 0.8], [7.2, 3.72, 2.9], 0.026, { collide: false });
  beam('rubber', [7.2, 3.72, 2.9], [10.4, 3.05, 4.75], 0.026, { collide: false });

  // ---- south yard midground ------------------------------------------------
  // The right half of the overlook frame was a flat sand expanse holding one
  // 1.3 m crate: nothing at all between the near railing and the 8 m south wall
  // 34 m away, so the frame had no depth cue and the yard read as a car park.
  // Two large masses answer that in preference to more scattered props, and the
  // placement is measured rather than eyeballed — projecting world points into
  // the overlook camera (fov 80, aspect 16:9, eye 1.58 over the 3.38 m catwalk)
  // puts the empty band at px 850-1280, which is ground x -20..-6, z 5..22.
  // The frame now reads railing -> bay (22 m) -> tower (32 m) -> wall (34 m).
  // Both masses are open underneath, and both clear the spawn-to-OPS-01 lane.
  const BAY_X = -12, BAY_Z = 13, BAY_H = 4.6;
  box('concreteFloor', BAY_X, 0, BAY_Z, 11.4, 0.14, 8.4, { collide: false });
  // Concrete frame, not painted steel: six 4.6 m posts in paintedMetal read as
  // six saturated blue verticals and fought the yard's palette for attention.
  for (const cx of [BAY_X - 4.9, BAY_X, BAY_X + 4.9]) for (const cz of [BAY_Z - 3.4, BAY_Z + 3.4]) {
    box('concrete', cx, 0, cz, 0.42, BAY_H, 0.42);
    box('concrete', cx, 0, cz, 0.62, 0.22, 0.62, { collide: false });            // footing
    box('concrete', cx, BAY_H - 0.3, cz, 0.6, 0.3, 0.6, { collide: false });     // capital
  }
  // Spandrel beams tie the columns front and back. The roof plane itself is
  // invisible from the catwalk — the camera sits 0.04 m under the deck, so the
  // deck subtends about 1 px — which means the whole mass has to be carried by
  // its elevation. Without these it was six posts under a plank.
  for (const cz of [BAY_Z - 3.4, BAY_Z + 3.4]) box('concrete', BAY_X, BAY_H - 0.72, cz, 10.6, 0.72, 0.3, { collide: false });
  for (const cx of [BAY_X - 4.9, BAY_X + 4.9]) box('concrete', cx, BAY_H - 0.72, BAY_Z, 0.3, 0.72, 7.1, { collide: false });
  box('corrugated', BAY_X, BAY_H, BAY_Z, 11.8, 0.32, 8.8);                       // roof deck
  box('concrete', BAY_X, BAY_H - 0.14, BAY_Z - 4.4, 11.8, 0.46, 0.22, { collide: false });   // fascia
  for (let i = -1; i <= 1; i++) box('rustedSteel', BAY_X, BAY_H - 0.2, BAY_Z + i * 2.6, 11.4, 0.2, 0.14, { collide: false });
  // Back and end walls stop 1.6 m short of the deck. That clerestory band is
  // what a real shed has, and it is also the fix for a crushed-black pocket the
  // first version created: jammed to the deck, the wall/roof junction and the
  // internal corner painted solid magenta in the crush map — the same
  // contact-occlusion failure the sally-port conduits had in Phase 2. The end
  // wall also stops short in z so the two never form an occluded inside corner.
  box('corrugated', BAY_X, 0, BAY_Z + 3.9, 11.0, 3.0, 0.22);
  box('corrugated', BAY_X - 5.5, 0, BAY_Z - 1.9, 0.22, 3.0, 4.0);
  // Bay contents: few and large, so the shaded volume reads as occupied without
  // becoming the scatter this whole pass is removing.
  // Only the bench stays under the roof — it sits against the back wall where the
  // clerestory reaches it. Everything else is on the forecourt at z < 5.89, which
  // is where the roof's ground shadow ends: the roof spans z 8.6..17.4 and the sun
  // travels (0.42, -0.78, -0.46), so it shadows x -15.4..-3.6, z 5.9..14.7. Props
  // parked inside that box get neither sun nor sky and measured as solid crush —
  // the crate alone painted ~1 k px of the crush map magenta.
  box('wood', BAY_X - 2.4, 0.88, BAY_Z + 2.9, 4.2, 0.12, 0.8, { collide: false });
  for (const q of [-1.9, 1.9]) box('rustedSteel', BAY_X - 2.4 + q, 0, BAY_Z + 2.9, 0.09, 0.88, 0.7, { collide: false });
  drum(-11.9, 0, 5.2, 'rustedSteel');
  drum(-11.25, 0, 5.35, 'paintedMetal');
  pallet(-16.6, 0, 5.2, 0.22);

  // Water tower — the far layer, and the yard's only landmark that breaks the
  // wall line. Height is measured, not guessed: at 9.6 m the tank projects to
  // py ~224 in the overlook frame against a south wall top of py ~258, so it
  // silhouettes against sky rather than grazing the wall edge. Legs are vertical
  // (a splayed beam's AABB would be a metre of phantom collision) and the spawn
  // at (2, 0, 21) stays 3.7 m clear of the nearest one.
  const TW_X = -3.0, TW_Z = 20.8, TW_LEG = 4.6;
  for (const lx of [-1.55, 1.55]) for (const lz of [-1.55, 1.55]) {
    beam('rustedSteel', [TW_X + lx, 0, TW_Z + lz], [TW_X + lx, TW_LEG, TW_Z + lz], 0.105);
  }
  for (const [ax, az, bx, bz] of [
    [-1.55, -1.55, 1.55, -1.55], [1.55, -1.55, 1.55, 1.55],
    [1.55, 1.55, -1.55, 1.55], [-1.55, 1.55, -1.55, -1.55],
  ]) for (const [y0, y1] of [[0.55, 2.35], [2.35, 4.15]]) {
    beam('rustedSteel', [TW_X + ax, y0, TW_Z + az], [TW_X + bx, y1, TW_Z + bz], 0.035, { collide: false });
    beam('rustedSteel', [TW_X + ax, y1, TW_Z + az], [TW_X + bx, y0, TW_Z + bz], 0.035, { collide: false });
  }
  box('rustedSteel', TW_X, TW_LEG - 0.22, TW_Z, 3.6, 0.22, 3.6, { collide: false });
  cyl('paintedMetal', TW_X, TW_LEG, TW_Z, 2.2, 4.2, { sides: 20 });
  for (const y of [0.5, 2.1, 3.7]) cyl('rustedSteel', TW_X, TW_LEG + y, TW_Z, 2.24, 0.14, { sides: 20, collide: false });
  cyl('paintedMetal', TW_X, TW_LEG + 4.2, TW_Z, 1.5, 0.34, { sides: 16, collide: false });
  cyl('rustedSteel', TW_X, TW_LEG + 4.54, TW_Z, 0.16, 0.5, { sides: 8, collide: false });
  for (const q of [-0.34, 0.34]) beam('rustedSteel', [TW_X + 2.28, 0.2, TW_Z + q], [TW_X + 2.28, TW_LEG + 4.1, TW_Z + q], 0.035, { collide: false });
  for (let y = 0.5; y < TW_LEG + 4.0; y += 0.42) box('rustedSteel', TW_X + 2.28, y, TW_Z, 0.06, 0.05, 0.72, { collide: false });
  beam('rustedSteel', [TW_X - 2.12, 0, TW_Z + 0.95], [TW_X - 2.12, TW_LEG + 0.7, TW_Z + 0.95], 0.075, { collide: false });

  // Wordless wayfinding panels and hazard chevrons as thin geometry.
  // Mounted at z=25.82, proud of the south wall's pilaster faces (25.9), so the
  // panel reads as bolted across the bays rather than pierced by one.
  box('paintedMetal', 13.0, 2.0, 25.82, 6.8, 2.1, 0.08, { collide: false });
  for (let i = -4; i <= 4; i++) box(i % 2 ? 'asphaltLane' : 'rustedSteel', 13 + i * 0.72, 2.15, 25.74, 0.42, 1.55, 0.05, { ry: -0.43, collide: false });
  for (const x of [-8.5, -6.9, -5.3, -3.7, -2.1]) box('tile', x, 5.0, -3.54, 0.75, 0.5, 0.06, { collide: false });

  // Merge each material batch: hundreds of authored pieces, one draw per material.
  for (const [mat, geos] of batches) {
    const g = mergeGeometries(geos, false);
    for (const q of geos) q.dispose();
    if (!g) continue;
    const m = new THREE.Mesh(g, mats.get(mat));
    m.name = `level.${mat}`; m.castShadow = m.receiveShadow = true;
    root.add(m); owned.push(g);
  }

  const collider = createCollider(brushes, { floor: 0 });
  scene.fog = new THREE.FogExp2(0x8fa2b8, 0.0085);
  const portalLight = new THREE.PointLight(0xffa65c, 24, 9, 1.8);
  portalLight.position.set(-4.8, 2.0, -5.35); portalLight.castShadow = false; scene.add(portalLight);
  const workLight = new THREE.PointLight(0xffcf8d, 8, 7, 2);
  workLight.position.set(-3.15, 1.9, -1.75); workLight.castShadow = false; scene.add(workLight);
  const catLight = new THREE.PointLight(0x78aee8, 6, 8, 2);
  catLight.position.set(-24, 2.45, -4); catLight.castShadow = false; scene.add(catLight);
  // The sally port is roofed, so the sun never reaches it. Without this it becomes
  // exactly the unlit recess the void was traded for.
  // Sited near the mouth, not mid-passage: falloff then leaves the bulkhead face
  // dark so the sunlit backdrop through the breach is the brightest thing in the
  // frame and the eye is pulled through it.
  const gateLight = new THREE.PointLight(0xffc79a, 17, 11, 2);
  gateLight.position.set(0.3, 4.4, -29.5); gateLight.castShadow = false; scene.add(gateLight);

  return {
    root, brushes,
    collide: collider.collide,
    raycast: collider.raycast,
    collisionStats: collider.stats,
    spawns: [new THREE.Vector3(2, 0, 21)],
    aiSpawns: [
      new THREE.Vector3(-17, 0, -16), new THREE.Vector3(17, 0, -20),
      new THREE.Vector3(23, 0, 15), new THREE.Vector3(-20, 3.38, -4),
    ],
    poses: {
      hero: { pos: new THREE.Vector3(-14, 0, 6.5), yaw: -0.683, pitch: -0.045, ads: false },
      corridor: { pos: new THREE.Vector3(-26, 0, 16), yaw: -0.08, pitch: -0.02, ads: false },
      ads: { pos: new THREE.Vector3(-14, 0, 6.5), yaw: -0.683, pitch: -0.045, ads: true },
      overlook: { pos: new THREE.Vector3(-24, 3.38, -3.7), yaw: -1.82, pitch: -0.14, ads: false },
      enemy: { pos: new THREE.Vector3(-14, 0, -10), yaw: 0.464, pitch: -0.02, ads: false },
      // 3.2 m off the catwalk hostile, framed left of the viewmodel — the only
      // framing that resolves anatomy.
      enemyClose: { pos: new THREE.Vector3(-23.2, 3.38, -4.0), yaw: -1.87, pitch: -0.06, ads: false },
      diagLeft: { pos: new THREE.Vector3(-24, 3.38, -3.7), yaw: -0.25, pitch: -0.02, ads: false },
      // Straight down the gate axis from mid-yard, and again from inside the port.
      // x=2.4 clears the OPS-01 block's +x face at x=0.5 and lines up on the breach.
      gate: { pos: new THREE.Vector3(2.4, 0, -8.5), yaw: 0.0, pitch: 0.035, ads: false },
      gateIn: { pos: new THREE.Vector3(-1.2, 0, -29.4), yaw: -0.16, pitch: 0.06, ads: false },
      // Perimeter trim cannot be judged from `overlook` — the south wall is 34 m
      // out there, where a 0.5 m cornice is 6 px. This frames the WEST wall at
      // 8.4 m, which is also the hard case: its inner face never sees the sun,
      // so it is the test of whether the banding reads on hemisphere fill alone.
      wallW: { pos: new THREE.Vector3(-22, 0, 8), yaw: 1.5708, pitch: 0.06, ads: false },
      // The new south-yard masses from the player's actual spawn approach.
      bay: { pos: new THREE.Vector3(2, 0, 19), yaw: 1.166, pitch: 0.02, ads: false },
    },
    step() {},
    dispose() {
      for (const g of owned) g.dispose();
      scene.remove(root, portalLight, workLight, catLight, gateLight);
    },
  };
}
