// fx.js — pooled visual FX (render-side; takes THREE as a param, imports nothing → one-dep rule kept).
// makeBurst: one InstancedMesh of tetrahedra, ring-allocated, spawned only from the caller's SEEDED rng
// and stepped in the game's step → deterministic + visual-only. makeTrajLine: preallocated line for the
// basketball/skeeball preview, positions written from the pure-sim buffer. See plan.md §3.3.

export function makeBurst(THREE, scene, { n = 128, size = 0.035 } = {}) {
  const geo = new THREE.TetrahedronGeometry(size);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0xffffff, emissiveIntensity: 1.5, roughness: 0.5, metalness: 0.2 });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  const P = new Float32Array(n * 3), V = new Float32Array(n * 3), life = new Float32Array(n);
  let head = 0;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, hide);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.setColorAt(0, _c.set(0xffffff)); mesh.instanceColor.needsUpdate = true; // alloc instanceColor
  scene.add(mesh);

  return {
    mesh,
    // pos: {x,y,z}; rng: caller's seeded mulberry32; deterministic spherical spread.
    spawn(pos, count, rng, speed = 3, color = 0x8fffe0) {
      _c.set(color);
      for (let k = 0; k < count; k++) {
        const i = head; head = (head + 1) % n;
        const u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u); // uniform on sphere
        V[i * 3] = r * Math.cos(th) * speed; V[i * 3 + 1] = u * speed + speed * 0.4; V[i * 3 + 2] = r * Math.sin(th) * speed;
        P[i * 3] = pos.x; P[i * 3 + 1] = pos.y; P[i * 3 + 2] = pos.z; life[i] = 1;
        mesh.setColorAt(i, _c);
      }
      mesh.instanceColor.needsUpdate = true;
    },
    step(dt) {
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt * 1.6;
        V[i * 3 + 1] -= 9.81 * dt;
        P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
        if (life[i] <= 0) { mesh.setMatrixAt(i, hide); continue; }
        const l = life[i];
        _p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); _q.set(0, 0, 0, 1); _s.set(l, l, l);
        _m.compose(_p, _q, _s); mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    teardown() { scene.remove(mesh); geo.dispose(); mat.dispose(); }
  };
}

export function makeTrajLine(THREE, scene, { n = 64, color = 0x8fffe0 } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
  const line = new THREE.Line(geo, mat); line.frustumCulled = false; line.visible = false;
  scene.add(line);

  return {
    line,
    // flat: Float32Array [x,y,z,...] from the pure sim; count = point count.
    set(flat, count) {
      const c = Math.min(count, n);
      pos.set(flat.subarray ? flat.subarray(0, c * 3) : flat.slice(0, c * 3));
      geo.attributes.position.needsUpdate = true; geo.setDrawRange(0, c);
    },
    show(on) { line.visible = !!on; },
    teardown() { scene.remove(line); geo.dispose(); mat.dispose(); }
  };
}
