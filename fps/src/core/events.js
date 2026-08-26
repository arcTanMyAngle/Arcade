// Minimal synchronous event bus. Decouples sim -> fx/audio/hud without hard refs.
// Handlers must not throw; a throwing handler is isolated so one bad listener
// cannot abort the frame's remaining dispatch.

export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      let s = map.get(type);
      if (!s) map.set(type, (s = new Set()));
      s.add(fn);
      return () => s.delete(fn);
    },
    off(type, fn) { map.get(type)?.delete(fn); },
    emit(type, payload) {
      const s = map.get(type);
      if (!s) return;
      for (const fn of s) {
        try { fn(payload); } catch (e) { console.error(`[bus:${type}]`, e); }
      }
    },
    clear() { map.clear(); },
  };
}
