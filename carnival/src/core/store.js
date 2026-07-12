// store.js — PURE persistence + tickets + trophies. Imports nothing. Injectable backend
// ({getItem,setItem} | null→in-memory). No Date.now anywhere: trophy unlock order = play index.
// Single versioned key; migrate() never throws (junk/old-version → fresh defaults). See plan.md §3.2.

export const SCHEMA_V = 1, SAVE_KEY = 'uncanny-carnival', TROPHY_BONUS = 25;
const GAMES = ['shooting', 'anchor', 'dart', 'ringtoss', 'basketball', 'skeeball'];

function defaults() { return { v: SCHEMA_V, tickets: 0, best: {}, plays: {}, totalPlays: 0, trophies: {} }; }

export function migrate(raw) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || typeof s !== 'object' || s.v !== SCHEMA_V) return defaults();
    const d = defaults();
    d.tickets = Math.max(0, s.tickets | 0);
    d.totalPlays = Math.max(0, s.totalPlays | 0);
    if (s.best && typeof s.best === 'object') for (const g in s.best) {
      const t = s.best[g];
      if (t && typeof t === 'object') { d.best[g] = {}; for (const tr in t) { const v = +t[tr]; if (Number.isFinite(v)) d.best[g][tr] = v | 0; } }
    }
    if (s.plays && typeof s.plays === 'object') for (const g in s.plays) { const v = +s.plays[g]; if (Number.isFinite(v)) d.plays[g] = v | 0; }
    if (s.trophies && typeof s.trophies === 'object') for (const id in s.trophies) { const v = +s.trophies[id]; if (Number.isFinite(v)) d.trophies[id] = v | 0; }
    return d;
  } catch (e) { return defaults(); }
}

// tickets = floor(score/100)·tier + newBest ? floor(score/200)·tier : 0
export function ticketsFor(score, tier, newBest) {
  return Math.floor(score / 100) * tier + (newBest ? Math.floor(score / 200) * tier : 0);
}

const anyBest = (s, tier, min) => { for (const g in s.best) { const v = s.best[g][tier]; if (v != null && v >= min) return true; } return false; };
const bestTierGE = (s, g, minTier) => { const b = s.best[g]; if (!b) return false; for (const t in b) if (+t >= minTier && b[t] > 0) return true; return false; };

// 17 trophies. when(ctx,state) — ctx = {gameId,tier,score,stats,newBest}; state already reflects this run's
// tickets + best (finishRun updates those before evaluating).
export const TROPHIES = [
  { id: 'first_light',     name: 'FIRST LIGHT',       desc: 'Score your first points',     when: (c) => c.score > 0 },
  { id: 'full_circuit',    name: 'FULL CIRCUIT',      desc: 'Play all six booths',         when: (c, s) => GAMES.every((g) => s.plays[g] > 0) },
  { id: 'paper_trail',     name: 'PAPER TRAIL',       desc: 'Bank 1000 tickets',           when: (c, s) => s.tickets >= 1000 },
  { id: 'nights_house',    name: "HOUSE'S NIGHTMARE", desc: 'Tier-5 best ≥ 500',           when: (c, s) => anyBest(s, 5, 500) },
  { id: 'clinical',        name: 'CLINICAL',          desc: 'Tier ≥3 best in all six',     when: (c, s) => GAMES.every((g) => bestTierGE(s, g, 3)) },
  { id: 'gallery_deadeye', name: 'DEAD EYE',          desc: '5 bullseyes in one round',    when: (c) => c.gameId === 'shooting' && c.stats.bulls >= 5 },
  { id: 'gallery_ironwork',name: 'IRONWORK',          desc: '3 heavy knockdowns',          when: (c) => c.gameId === 'shooting' && c.stats.heavies >= 3 },
  { id: 'anchor_resonant', name: 'RESONANT',          desc: 'Multiplier ≥ 2.9',            when: (c) => c.gameId === 'anchor' && c.stats.maxMult >= 2.9 },
  { id: 'anchor_chain',    name: 'CHAIN GANG',        desc: 'A full rhythm chain',         when: (c) => c.gameId === 'anchor' && c.stats.fullChain === true },
  { id: 'dart_cluster',    name: 'SHRAPNEL',          desc: 'Pop a cluster',               when: (c) => c.gameId === 'dart' && c.stats.clusters >= 1 },
  { id: 'dart_windproof',  name: 'WINDPROOF',         desc: '1500 at tier ≥4',             when: (c) => c.gameId === 'dart' && c.tier >= 4 && c.score >= 1500 },
  { id: 'ring_backpeg',    name: 'LONG IRON',         desc: 'Land the back peg',           when: (c) => c.gameId === 'ringtoss' && c.stats.backPeg === true },
  { id: 'ring_triple',     name: 'TRIPLE CROWN',      desc: 'Streak of 3 ringers',         when: (c) => c.gameId === 'ringtoss' && c.stats.maxStreak >= 3 },
  { id: 'bball_pure',      name: 'PURE',              desc: '3 swishes in a row',          when: (c) => c.gameId === 'basketball' && c.stats.swishStreak >= 3 },
  { id: 'bball_allnet',    name: 'ALL NET',           desc: '8 makes in a round',          when: (c) => c.gameId === 'basketball' && c.stats.makes >= 8 },
  { id: 'skee_hundo',      name: 'HUNDO',             desc: 'Land a 100',                  when: (c) => c.gameId === 'skeeball' && c.stats.hundos >= 1 },
  { id: 'skee_500',        name: 'LANE KING',         desc: 'Score 500',                   when: (c) => c.gameId === 'skeeball' && c.score >= 500 }
];

export function makeStore(backend) {
  const mem = new Map();
  const be = backend || { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  let state = defaults();
  const session = { score: 0, runs: [] };      // NEVER serialized

  const store = {
    get state() { return state; },
    session,
    load() { state = migrate(be.getItem(SAVE_KEY)); return state; },
    save() { try { be.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* quota/serialization: ignore */ } },
    best(gameId, tier) { return (state.best[gameId] && state.best[gameId][tier]) || 0; },
    finishRun(gameId, tier, score, stats = {}) {
      score = score | 0;
      state.plays[gameId] = (state.plays[gameId] || 0) + 1;
      state.totalPlays++;
      const prevBest = store.best(gameId, tier);
      const newBest = score > prevBest;
      if (newBest) { if (!state.best[gameId]) state.best[gameId] = {}; state.best[gameId][tier] = score; }
      let earned = ticketsFor(score, tier, newBest);
      state.tickets += earned;                 // base tickets first so paper_trail sees this run
      const ctx = { gameId, tier, score, stats, newBest };
      const unlocked = [];
      for (const t of TROPHIES) {
        if (state.trophies[t.id] != null) continue;
        if (t.when(ctx, state)) { state.trophies[t.id] = state.totalPlays; earned += TROPHY_BONUS; state.tickets += TROPHY_BONUS; unlocked.push(t); }
      }
      session.score = score; session.runs.push({ gameId, tier, score });
      store.save();
      return { earned, newBest, prevBest, unlocked };
    },
    reset() { state = defaults(); store.save(); }
  };
  return store;
}
