// store.test.mjs — schema, tickets, trophies, migrate-swallows-junk, injectable backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, migrate, ticketsFor, TROPHY_BONUS, SCHEMA_V } from '../src/core/store.js';

test('defaults: fresh schema shape', () => {
  const s = makeStore(null); s.load();
  const st = s.state;
  assert.equal(st.v, SCHEMA_V); assert.equal(st.tickets, 0); assert.equal(st.totalPlays, 0);
  assert.deepEqual(st.best, {}); assert.deepEqual(st.plays, {}); assert.deepEqual(st.trophies, {});
});

test('ticketsFor: base + newBest bonus, scaled by tier', () => {
  assert.equal(ticketsFor(250, 3, false), Math.floor(250 / 100) * 3);            // 6
  assert.equal(ticketsFor(250, 3, true), 6 + Math.floor(250 / 200) * 3);         // 6 + 3 = 9
  assert.equal(ticketsFor(50, 1, true), 0);
});

test('finishRun: records best, awards base tickets + first_light', () => {
  const s = makeStore(null); s.load();
  const r = s.finishRun('shooting', 1, 250, { bulls: 0 });
  assert.equal(r.newBest, true); assert.equal(r.prevBest, 0);
  assert.equal(s.best('shooting', 1), 250);
  assert.equal(r.earned, 3 + TROPHY_BONUS);       // ticketsFor(250,1,true)=3, + first_light
  assert.equal(s.state.tickets, 3 + TROPHY_BONUS);
  assert.ok(r.unlocked.some((t) => t.id === 'first_light'));
});

test('finishRun: no new best → no bonus, no duplicate trophy', () => {
  const s = makeStore(null); s.load();
  s.finishRun('shooting', 1, 250, {});
  const r = s.finishRun('shooting', 1, 100, {});
  assert.equal(r.newBest, false);
  assert.equal(r.earned, ticketsFor(100, 1, false)); // 1, no trophies (first_light already owned)
  assert.equal(r.unlocked.length, 0);
});

test('trophy: 25-flat bonus + game-specific predicate (skee_500)', () => {
  const s = makeStore(null); s.load();
  const r = s.finishRun('skeeball', 1, 500, { hundos: 0 });
  const ids = r.unlocked.map((t) => t.id);
  assert.ok(ids.includes('skee_500')); assert.ok(ids.includes('first_light'));
  assert.equal(r.earned, ticketsFor(500, 1, true) + 2 * TROPHY_BONUS); // 7 + 50
});

test('migrate: junk / wrong version / null → fresh defaults (never throws)', () => {
  for (const bad of ['not json{', null, undefined, '{"v":99}', '42', JSON.stringify({ v: 2, tickets: 9 })]) {
    const d = migrate(bad);
    assert.equal(d.v, SCHEMA_V); assert.equal(d.tickets, 0); assert.deepEqual(d.best, {});
  }
  const clamped = migrate({ v: 1, tickets: -5, best: 'bad', plays: null });
  assert.equal(clamped.tickets, 0); assert.deepEqual(clamped.best, {});
});

test('migrate: preserves a valid v1 blob', () => {
  const raw = { v: 1, tickets: 40, best: { shooting: { 1: 250 } }, plays: { shooting: 2 }, totalPlays: 2, trophies: { first_light: 1 } };
  const d = migrate(JSON.stringify(raw));
  assert.equal(d.tickets, 40); assert.equal(d.best.shooting['1'], 250);
  assert.equal(d.plays.shooting, 2); assert.equal(d.trophies.first_light, 1);
});

test('injectable backend: save→load round-trips across instances', () => {
  const map = new Map();
  const be = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) };
  const s1 = makeStore(be); s1.load();
  s1.finishRun('dart', 2, 300, {});
  const s2 = makeStore(be); s2.load();
  assert.equal(s2.best('dart', 2), 300);
  assert.equal(s2.state.tickets, s1.state.tickets);
});

test('null backend: in-memory, save never throws', () => {
  const s = makeStore(null); s.load();
  assert.doesNotThrow(() => { s.finishRun('ringtoss', 1, 120, {}); s.save(); });
  assert.equal(s.best('ringtoss', 1), 120);
});
