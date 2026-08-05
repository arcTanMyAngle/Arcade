// BREACHPOINT — integration root.
//
// This file OWNS the module contract. Subsystems are independently authored and
// must not import each other; they communicate through `ctx` handles + the event
// bus. If you are editing a subsystem, do not change these signatures.
//
//   createMaterialLibrary({ renderer, rng })      -> { get(name), env, dispose() }
//   createLevel({ scene, rng, mats })             -> { collide(p,r), spawns, step(dt), dispose() }
//   createPipeline({ rc, scene, quality })        -> { render(alpha), resize(w,h), params, dispose() }
//   createPlayer({ level, camera, bus, rng })     -> { step(dt,frame), pose, state, dispose() }
//   createWeapons({ scene, camera, bus, rng, player, level }) -> { step(dt,frame), render(alpha), state, dispose() }
//   createFX({ scene, camera, bus, rng, mats })   -> { step(dt), render(alpha), dispose() }
//   createAI({ scene, level, bus, rng, player })  -> { step(dt), agents, dispose() }
//   createAudio({ bus, camera })                  -> { step(dt), resume(), dispose() }
//   createHUD({ root, bus })                      -> { step(dt, ctx), dispose() }

import * as THREE from 'three';
import { createLoop, TICK_DT } from './core/loop.js';
import { createBus } from './core/events.js';
import { createInput, createScriptedInput } from './core/input.js';
import { mulberry32 } from './core/rng.js';
import { createRenderer } from './render/renderer.js';
import { createMaterialLibrary } from './render/materials.js';
import { createPipeline } from './render/pipeline.js';
import { createSky } from './render/sky.js';
import { createLighting } from './render/lighting.js';
import { createLevel } from './world/level.js';
import { createPlayer } from './player/controller.js';
import { createWeapons } from './weapons/index.js';
import { createFX } from './fx/index.js';
import { createAI } from './ai/index.js';
import { createAudio } from './audio/index.js';
import { createHUD } from './ui/hud.js';

const SEED = 0xB12ACE;
const HEADLESS = new URLSearchParams(location.search).has('headless');
// The frame-time readout is a dev tool. Unconditional, it shipped into every
// acceptance frame — and reads "0 FPS" under software GL, where it means nothing.
const SHOW_STATS = new URLSearchParams(location.search).has('stats');

const boot = document.getElementById('boot');
const say = (m) => { if (boot) boot.textContent = m; };

async function main() {
  say('initializing renderer…');
  const canvas = document.getElementById('gl');
  const rng = mulberry32(SEED);
  const bus = createBus();
  const rc = createRenderer(canvas, new URLSearchParams(location.search).get('q') ?? 'ultra');

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;

  say('generating materials…');
  const mats = await createMaterialLibrary({ renderer: rc.renderer, rng });
  scene.environment = mats.env;

  say('building level…');
  const sky = createSky({ scene, sunDir: mats.sunDir });
  const lighting = createLighting({ scene, sunDir: mats.sunDir, quality: rc.quality });
  const level = createLevel({ scene, rng, mats });

  say('compiling post chain…');
  const pipeline = createPipeline({ rc, scene, quality: rc.quality });
  rc.onResize = (w, h) => pipeline.resize(w, h);

  const input = HEADLESS ? createScriptedInput([]) : createInput(canvas);
  const player = createPlayer({ level, camera: rc.camera, bus, rng });
  const weapons = createWeapons({ scene, camera: rc.camera, bus, rng, player, level });
  const fx = createFX({ scene, camera: rc.camera, bus, rng, mats });
  const ai = createAI({ scene, level, bus, rng, player });
  const audio = createAudio({ bus, camera: rc.camera });
  const hud = createHUD({ root: document.getElementById('ui'), bus });

  // ---- deploy gate -------------------------------------------------------
  const prompt = document.getElementById('prompt');
  const deploy = () => {
    prompt.classList.add('hidden');
    input.request?.();
    audio.resume();
  };
  if (HEADLESS) prompt.remove();       // never let the title card occlude a capture
  else prompt.addEventListener('click', deploy);

  // ---- frame -------------------------------------------------------------
  const hudCtx = { player, weapons, ai, stats: null };
  let settleTarget = -1;               // -1 = free-running, >=0 = capture countdown

  const loop = createLoop({
    step(dt) {
      const frame = input.sample();
      level.step(dt);                  // animated level geometry ticks in sim, not render
      player.step(dt, frame);
      weapons.step(dt, frame);
      ai.step(dt);
      fx.step(dt);
      audio.step(dt);
    },
    render(alpha) {
      rc.resetStats();
      player.pose(alpha);              // writes camera transform for this display frame
      sky.update(rc.camera);
      lighting.update(rc.camera.position);
      weapons.render(alpha);
      fx.render(alpha);
      pipeline.render(alpha);
      hudCtx.stats = SHOW_STATS ? loop.stats : null;
      hud.step(TICK_DT, hudCtx);

      if (settleTarget > 0 && --settleTarget === 0) loop.stop();
    },
  });

  // Force shader compilation before the first presented frame — otherwise the
  // first seconds are a hitch-fest and headless capture grabs an unlit scene.
  say('compiling shaders…');
  await rc.renderer.compileAsync(scene, rc.camera);
  pipeline.render(0);

  loop.start();
  say('');
  if (boot) boot.remove();

  // ---- capture / debug API ----------------------------------------------
  const POSES = {};                    // subsystems register named camera poses
  Object.assign(POSES, level.poses ?? {});

  window.__GAME__ = {
    ready: true,
    THREE, scene, rc, level, player, weapons, fx, ai, pipeline, mats, bus, sky, lighting,

    // settle(n): run exactly n more frames, then HALT the loop. Halting matters —
    // a continuously-animating canvas never reaches the stable state Playwright's
    // screenshot waits for, and on a software rasterizer it never will.
    get settled() { return settleTarget === 0; },
    settle(n) { settleTarget = n; loop.start(); },

    pose(name) {
      const p = POSES[name];
      if (!p) return false;
      player.teleport?.(p.pos, p.yaw, p.pitch);
      if (p.ads !== undefined) {
        weapons.state.forceAds = p.ads;
        weapons.setState?.({ ads: p.ads }); // capture poses are instantaneous, not real-time input
      }
      if (p.weaponState) weapons.setState?.(p.weaponState);
      return true;
    },
    perf() {
      const s = loop.stats;
      return {
        fps: +s.fps.toFixed(1), frameMs: +s.frameMs.toFixed(2), simMs: +s.simMs.toFixed(3),
        drawCalls: rc.drawCalls, triangles: rc.triangles,
        programs: rc.renderer.info.programs?.length ?? 0,
        textures: rc.renderer.info.memory.textures, geometries: rc.renderer.info.memory.geometries,
        quality: rc.qualityName,
      };
    },
  };

  if (HEADLESS) loop.stop();           // capture drives frames explicitly via settle()
}

main().catch((e) => {
  console.error(e);
  say(`BOOT FAILED: ${e.message}`);
  document.getElementById('prompt')?.insertAdjacentHTML(
    'beforeend', `<p style="color:#e2564d">boot failed — ${e.message}</p>`
  );
});
