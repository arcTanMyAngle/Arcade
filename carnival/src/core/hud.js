// hud.js — thin DOM overlay wrapper (score/tier/time/wind/combo/pops/banner).
const $ = (id) => document.getElementById(id);

export const hud = {
  el: {},
  init() {
    this.el = {
      root: $('hud'), game: $('hGame'), tier: $('hTier'), score: $('hScore'),
      time: $('hTime'), combo: $('hCombo'), wind: $('hWind'), pops: $('pops'),
      reticle: $('reticle'), banner: $('banner'), bTitle: $('bTitle'), bBody: $('bBody'), bBack: $('bBack'),
      timeRow: $('hTimeRow'), countRow: $('hCountRow'), count: $('hCount'), countLabel: $('hCountLabel'),
      striker: $('striker'), chgFill: $('chgFill'), chgSweet: $('chgSweet'),
      scope: $('scope'), breathWrap: $('breathWrap'), breath: $('breath'),
      tickets: $('hTickets'), toasts: $('toasts'), ribbon: $('ribbon'), rhythm: $('rhythm')
    };
  },
  show(on) { this.el.root.style.display = on ? 'block' : 'none'; if (!on) this.clearBanner(); },
  game(n) { this.el.game.textContent = n; },
  tier(n) { this.el.tier.textContent = n; },
  score(n) { this.el.score.textContent = n | 0; },
  time(s) { this.el.time.textContent = Math.max(0, Math.ceil(s)); },
  combo(streak) { this.el.combo.textContent = streak > 1 ? `x${(1 + streak * 0.1).toFixed(1)}  (${streak})` : ''; },
  wind(mps) {
    const a = Math.abs(mps);
    this.el.wind.textContent = a < 0.05 ? 'WIND —' : `WIND ${mps < 0 ? '◄' : '►'} ${a.toFixed(1)} m/s`;
  },
  reticle(on) { this.el.reticle.style.display = on ? 'block' : 'none'; },
  // --- top-right readout: countdown TIME (L1) or a labelled COUNT (swings/darts) ---
  mode(m) { // 'time' | 'count'
    this.el.timeRow.style.display = m === 'time' ? 'block' : 'none';
    this.el.countRow.style.display = m === 'count' ? 'block' : 'none';
  },
  count(label, n) { this.el.countLabel.textContent = label; this.el.count.textContent = n; },
  // --- Level 2 High Striker: charge/timing meter ---
  striker(on) { this.el.striker.style.display = on ? 'block' : 'none'; },
  sweet(lo) { // place the sweet-spot band from lo..1 of the bar height (once per tier)
    this.el.chgSweet.style.bottom = (lo * 100) + '%';
    this.el.chgSweet.style.height = ((1 - lo) * 100) + '%';
  },
  charge(c, hot) { // fill height 0..1; `hot` = release would land in the sweet window
    this.el.chgFill.style.height = (c * 100) + '%';
    this.el.chgFill.classList.toggle('hot', !!hot);
  },
  // --- Level 3 Balloon Dart: scope vignette + breath (steady) meter ---
  scope(on) { this.el.scope.style.display = on ? 'block' : 'none'; },
  breathShow(on) { this.el.breathWrap.style.display = on ? 'block' : 'none'; },
  breath(v) { this.el.breath.style.width = (v * 100) + '%'; this.el.breath.classList.toggle('low', v < 0.25); },
  // Floating feedback at screen px (x,y).
  pop(x, y, text, color = '#39ff88') {
    const e = document.createElement('div'); e.className = 'pop'; e.textContent = text;
    e.style.left = x + 'px'; e.style.top = y + 'px'; e.style.color = color;
    this.el.pops.appendChild(e); setTimeout(() => e.remove(), 1000);
  },
  banner(title, body, onBack) {
    this.el.bTitle.textContent = title; this.el.bBody.innerHTML = body;
    this.el.banner.style.display = 'block';
    this.el.bBack.onclick = onBack;
  },
  clearBanner() { this.el.banner.style.display = 'none'; },
  // --- M11 kinetic surfaces ---
  tickets(n) { if (this.el.tickets) this.el.tickets.textContent = n | 0; },
  toast(title, sub) { // queued self-removing card, CSS-animated
    const t = this.el.toasts; if (!t) return;
    const e = document.createElement('div'); e.className = 'toast';
    e.innerHTML = `<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}`;
    t.appendChild(e); setTimeout(() => e.remove(), 2500);
  },
  ribbon(x0, y0, x1, y1) { // drag vector as a rotated 1px neon div; ribbon(null) hides
    const el = this.el.ribbon; if (!el) return;
    if (x0 == null) { el.style.display = 'none'; return; }
    const dx = x1 - x0, dy = y1 - y0;                     // screen-px drag vector → length + angle
    el.style.display = 'block'; el.style.left = x0 + 'px'; el.style.top = y0 + 'px';
    el.style.width = Math.hypot(dx, dy) + 'px'; el.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  },
  rhythm(seq, idx, hot) { // key-glyph beat lane (Anchor); seq=null hides
    const el = this.el.rhythm; if (!el) return;
    if (!seq) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = seq.map((g, i) => `<span class="beat${i < idx ? ' done' : ''}${i === idx ? (hot ? ' cur hot' : ' cur') : ''}">${g}</span>`).join('');
  }
};
