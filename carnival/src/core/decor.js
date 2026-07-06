// decor.js — shared "carnival dressing" so each booth reads as a booth: drooping string-lights,
// pennant bunting, striped corner poles, a top valance. Emissive parts bloom under the post stack.
// Static (one group); a subtle bulb shimmer is handled by the render-time updateAtmosphere flicker.
import { mat } from './materials.js';

// opts: { theme:0xRRGGBB (accent), span:halfWidth, back:z of the back wall, front:z (default 1) }
export function carnivalDress(THREE, scene, opts = {}) {
  const accent = opts.theme ?? 0x39ff88, W = opts.span ?? 6, back = opts.back ?? -6, front = opts.front ?? 1.2;
  const g = new THREE.Group();
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: accent, emissiveIntensity: 2.6, roughness: 0.5 });
  const bulbMat2 = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0xff2fb0, emissiveIntensity: 2.4, roughness: 0.5 });
  const bulbGeo = new THREE.SphereGeometry(0.05, 8, 6);

  // two catenary strings of bulbs sagging across the front, plus one across the back
  const drape = (y0, zz, sag, n) => {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), x = -W + u * 2 * W, y = y0 - sag * Math.sin(u * Math.PI); // droop
      const b = new THREE.Mesh(bulbGeo, i % 2 ? bulbMat2 : bulbMat); b.position.set(x, y, zz); g.add(b);
    }
    // the wire
    const pts = []; for (let i = 0; i <= 20; i++) { const u = i / 20; pts.push(new THREE.Vector3(-W + u * 2 * W, y0 - sag * Math.sin(u * Math.PI), zz)); }
    const wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x223330 }));
    g.add(wire);
  };
  drape(5.2, front - 0.2, 0.7, 22);
  drape(6.0, (front + back) / 2, 0.9, 20);

  // pennant bunting (alternating neon triangles) hanging from the front string
  const triGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.16, 0, 0), new THREE.Vector3(0.16, 0, 0), new THREE.Vector3(0, -0.32, 0)]);
  triGeo.setIndex([0, 1, 2]); triGeo.computeVertexNormals();
  for (let i = 0; i < 18; i++) {
    const u = i / 17, x = -W + u * 2 * W, y = 5.2 - 0.7 * Math.sin(u * Math.PI) - 0.05;
    const m = new THREE.MeshStandardMaterial({ color: i % 2 ? accent : 0xff2fb0, emissive: i % 2 ? accent : 0xff2fb0, emissiveIntensity: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
    const tri = new THREE.Mesh(triGeo, m); tri.position.set(x, y, front - 0.2); g.add(tri);
  }

  // striped corner poles + a top valance banner
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 5.4, 12);
  for (const sx of [-1, 1]) {
    const pole = new THREE.Mesh(poleGeo, mat.metal([200, 200, 210])); pole.position.set(sx * W, 2.7, front - 0.1); pole.castShadow = true; g.add(pole);
    for (let k = 0; k < 9; k++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 6, 14), new THREE.MeshStandardMaterial({ color: k % 2 ? 0xd01030 : 0xf0f0f0, roughness: 0.6 })); ring.position.set(sx * W, 0.4 + k * 0.6, front - 0.1); ring.rotation.x = Math.PI / 2; g.add(ring); }
  }
  const valance = new THREE.Mesh(new THREE.BoxGeometry(2 * W, 0.5, 0.1), new THREE.MeshStandardMaterial({ color: 0x0c1a14, emissive: accent, emissiveIntensity: 0.25, roughness: 0.8 }));
  valance.position.set(0, 5.3, front - 0.05); g.add(valance);

  scene.add(g);
  return g;
}
