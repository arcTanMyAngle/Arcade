// Pooled combat effects. Event consumers accept both `point` and legacy `pos`.

import * as THREE from 'three';
import { createParticles } from './particles.js';
import { createDecals } from './decals.js';
import { sparkSprite, puffSprite, tracerSprite, flashSprite, kindOf, KIND_DUST, KIND_FX } from './sprites.js';

function texture(img) {
  const t = new THREE.DataTexture(img.data, img.size, img.size, THREE.RGBAFormat);
  t.colorSpace = THREE.LinearSRGBColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

export function createFX({ scene, camera, bus, rng, mats }) {
  const group = new THREE.Group(); group.name = 'fx'; scene.add(group);
  const maps = [texture(sparkSprite()), texture(puffSprite((rng() * 0xffffffff) >>> 0)), texture(tracerSprite()), texture(flashSprite())];
  const sparks = createParticles({ name: 'fx.sparks', capacity: 384, map: maps[0], blending: THREE.AdditiveBlending, gravity: -8, drag: 1.8, stretch: 0.025, fadeIn: 0 });
  const dust = createParticles({ name: 'fx.dust', capacity: 320, map: maps[1], blending: THREE.NormalBlending, gravity: 0.5, drag: 2.2, fadeIn: 0.08, fadePow: 2.0 });
  const smoke = createParticles({ name: 'fx.smoke', capacity: 128, map: maps[1], blending: THREE.NormalBlending, gravity: 0.8, drag: 1.4, fadeIn: 0.18, fadePow: 1.3 });
  const tracers = createParticles({ name: 'fx.tracers', capacity: 64, map: maps[2], blending: THREE.AdditiveBlending, gravity: 0, drag: 0, stretch: 0.018, fadeIn: 0 });
  const flashes = createParticles({ name: 'fx.flashes', capacity: 24, map: maps[3], blending: THREE.AdditiveBlending, gravity: 0, drag: 12, fadeIn: 0, fadePow: 3 });
  const pools = [sparks, dust, smoke, tracers, flashes];
  for (const q of pools) group.add(q.mesh);
  const decals = createDecals({ perKind: 48, seed: (rng() * 0xffffffff) >>> 0 }); group.add(decals.group);

  const light = new THREE.PointLight(0xffb66b, 0, 5, 2); light.layers.enable(0); scene.add(light);
  let flashT = 0;
  const offs = [];

  offs.push(bus.on('weapon:fire', (e) => {
    const p = e.pos, d = e.dir; if (!p || !d) return;
    const mx = p.x + d.x * 0.48, my = p.y + d.y * 0.48 - 0.08, mz = p.z + d.z * 0.48;
    flashes.spawn(mx, my, mz, d.x * 0.2, d.y * 0.2, d.z * 0.2, 0.055, 0.18, 0.38, 1.0, 0.44, 0.12, 5.0, 0, rng() * 6.28, 8);
    const td = Math.min(e.maxDist ?? 70, 85);
    tracers.spawn(mx + d.x * 1.5, my + d.y * 1.5, mz + d.z * 1.5, d.x * 155, d.y * 155, d.z * 155, Math.max(0.025, td / 155), 0.035, 0.025, 1.0, 0.64, 0.25, 4.5, 0.2, 0, 0);
    light.position.set(mx, my, mz); light.intensity = 18; flashT = 0.05;
  }));

  offs.push(bus.on('weapon:impact', (e) => {
    const p = e.point ?? e.pos, n = e.normal; if (!p || !n) return;
    const k = kindOf(e.mat), cfg = KIND_FX[k], c = KIND_DUST[k];
    const sz = decals.sizeFor(k); decals.place(k, p.x, p.y, p.z, n.x, n.y, n.z, sz[0] + rng() * (sz[1] - sz[0]), rng() * Math.PI * 2, 35 + rng() * 25);
    for (let i = 0; i < cfg.sparks; i++) {
      let x = n.x + (rng() * 2 - 1) * 0.85, y = n.y + rng() * 1.3, z = n.z + (rng() * 2 - 1) * 0.85;
      const l = Math.hypot(x, y, z) || 1, sp = (2 + rng() * 10) * cfg.spark;
      sparks.spawn(p.x, p.y, p.z, x / l * sp, y / l * sp, z / l * sp, 0.14 + rng() * 0.36, 0.018, 0.008, 1, 0.42 + rng() * 0.3, 0.08, 6, 0, 0, 0);
    }
    for (let i = 0; i < cfg.dust; i++) {
      const sp = cfg.dustSpd * (0.25 + rng()), x = n.x * sp + (rng() * 2 - 1), y = n.y * sp + rng() * 1.4, z = n.z * sp + (rng() * 2 - 1);
      dust.spawn(p.x + n.x * 0.02, p.y + n.y * 0.02, p.z + n.z * 0.02, x, y, z, 0.35 + rng() * 0.7, 0.04, 0.24, c[0], c[1], c[2], 1.1, 0, rng() * 6.28, (rng() * 2 - 1) * 2);
    }
    for (let i = 0; i < cfg.smoke; i++) smoke.spawn(p.x, p.y, p.z, n.x * 0.25, 0.25 + rng() * 0.2, n.z * 0.25, 0.8 + rng() * 0.7, 0.08, 0.36, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 0.6, 0, rng() * 6.28, 0.3);
  }));

  offs.push(bus.on('player:land', (e) => {
    const p = e.pos; if (!p || (e.impact ?? 0) < 2) return;
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2, sp = 0.4 + rng();
      dust.spawn(p.x, p.y + 0.03, p.z, Math.cos(a) * sp, 0.15 + rng() * 0.35, Math.sin(a) * sp, 0.45 + rng() * 0.3, 0.05, 0.22, 0.35, 0.33, 0.3, 0.6, 0, a, 0.5);
    }
  }));

  return {
    step(dt) {
      for (const q of pools) q.step(dt); decals.step(dt);
      flashT = Math.max(0, flashT - dt); light.intensity = flashT > 0 ? 18 * flashT / 0.05 : 0;
    },
    render(alpha) { for (const q of pools) q.render(alpha); },
    dispose() {
      for (const off of offs) off(); for (const q of pools) q.dispose(); decals.dispose();
      for (const t of maps) t.dispose(); scene.remove(light, group);
    },
  };
}
