// main.js — boots the suite, builds the midway menu, routes to a booth. M11: injects ctx.store,
// wraps end() with finishRun→tickets/trophies, attaches the kinetic input, and runs a ?dev=1 record/replay harness.
import { makeEngine } from './core/engine.js';
import { makeInput } from './core/input.js';
import { makeStore } from './core/store.js';
import { hashFrames } from './core/kinetics.js';
import { audio } from './core/audio.js';
import { hud } from './core/hud.js';

const GAMES = [
  { id: 'shooting',    label: 'TARGET PLINKER',    tag: 'RIFLE · LANES · TORQUE', on: true, load: () => import('./games/shooting.js') },
  { id: 'anchor',      label: 'ANCHOR SMASH',      tag: 'RHYTHM · FLICK · IMPULSE', on: true, load: () => import('./games/anchor.js') },
  { id: 'dart',        label: 'BALLOON DART',      tag: 'SNIPER · HITBOX',     on: true,  load: () => import('./games/dart.js') },
  { id: 'ringtoss',    label: 'RING TOSS',         tag: 'FRICTION · TORUS',    on: true,  load: () => import('./games/ringtoss.js') },
  { id: 'basketball',  label: 'FREE-THROW',        tag: 'ARC · RIM · SPIN',    on: true,  load: () => import('./games/basketball.js') },
  { id: 'skeeball',    label: 'SKEE-BALL',         tag: 'INCLINE · LIP-JUMP',  on: true,  load: () => import('./games/skeeball.js') }
];

const app = document.getElementById('app');
const engine = makeEngine(app);
const input = makeInput(engine.renderer.domElement);
const store = makeStore(typeof localStorage !== 'undefined' ? localStorage : null);
store.load();
engine.attachInput(input);
hud.init();
hud.tickets(store.state.tickets);

let tierSel = 1, current = null, currentGame = null;

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
  input.setHudActive(!on);
  if (on) input.setMode('cursor');             // menu = visible cursor; guards phantom edges on transition
}

// end wrapper: legacy games call end(title, body) (2 args, no-op meta); kinetic games pass a 3rd
// result={score,stats} → finishRun updates best/tickets/trophies and decorates the banner.
function makeEnd(g) {
  return (title, body, result) => {
    let extra = '';
    if (result && typeof result === 'object') {
      const r = store.finishRun(g.id, tierSel, result.score | 0, result.stats || {});
      const bestNow = store.best(g.id, tierSel);
      extra = `<br>${r.newBest ? `<span class="best">NEW BEST ${bestNow}</span>` : `BEST ${bestNow}`} · +${r.earned} TICKETS`;
      hud.tickets(store.state.tickets);
      for (const t of r.unlocked) hud.toast(t.name, t.desc);
    }
    hud.banner(title, (body || '') + extra, returnToMenu);
  };
}

async function startGame(g) {
  audio.resume(); audio.ambient(true);
  const mod = await g.load();
  engine.clearScene();
  showMenu(false);
  input.setMode('lock');                        // default; kinetic (cursor) booths override in create()
  hud.game(g.label.split(' ')[0]); hud.tier(tierSel); hud.reticle(true);
  hud.mode('time'); hud.striker(false); hud.scope(false); hud.breathShow(false); // defaults; booth overrides in create()
  hud.ribbon(null); hud.rhythm(null);

  const ctx = {
    THREE: engine.THREE, scene: engine.scene, camera: engine.camera, renderer: engine.renderer,
    input, audio, hud, store, tier: tierSel,
    end: makeEnd(g)
  };
  current = mod.create(ctx); currentGame = g;
  engine.setActive(current);
  engine.start();
}

function returnToMenu() {
  engine.stop();
  document.exitPointerLock?.();
  current?.teardown?.(); current = null; currentGame = null;
  engine.setActive(null);
  engine.clearScene();
  showMenu(true);
}

// --- ?dev=1 record/replay determinism harness (plan.md §3.1) ---
// F9: restart the booth fresh + record packed frames. F10: restart fresh + replay the log; prints
// final score + frame hash. Booth worlds seed off tier only, so identical input ⇒ identical score.
if (new URLSearchParams(location.search).get('dev') === '1') {
  let log = null;
  addEventListener('keydown', async (e) => {
    if (!currentGame) return;
    if (e.code === 'F9') {
      e.preventDefault(); input.record(false); input.stopReplay();
      await restart(); input.record(true);
      console.log('[dev] RECORDING — play the round, then F10 to replay');
    } else if (e.code === 'F10') {
      e.preventDefault(); const rec = input.record(false); if (!rec || !rec.n) { console.warn('[dev] nothing recorded'); return; }
      log = rec.f64.slice(0, rec.n * 24);
      console.log('[dev] recorded', rec.n, 'frames · hash', hashFrames(log, rec.n).toString(16));
      await restart(); input.startReplay(log, rec.n);
      console.log('[dev] REPLAYING', rec.n, 'frames');
    }
  });
  async function restart() { const g = currentGame; if (g) await startGame(g); }
}

showMenu(true);
