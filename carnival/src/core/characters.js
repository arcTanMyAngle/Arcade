// characters.js — procedural "attendants": uncanny humanoids built from primitives (no models).
// Weaponized uncanny valley: subtly wrong proportions, too-still, slow head-track, sudden twitches,
// glowing eyes, stiff reactions. One or two per booth. Animation is time-driven (deterministic).
import { uncannySkew } from './materials.js';

const hash = (i) => { const s = Math.sin(i * 91.7 + 3.3) * 43758.5453; return s - Math.floor(s); };

// opts: { at:[x,y,z], face:yawRad, hue:0xRRGGBB, kind:'barker'|'clown'|'attendant', audio }
export function makeAttendant(THREE, scene, opts = {}) {
  const at = opts.at || [0, 0, 0], hue = new THREE.Color(opts.hue ?? 0x3a6b52);
  const seed = (at[0] * 13.1 + at[2] * 7.7) | 0;
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.82, 0.74, 0.66).multiplyScalar(0.9), roughness: 0.72, metalness: 0.02 });
  const cloth = new THREE.MeshStandardMaterial({ color: hue, roughness: 0.7, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0f0d, roughness: 0.9 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xbfffe0, emissiveIntensity: 3.2, roughness: 0.4 });

  const root = new THREE.Group(); root.position.set(at[0], at[1], at[2]); root.rotation.y = opts.face || 0;
  const cyl = (rt, rb, h, m) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 12), m);

  // legs
  for (const sx of [-1, 1]) { const leg = cyl(0.07, 0.06, 0.9, dark); leg.position.set(sx * 0.11, 0.45, 0); leg.castShadow = true; root.add(leg); }
  // torso (tapered, slightly hunched) + arms on shoulder pivots
  const torso = cyl(0.16, 0.22, 0.8, cloth); torso.position.set(0, 1.28, 0); torso.castShadow = true; uncannySkew(torso, seed, 0.06); root.add(torso);
  const arms = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(sx * 0.22, 1.62, 0); root.add(sh);
    const upper = cyl(0.05, 0.05, 0.42, cloth); upper.position.set(0, -0.21, 0); sh.add(upper);
    const fore = new THREE.Group(); fore.position.set(0, -0.42, 0); sh.add(fore);
    const lower = cyl(0.045, 0.05, 0.42 * (sx < 0 ? 1.08 : 1), skin); lower.position.set(0, -0.21, 0); fore.add(lower); // asymmetric arm length
    sh.rotation.x = 0.15; arms.push({ sh, fore, sx });
  }
  // neck + head (too large) + eyes + mouth
  const neck = cyl(0.05, 0.06, 0.14, skin); neck.position.set(0, 1.74, 0); root.add(neck);
  const headG = new THREE.Group(); headG.position.set(0, 1.9, 0); root.add(headG);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 16), skin); head.castShadow = true; uncannySkew(head, seed + 2, 0.08); headG.add(head);
  const eyes = [];
  for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), eyeMat); e.position.set(sx * 0.06, 0.02, 0.15); headG.add(e); eyes.push(e); }
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.012, 0.02), dark); mouth.position.set(0, -0.07, 0.16); headG.add(mouth);

  // kind flavor
  if (opts.kind === 'barker') { const hat = cyl(0.14, 0.16, 0.22, cloth); hat.position.set(0, 0.2, 0); headG.add(hat); const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 16), cloth); brim.position.set(0, 0.09, 0); headG.add(brim); }
  else if (opts.kind === 'clown') { const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 1.2 })); nose.position.set(0, -0.02, 0.18); headG.add(nose); const tuft = (sx) => { const t = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshStandardMaterial({ color: 0xff2fb0, roughness: 1 })); t.position.set(sx * 0.15, 0.08, 0); headG.add(t); }; tuft(-1); tuft(1); }

  scene.add(root);
  const _wp = new THREE.Vector3();
  let react = { k: null, t0: 0 }, baseArm = 0.15;

  return {
    group: root,
    react(kind) { react = { k: kind, t0: -1 }; },     // t0 set on next update
    update(t, watch) {
      if (react.t0 < 0) react.t0 = t;
      const rt = t - react.t0;
      // idle: breathing + faint sway
      torso.scale.y = 1 + 0.02 * Math.sin(t * 2.1);
      root.rotation.z = 0.02 * Math.sin(t * 0.7 + seed);
      root.position.y = at[1] + 0.012 * Math.sin(t * 2.1);

      // head: track the ball if given, else slow drift with sudden twitches
      let ty = 0, tp = 0;
      if (watch) {
        root.getWorldPosition(_wp);
        ty = Math.atan2(watch.x - _wp.x, watch.z - _wp.z) - (opts.face || 0);
        tp = -Math.atan2(watch.y - 1.9, Math.hypot(watch.x - _wp.x, watch.z - _wp.z)) * 0.6;
      } else {
        const twitch = hash((t * 1.3 | 0) + seed) < 0.04 ? (hash(t | 0) - 0.5) * 1.2 : 0; // sudden jerk
        ty = 0.5 * Math.sin(t * 0.23 + seed) + twitch;
      }
      headG.rotation.y += (Math.max(-1.4, Math.min(1.4, ty)) - headG.rotation.y) * 0.12;
      headG.rotation.x += (Math.max(-0.6, Math.min(0.6, tp)) - headG.rotation.x) * 0.12;

      // blink (both eyes) — rare, quick
      const blink = hash((t * 2 | 0) * 1.7 + seed) < 0.06 ? 0.12 : 1;
      eyes.forEach((e) => e.scale.y = blink);

      // reactions (stiff, brief)
      let armT = baseArm;
      if (react.k === 'cheer' && rt < 1.1) { armT = -1.9 + Math.abs(Math.sin(rt * 22)) * 0.5; mouth.scale.y = 3; if (rt < 0.05) opts.audio?.playSpatial?.('murmur', worldHead(root, _wp)); }
      else if (react.k === 'nod' && rt < 0.6) { headG.rotation.x = -0.5 + 0.5 * Math.sin(rt * 12); }
      else if (react.k === 'shake' && rt < 0.7) { headG.rotation.y += 0.35 * Math.sin(rt * 20); mouth.scale.y = 1; }
      else { mouth.scale.y = 1; if (react.k && rt > 1.2) react.k = null; }
      arms.forEach((a) => { a.sh.rotation.x += (armT - a.sh.rotation.x) * 0.2; });
    },
    teardown() {
      root.traverse((n) => { n.geometry?.dispose?.(); const m = n.material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose?.()); });
      scene.remove(root);
    }
  };
}
function worldHead(root, out) { root.getWorldPosition(out); out.y += 1.9; return out; }
