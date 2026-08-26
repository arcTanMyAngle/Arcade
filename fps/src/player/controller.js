// FPS movement + camera. OWNED BY: movement/feel agent.
//
// Contract: sim advances ONLY in step(dt, frame) at a fixed 128 Hz; pose(alpha)
// is display-only and must never mutate sim state. Every camera effect therefore
// lives as a sim-side scalar that is snapshotted into `P` at the top of each tick
// and interpolated in pose() — anything applied raw from a 128 Hz value visibly
// stutters on a 144 Hz display.
//
// Feature set: accel/friction ground movement, air control, sprint -> tac-sprint,
// ADS slowdown, crouch (with uncrouch blocking), step-up, slide (+ slide-cancel
// jump), mantle/vault, figure-8 head bob, strafe roll, landing kick, idle
// breathing with hold-breath, fall damage.
//
// All tuning numbers + their reasoning live in ./tuning.js.

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, springDamp } from '../core/mathx.js';
import {
  SPEED, ACCEL, FRICTION, GRAVITY, JUMP, H, EYE, RADIUS, PITCH_LIMIT,
  STEP, SPRINT, SLIDE, MANTLE, FALL, CAM, BOB, BREATH,
} from './tuning.js';

// Scalars that are computed in the sim tick and read by pose(); each one is
// linearly interpolated between the previous and current tick value.
const IP = [
  'eye', 'lean', 'bobT', 'bobAmp', 'landDip', 'roll', 'kickPitch',
  'adsT', 'slideDip', 'slideRoll', 'mantleTilt', 'mantleRoll', 'breathT', 'breathAmp', 'fov',
];

