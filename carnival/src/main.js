// main.js — boots the suite, builds the midway menu, routes to a booth.
import { makeEngine } from './core/engine.js';
import { makeInput } from './core/input.js';
import { audio } from './core/audio.js';
import { hud } from './core/hud.js';

const GAMES = [
  { id: 'shooting',    label: 'SHOOTING GALLERY', tag: 'RIFLE · DROP · WIND', on: true,  load: () => import('./games/shooting.js') },
  { id: 'highstriker', label: 'HIGH STRIKER',     tag: 'MALLET · IMPULSE',    on: true,  load: () => import('./games/highstriker.js') },
  { id: 'dart',        label: 'BALLOON DART',      tag: 'SNIPER · HITBOX',     on: true,  load: () => import('./games/dart.js') },
  { id: 'ringtoss',    label: 'RING TOSS',         tag: 'FRICTION · TORUS',    on: true,  load: () => import('./games/ringtoss.js') },
  { id: 'basketball',  label: 'FREE-THROW',        tag: 'ARC · RIM · SPIN',    on: true,  load: () => import('./games/basketball.js') },
  { id: 'skeeball',    label: 'SKEE-BALL',         tag: 'INCLINE · LIP-JUMP',  on: true,  load: () => import('./games/skeeball.js') }
];

const app = document.getElementById('app');
const engine = makeEngine(app);
const input = makeInput(engine.renderer.domElement);
hud.init();

let tierSel = 1, current = null;

// --- build menu DOM ---
const gamesEl = document.getElementById('games');
GAMES.forEach((g) => {
  const c = document.createElement('div');
  c.className = 'card ' + (g.on ? 'on' : 'off');
  c.innerHTML = `${g.label}<span class="tag">${g.on ? g.tag : 'LOCKED'}</span>`;
  if (g.on) c.onclick = () => startGame(g);
  gamesEl.appendChild(c);
});
const tiersEl = document.getElementById('tiers');
for (let n = 1; n <= 5; n++) {
  const b = document.createElement('button'); b.textContent = n; if (n === 5) b.classList.add('t5');
  if (n === 1) b.classList.add('sel');
  b.onclick = () => { tierSel = n; [...tiersEl.querySelectorAll('button')].forEach((x, i) => x.classList.toggle('sel', i + 1 === n)); };
  tiersEl.appendChild(b);
}

function showMenu(on) {
  document.getElementById('menu').style.display = on ? 'flex' : 'none';
  hud.show(!on);
}

async function startGame(g) {
  audio.resume(); audio.ambient(true);
  const mod = await g.load();
  engine.clearScene();
  showMenu(false);
  hud.game(g.label.split(' ')[0]); hud.tier(tierSel); hud.reticle(true);
  hud.mode('time'); hud.striker(false); hud.scope(false); hud.breathShow(false); // defaults; booth overrides in create()

  const ctx = {
    THREE: engine.THREE, scene: engine.scene, camera: engine.camera, renderer: engine.renderer,
    input, audio, hud, tier: tierSel,
    end: (title, body) => hud.banner(title, body, returnToMenu)
  };
  current = mod.create(ctx);
  engine.setActive(current);
  engine.start();
}

function returnToMenu() {
  engine.stop();
  document.exitPointerLock?.();
  current?.teardown?.(); current = null;
  engine.setActive(null);
  engine.clearScene();
  showMenu(true);
}

showMenu(true);