export function createPlayer({ level, camera, bus, rng }) {
  const pos = level.spawns[0].clone();
  const prevPos = pos.clone();
  const vel = new THREE.Vector3();

  const state = {
    yaw: 0, pitch: 0,
    grounded: true, crouched: false, sprinting: false, tacSprint: false,
    sliding: false, mantling: false, blocked: 0,
    speed: 0, height: H.stand, eye: EYE.stand,
    lean: 0, leanV: 0,
    bobT: 0, bobAmp: 0,
    landDip: 0, landDipV: 0,
    kickPitch: 0, kickPitchV: 0,
    roll: 0, rollV: 0,
    slideT: 0, slideDip: 0, slideRoll: 0,
    mantleT: 0, mantleTilt: 0, mantleRoll: 0,
    breathT: 0, breathAmp: 0, breath: 1, holdBreath: 0,
    stepDist: 0,
    health: 100, alive: true,
    fov: CAM.fov,
    adsT: 0,                       // 0..1 ADS blend, read by weapons + fov
  };

  const P = {};                    // previous-tick snapshot of IP keys
  for (const k of IP) P[k] = state[k];

  let sprintHeld = 0, slideCd = 0, slideAir = 0;
  let jumpBuf = 0, coyote = JUMP.coyote;
  let prevJump = false, prevCrouch = false;
  let fallPeak = 0;                // highest y reached since leaving the ground

  const wish = new THREE.Vector3();
  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  // Pooled scratch — nothing in step()/pose() may allocate.
  const _des = new THREE.Vector3(), _res = new THREE.Vector3(), _from = new THREE.Vector3();
  const _cand = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const mant = { sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0, dur: 0.4 };

  // ---- probes ------------------------------------------------------------
  // Downward ray -> world-space floor height, or null if nothing within maxD.
  function probeFloor(x, z, fromY, maxD) {
    _o.set(x, fromY, z); _d.set(0, -1, 0);
    const h = level.raycast(_o, _d, maxD);
    return h ? fromY - h.dist : null;
  }

  // Is there room for the standing capsule at `p`? Two independent tests because
  // level.collide() only resolves radially: a ceiling slab directly overhead is
  // caught by the collide displacement test, a thin beam by the upward ray.
  function canStand(p) {
    _t.copy(p);
    const r = level.collide(_t, RADIUS, H.stand);
    const dx = r.pos.x - p.x, dz = r.pos.z - p.z, dy = r.pos.y - p.y;
    if (dx * dx + dz * dz > 1e-6 || dy > 1e-4) return false;   // pushed out / lifted => blocked
    _o.set(p.x, p.y + H.crouch * 0.92, p.z); _d.set(0, 1, 0);
    return !level.raycast(_o, _d, H.stand - H.crouch * 0.92 + 0.04);
  }

  // ---- movement resolution ----------------------------------------------
  // Integrates one tick of velocity against the level, with a step-up sweep so
  // small obstacles are walked over instead of stopping the player dead.
  // Writes `pos`, returns grounded.
  function moveResolve(dt) {
    _from.copy(pos);
    _des.copy(pos).addScaledVector(vel, dt);

    const r = level.collide(_des, RADIUS, state.height);
    _res.copy(r.pos);
    let grounded = r.grounded;

    const dX = _des.x - _from.x, dZ = _des.z - _from.z;
    const dLen = Math.hypot(dX, dZ);
    state.blocked = 0;

    if (dLen > 1e-5) {
      const nx = dX / dLen, nz = dZ / dLen;
      const got = (_res.x - _from.x) * nx + (_res.z - _from.z) * nz;   // progress along intent
      state.blocked = clamp01(1 - got / dLen);

      // Step-up: only from (or onto) the ground, only when actually obstructed,
      // and never while rising — you cannot ride a wall up mid-jump.
      if (state.blocked > 0.02 && (state.grounded || grounded) && vel.y <= 0.2) {
        _cand.set(_from.x + dX, _from.y + STEP.max, _from.z + dZ);
        const ru = level.collide(_cand, RADIUS, state.height);
        _cand.copy(ru.pos);
        const upGot = (_cand.x - _from.x) * nx + (_cand.z - _from.z) * nz;
        if (upGot > got + 1e-4) {
          // Probe the floor under the raised candidate and just ahead of it, so a
          // capsule half-on the step still finds the higher surface.
          const top = _from.y + STEP.max;
          const fa = probeFloor(_cand.x, _cand.z, top + 0.02, STEP.max + 0.06);
          const fb = probeFloor(_cand.x + nx * RADIUS * STEP.probeAhead, _cand.z + nz * RADIUS * STEP.probeAhead,
            top + 0.02, STEP.max + 0.06);
          let fy = fa === null ? fb : fb === null ? fa : Math.max(fa, fb);
          if (fy !== null && fy >= _from.y - 0.02 && fy <= _from.y + STEP.max + 1e-3) {
            _cand.y = Math.max(fy, _from.y);
            const rc = level.collide(_cand, RADIUS, state.height);
            // Accept only if the re-resolve leaves us where we asked to be —
            // otherwise the "step" was really a wall and we'd be teleporting into it.
            if (Math.abs(rc.pos.x - _cand.x) < 0.02 && Math.abs(rc.pos.z - _cand.z) < 0.02) {
              _res.copy(rc.pos);
              _res.y = _cand.y;
              grounded = true;
              if (vel.y < 0) vel.y = 0;
              state.blocked = clamp01(1 - upGot / dLen);
            }
          }
        }
      }
    }

    // Ceiling stop: level.collide resolves radially only, so a head-on jump into
    // an overhang would otherwise squirt the player sideways instead of stopping.
    if (vel.y > 0) {
      _o.set(_res.x, _res.y + state.height - 0.02, _res.z); _d.set(0, 1, 0);
      if (level.raycast(_o, _d, Math.max(0.02, vel.y * dt + 0.02))) vel.y = 0;
    }

    pos.copy(_res);
    return grounded;
  }

  // ---- mantle ------------------------------------------------------------
  // Returns true if a ledge was found and the climb was started.
  function tryMantle(f) {
    if (state.mantling || f.move.y < 0.2) return false;

    // (1) forward ray at chest height must hit a near-vertical face
    _o.set(pos.x, pos.y + Math.min(0.95, state.height * 0.55), pos.z);
    _d.copy(fwd);
    const wall = level.raycast(_o, _d, RADIUS + MANTLE.reach);
    if (!wall || Math.abs(wall.normal.y) > 0.5) return false;

    // (2) downward ray past the face finds the ledge top
    const ax = pos.x + fwd.x * (RADIUS + MANTLE.landAhead);
    const az = pos.z + fwd.z * (RADIUS + MANTLE.landAhead);
    const topY = pos.y + MANTLE.maxRise + 0.25;
    const ledge = probeFloor(ax, az, topY, MANTLE.maxRise + 0.30);
    if (ledge === null) return false;
    const rise = ledge - pos.y;
    if (rise < MANTLE.minRise || rise > MANTLE.maxRise) return false;

    // (3) headroom: the standing capsule must fit where we intend to land
    _cand.set(ax, ledge + 0.02, az);
    if (!canStand(_cand)) return false;

    mant.sx = pos.x; mant.sy = pos.y; mant.sz = pos.z;
    mant.ex = ax; mant.ey = ledge; mant.ez = az;
    mant.dur = lerp(MANTLE.durMin, MANTLE.durMax,
      clamp01((rise - MANTLE.minRise) / (MANTLE.maxRise - MANTLE.minRise)));
    state.mantling = true;
    state.mantleT = 0;
    state.sliding = false; state.slideT = 0;
    vel.set(0, 0, 0);
    bus.emit('player:mantle', { pos: pos.clone(), rise, dur: mant.dur });
    return true;
  }

  function stepMantle(dt) {
    state.mantleT = clamp01(state.mantleT + dt / mant.dur);
    const t = state.mantleT;
    // L-shaped path: vertical first (so the capsule clears the lip), then forward.
    const up = smoothstep(0, MANTLE.riseFrac, t);
    const over = smoothstep(MANTLE.riseFrac * 0.55, 1, t);
    pos.set(
      lerp(mant.sx, mant.ex, over),
      lerp(mant.sy, mant.ey, up),
      lerp(mant.sz, mant.ez, over)
    );
    // sin(pi t) => zero at both ends, so the camera never pops on entry/exit.
    const s = Math.sin(Math.PI * t);
    state.mantleTilt = -MANTLE.tilt * s;
    state.mantleRoll = MANTLE.roll * Math.sin(Math.PI * 2 * t);
    if (t >= 1) {
      state.mantling = false;
      state.mantleTilt = 0; state.mantleRoll = 0;
      vel.set(fwd.x * MANTLE.exitSpeed, 0, fwd.z * MANTLE.exitSpeed);
      state.grounded = true;
      coyote = JUMP.coyote;
      fallPeak = pos.y;
      bus.emit('player:land', { impact: 0, pos: pos.clone(), mantle: true });
    }
  }

  // ---- damage ------------------------------------------------------------
  function damage(amount, cause = 'generic', src = null) {
    if (!state.alive || amount <= 0) return;
    state.health = Math.max(0, state.health - amount);
    bus.emit('player:damage', { amount, cause, health: state.health, pos: pos.clone(), src });
    if (state.health <= 0) {
      state.alive = false;
      bus.emit('player:death', { cause, pos: pos.clone() });
    }
  }

  function step(dt, f) {
    prevPos.copy(pos);
    for (let i = 0; i < IP.length; i++) P[IP[i]] = state[IP[i]];

    // ---- look ----
    state.yaw -= f.look.x;
    state.pitch = clamp(state.pitch - f.look.y, -PITCH_LIMIT, PITCH_LIMIT);

    // yaw basis (recomputed every tick — look can change between ticks)
    fwd.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    right.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

    // ---- edge detection (frames carry held state only) ----
    const jumpEdge = f.jump && !prevJump;
    const crouchEdge = f.crouch && !prevCrouch;
    prevJump = f.jump; prevCrouch = f.crouch;
    jumpBuf = jumpEdge ? JUMP.buffer : Math.max(0, jumpBuf - dt);
    slideCd = Math.max(0, slideCd - dt);

    // ---- mantle owns the tick outright ----
    if (state.mantling) {
      stepMantle(dt);
      state.speed = 0;
      state.stepDist = 0;
      camFx(dt, f, true);
      return;
    }

    // ---- stance ----
    // Uncrouch is *requested*, not granted: standing up inside geometry is the
    // classic way to get shot through a ceiling or ejected across the map.
    let wantCrouch = f.crouch || state.sliding;
    if (!wantCrouch && state.crouched && !canStand(pos)) wantCrouch = true;
    state.crouched = wantCrouch;

    const stanceRate = state.sliding ? CAM.slideStanceRate : CAM.stanceRate;
    state.height = damp(state.height, wantCrouch ? H.crouch : H.stand, stanceRate, dt);
    state.eye = damp(state.eye, wantCrouch ? EYE.crouch : EYE.stand, stanceRate, dt);

    // ---- sprint ----
    const movingFwd = f.move.y > SPRINT.fwdIntent;
    state.sprinting = f.sprint && movingFwd && !f.crouch && !f.ads && state.grounded && !state.sliding;
    sprintHeld = state.sprinting ? sprintHeld + dt : 0;
    state.tacSprint = sprintHeld > SPRINT.tacDelay;
    state.adsT = damp(state.adsT, f.ads && !state.sprinting && !state.sliding ? 1 : 0, CAM.adsRate, dt);

    // ---- wish direction (yaw-relative, already normalized by input) ----
    wish.set(0, 0, 0).addScaledVector(right, f.move.x).addScaledVector(fwd, f.move.y);
    const wl = Math.min(1, wish.length());
    if (wl > 1e-4) wish.multiplyScalar(1 / wish.length());

    let hs = Math.hypot(vel.x, vel.z);

    // ---- slide state machine ----
    if (state.sliding) {
      state.slideT += dt;
      slideAir = state.grounded ? 0 : slideAir + dt;
      const cancel = jumpBuf > 0                          // slide-cancel: instant, keeps momentum
        || !f.crouch
        || state.slideT >= SLIDE.dur
        || hs < SLIDE.exitSpeed
        || slideAir > SLIDE.airGrace;
      if (cancel) endSlide();
    } else if (crouchEdge && state.grounded && slideCd <= 0 && hs >= SLIDE.minSpeed
               && (state.sprinting || state.tacSprint)) {
      // Impulse boost along current heading. Direction is taken from velocity, not
      // input, so you cannot use the boost to change direction for free.
      const k = SLIDE.boost / hs;
      vel.x *= k; vel.z *= k;
      hs = SLIDE.boost;
      state.sliding = true; state.slideT = 0; slideAir = 0;
      state.crouched = true;
      state.sprinting = false; state.tacSprint = false; sprintHeld = 0;
      bus.emit('player:slide', { pos: pos.clone(), speed: hs });
    }

    // ---- friction (BEFORE accel: Quake order; see tuning.js FRICTION) ----
    if (hs > 1e-4) {
      let fr;
      if (state.sliding) {
        // Quadratic ramp: nearly frictionless at entry, walk-grade drag by the end.
        const tn = clamp01(state.slideT / SLIDE.dur);
        fr = lerp(SLIDE.fricA, SLIDE.fricB, tn * tn);
      } else {
        fr = state.grounded ? FRICTION.ground : FRICTION.air;
      }
      const drop = Math.max(hs, FRICTION.stopSpeed) * fr * dt;
      const k = Math.max(0, hs - drop) / hs;
      vel.x *= k; vel.z *= k;
      hs *= k;
    }

    if (state.sliding) {
      // Steering redirects the velocity vector at a capped angular rate. Speed is
      // conserved exactly — a slide can never be used to accelerate.
      if (wl > 1e-4 && hs > 1e-4) {
        const cur = Math.atan2(vel.z, vel.x), tgt = Math.atan2(wish.z, wish.x);
        let d = (tgt - cur) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        const m = SLIDE.steer * dt;
        const a = cur + clamp(d, -m, m);
        vel.x = Math.cos(a) * hs; vel.z = Math.sin(a) * hs;
      }
    } else {
      // ---- horizontal accel, Quake-style projection ----
      // Only the component NOT already covered by current velocity is added, so
      // input alone can never exceed maxSpeed while external impulses survive.
      let maxSpeed = state.crouched ? SPEED.crouch
        : state.tacSprint ? SPEED.tacSprint
        : state.sprinting ? SPEED.sprint
        : lerp(SPEED.walk, SPEED.ads, state.adsT);
      if (!state.grounded) maxSpeed = Math.max(maxSpeed, SPEED.air);
      const accel = state.grounded ? ACCEL.ground : ACCEL.air;
      const along = vel.x * wish.x + vel.z * wish.z;
      const add = maxSpeed * wl - along;
      if (add > 0) {
        const a = Math.min(accel * maxSpeed * dt, add);
        vel.x += wish.x * a; vel.z += wish.z * a;
      }
    }

    // ---- jump (buffered + coyote time) ----
    coyote = state.grounded ? JUMP.coyote : Math.max(0, coyote - dt);
    if (jumpBuf > 0 && (state.grounded || coyote > 0)) {
      vel.y = JUMP.v;
      state.grounded = false;
      jumpBuf = 0; coyote = 0;
      fallPeak = pos.y;
      bus.emit('player:jump', { pos: pos.clone() });
    }
    vel.y -= GRAVITY * dt;

    // ---- integrate + collide (+ step-up) ----
    const wasAir = !state.grounded;
    const impactV = -vel.y;
    const grounded = moveResolve(dt);

    if (grounded) {
      if (wasAir && impactV > CAM.landMinV) {
        const impact = clamp01((impactV - CAM.landMinV) / (CAM.landRefV - CAM.landMinV));
        state.landDipV -= impact * CAM.landDipK;
        state.kickPitchV -= impact * CAM.landKickK * CAM.landKickW;   // view kick, weapon-independent
        bus.emit('player:land', { impact, speed: impactV, pos: pos.clone() });
        if (impactV > FALL.safe) {
          const t = clamp01((impactV - FALL.safe) / (FALL.lethal - FALL.safe));
          damage(Math.round(FALL.max * Math.pow(t, FALL.curve)), 'fall');
        }
      }
      if (vel.y < 0) vel.y = 0;
      fallPeak = pos.y;
    } else if (pos.y > fallPeak) fallPeak = pos.y;
    state.grounded = grounded;
    state.speed = Math.hypot(vel.x, vel.z);

    // ---- mantle trigger ----
    // Deliberate (jump into a ledge) or automatic while tac-sprinting into one.
    if (!state.sliding && (jumpBuf > 0 || (state.tacSprint && state.blocked > 0.4))) {
      if (tryMantle(f)) jumpBuf = 0;
    }

    camFx(dt, f, false);
  }

  function endSlide() {
    state.sliding = false;
    state.slideT = 0;
    slideCd = SLIDE.cooldown;
    slideAir = 0;
  }

  // ---- camera / feel scalars (sim-side; pose() only interpolates) --------
  function camFx(dt, f, mantling) {
    // lean (Q/E) — lateral offset + roll
    [state.lean, state.leanV] = springDamp(state.lean, state.leanV, mantling ? 0 : f.lean * 0.42, 16, dt);

    // strafe roll: springs toward a target proportional to lateral input AND speed
    const spdF = clamp01(state.speed / SPEED.walk);
    const rollT = mantling || state.sliding ? 0 : f.move.x * CAM.strafeRoll * spdF;
    [state.roll, state.rollV] = springDamp(state.roll, state.rollV, rollT, CAM.strafeRollW, dt);

    // landing dip + view kick (both critically damped -> settle, never oscillate)
    [state.landDip, state.landDipV] = springDamp(state.landDip, state.landDipV, 0, CAM.landDipW, dt);
    [state.kickPitch, state.kickPitchV] = springDamp(state.kickPitch, state.kickPitchV, 0, CAM.landKickW, dt);

    // slide camera
    state.slideDip = damp(state.slideDip, state.sliding ? 1 : 0, 14, dt);
    const srT = state.sliding ? SLIDE.roll * (0.45 + 0.55 * f.move.x) : 0;
    state.slideRoll = damp(state.slideRoll, srT, 12, dt);

    // ---- footsteps: distance-based cadence, never time-based ----
    const stride = state.crouched ? BOB.stride.crouch : state.sprinting ? BOB.stride.sprint : BOB.stride.walk;
    if (!mantling && state.grounded && state.speed > 0.6 && !state.sliding) {
      state.stepDist += state.speed * dt;
      if (state.stepDist >= stride) {
        state.stepDist -= stride;
        bus.emit('player:footstep', { pos: pos.clone(), speed: state.speed, crouched: state.crouched });
      }
      // One full 2*PI bob cycle per stride PAIR; the 1:2 Lissajous in pose() then
      // puts exactly one vertical dip on each footfall.
      state.bobT += dt * (state.speed / stride) * Math.PI;
    } else {
      state.stepDist = 0;
    }
    let ampT = 0;
    if (!mantling && state.grounded && !state.sliding) {
      ampT = Math.min(BOB.ampMax, state.speed / SPEED.walk);
      if (state.crouched) ampT *= BOB.crouchScale;
      ampT *= lerp(1, BOB.adsScale, state.adsT);
    }
    state.bobAmp = damp(state.bobAmp, ampT, BOB.rate, dt);

    // ---- breathing ----
    // Hold-breath is Sprint-while-ADS (CoD's binding) — no new keybind needed.
    const wantHold = !mantling && f.sprint && f.ads && state.adsT > 0.5 && state.breath > 0;
    state.breath = clamp01(state.breath + (wantHold ? -dt / BREATH.hold : dt / BREATH.recover));
    state.holdBreath = damp(state.holdBreath, wantHold ? 1 : 0, 12, dt);
    state.breathT += dt;
    const moveMute = 1 - clamp01(state.speed / BREATH.moveCut);
    const exhaust = state.breath <= 0 ? BREATH.exhaustAmp : 1;
    const bAmp = lerp(BREATH.ampHip, BREATH.ampAds, state.adsT) * moveMute * exhaust * (1 - state.holdBreath * 0.92);
    state.breathAmp = damp(state.breathAmp, mantling ? 0 : bAmp, BREATH.rate, dt);

    // ---- FOV lives in the sim so it is frame-rate independent ----
    const fovT = lerp(CAM.fov, CAM.adsFov, state.adsT)
      + (state.tacSprint ? CAM.tacFov : state.sprinting ? CAM.sprintFov : 0)
      + (state.sliding ? CAM.sprintFov : 0);
    state.fov = damp(state.fov, fovT, CAM.fovRate, dt);
  }

  // Called once per RENDER frame with interpolation alpha. Display-only: reads
  // sim state, writes the camera. Never mutates `state`.
  const _ip = new THREE.Vector3();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');

  function pose(alpha) {
    const a = clamp01(alpha);
    _ip.lerpVectors(prevPos, pos, a);
    const v = (k) => P[k] + (state[k] - P[k]) * a;

    const bobT = v('bobT'), bobAmp = v('bobAmp');
    // True figure-8: 1:2 Lissajous. sin(t) horizontal, -cos(2t) vertical, so the
    // vertical minimum lands on the footfall and the path is C-infinity smooth.
    const bobX = Math.sin(bobT) * BOB.x * bobAmp;
    const bobY = -Math.cos(bobT * 2) * BOB.y * bobAmp * 0.5;
    const bobR = Math.sin(bobT) * BOB.roll * bobAmp;

    const brT = v('breathT'), brA = v('breathAmp');
    const brX = Math.sin(brT * BREATH.freqA * Math.PI * 2) * brA;
    const brY = Math.sin(brT * BREATH.freqB * Math.PI * 2 + 1.1) * brA * 0.8;

    const lean = v('lean'), eye = v('eye');
    const dip = v('landDip') * CAM.landDipScale - v('slideDip') * SLIDE.dip;

    camera.position.set(
      _ip.x + (bobX + Math.cos(state.yaw) * lean * CAM.leanOffset),
      _ip.y + eye + bobY + dip,
      _ip.z + (-Math.sin(state.yaw) * lean * CAM.leanOffset)
    );
    _e.set(
      state.pitch + v('kickPitch') + v('mantleTilt') + brY,
      state.yaw + brX,
      -lean * CAM.leanRoll - v('roll') - v('slideRoll') + bobR + v('mantleRoll')
    );
    camera.quaternion.setFromEuler(_e);

    // FOV: damped in the sim (see camFx), interpolated here. Widening on
    // sprint/slide is what reads as acceleration.
    const fov = v('fov');
    if (Math.abs(camera.fov - fov) > 0.005) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  return {
    state, pos, vel, step, pose, damage,
    get position() { return pos; },
    teleport(p, yaw = 0, pitch = 0) {
      pos.copy(p); prevPos.copy(p); vel.set(0, 0, 0);
      state.yaw = yaw; state.pitch = pitch;
      state.bobT = 0; state.bobAmp = 0; state.landDip = 0; state.landDipV = 0;
      state.kickPitch = 0; state.kickPitchV = 0; state.roll = 0; state.rollV = 0;
      state.lean = 0; state.leanV = 0;
      state.sliding = false; state.slideT = 0; state.slideDip = 0; state.slideRoll = 0;
      state.mantling = false; state.mantleT = 0; state.mantleTilt = 0; state.mantleRoll = 0;
      state.breathT = 0; state.breathAmp = 0; state.breath = 1; state.holdBreath = 0;
      state.crouched = false; state.height = H.stand; state.eye = EYE.stand;
      state.grounded = true; state.speed = 0; state.stepDist = 0; state.blocked = 0;
      state.sprinting = false; state.tacSprint = false; sprintHeld = 0;
      state.adsT = 0; state.fov = CAM.fov;
      jumpBuf = 0; coyote = JUMP.coyote; slideCd = 0; slideAir = 0;
      prevJump = false; prevCrouch = false; fallPeak = p.y;
      for (const k of IP) P[k] = state[k];
    },
    dispose() {},
  };
}
