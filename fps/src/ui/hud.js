// Single Canvas2D tactical HUD. No per-frame DOM mutation.

export function createHUD({ root, bus }) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; root.appendChild(canvas);
  const g = canvas.getContext('2d', { alpha: true });
  let w = 1, h = 1, dpr = 1, hit = 0, kill = 0, damage = 0, dmgAngle = 0;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2); w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize(); window.addEventListener('resize', resize);
  const offs = [
    bus.on('ai:hit', () => { hit = 0.16; }),
    bus.on('ai:death', () => { hit = 0.28; kill = 0.42; }),
    bus.on('player:damage', (e) => { damage = 0.65; dmgAngle = e.src ? Math.atan2(e.src.x - e.pos.x, e.src.z - e.pos.z) : 0; }),
  ];
  const line = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };

  return {
    step(dt, ctx) {
      hit = Math.max(0, hit - dt); kill = Math.max(0, kill - dt); damage = Math.max(0, damage - dt);
      g.clearRect(0, 0, w, h);
      const cx = w * 0.5, cy = h * 0.5, ps = ctx.player.state, ws = ctx.weapons.state;
      const spread = Math.max(5, Math.tan((ws.spreadDeg || 0) * Math.PI / 180) / Math.tan((ps.fov || 80) * Math.PI / 360) * h * 0.5);
      const alpha = 0.82 * (1 - (ws.ads || 0) * 0.88);
      g.strokeStyle = `rgba(225,238,244,${alpha})`; g.lineWidth = 1.5;
      const len = 7; line(cx - spread - len, cy, cx - spread, cy); line(cx + spread, cy, cx + spread + len, cy);
      line(cx, cy - spread - len, cx, cy - spread); line(cx, cy + spread, cx, cy + spread + len);
      g.fillStyle = `rgba(225,238,244,${alpha * .8})`; g.fillRect(cx - 1, cy - 1, 2, 2);

      if (hit > 0) {
        const a = Math.min(1, hit * 8); g.strokeStyle = kill > 0 ? `rgba(244,75,55,${a})` : `rgba(245,245,240,${a})`; g.lineWidth = 2;
        const r = 10 + (1 - a) * 4; line(cx - r, cy - r, cx - 3, cy - 3); line(cx + r, cy - r, cx + 3, cy - 3);
        line(cx - r, cy + r, cx - 3, cy + 3); line(cx + r, cy + r, cx + 3, cy + 3);
      }

      // Ammo block, health, and remaining hostiles use aligned tabular numerals.
      g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.font = '700 34px ui-monospace,Consolas,monospace';
      g.fillStyle = ws.ammo <= 5 ? '#ef5d4f' : '#e8edf1'; g.fillText(String(ws.ammo).padStart(2, '0'), w - 42, h - 48);
      g.font = '500 13px ui-monospace,Consolas,monospace'; g.fillStyle = '#7f8c97'; g.fillText(`/ ${String(ws.reserve).padStart(3, '0')}`, w - 42, h - 27);
      g.textAlign = 'left'; g.fillStyle = ps.health < 30 ? '#ef5d4f' : '#dfe7eb'; g.font = '700 20px ui-monospace,Consolas,monospace'; g.fillText(`${Math.ceil(ps.health)}`, 42, h - 43);
      g.fillStyle = '#64717d'; g.fillRect(42, h - 31, 112, 3); g.fillStyle = ps.health < 30 ? '#ef5d4f' : '#b8c6cc'; g.fillRect(42, h - 31, 112 * ps.health / 100, 3);
      const alive = ctx.ai.agents.reduce((n, a) => n + (a.alive ? 1 : 0), 0);
      g.font = '600 11px ui-monospace,Consolas,monospace'; g.fillStyle = '#8d9aa5'; g.fillText(`HOSTILES  ${alive}`, 42, 46);

      // Minimal compass ribbon.
      g.textAlign = 'center'; g.font = '600 11px ui-monospace,Consolas,monospace';
      const deg = ((-ps.yaw * 180 / Math.PI) % 360 + 360) % 360;
      const card = ['N', 'E', 'S', 'W'];
      for (let k = -4; k <= 4; k++) {
        const v = Math.round(deg / 15) * 15 + k * 15, x = cx + (v - deg) * 3.1, vn = (v % 360 + 360) % 360;
        g.fillStyle = k === 0 ? '#f0f3f4' : '#7f8c97'; g.fillText(vn % 90 === 0 ? card[(vn / 90) | 0] : String(vn).padStart(3, '0'), x, 30);
        g.fillRect(x, 34, 1, k === 0 ? 7 : 4);
      }

      if (ws.reloading) { g.fillStyle = '#b7c3ca'; g.font = '600 11px ui-monospace,Consolas,monospace'; g.fillText(ws.reloadStage.toUpperCase(), cx, cy + 56); }
      if (damage > 0) {
        const a = Math.min(.38, damage * .7), r = Math.max(w, h) * .58;
        const grd = g.createRadialGradient(cx, cy, Math.min(w, h) * .25, cx, cy, r); grd.addColorStop(0, 'rgba(130,0,0,0)'); grd.addColorStop(1, `rgba(155,8,0,${a})`);
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      }
      const s = ctx.stats;
      if (s) { g.textAlign = 'left'; g.font = '10px ui-monospace,monospace'; g.fillStyle = 'rgba(135,150,160,.55)'; g.fillText(`${s.fps.toFixed(0)} FPS  ${s.frameMs.toFixed(1)} MS`, 12, h - 10); }
    },
    dispose() { for (const off of offs) off(); window.removeEventListener('resize', resize); canvas.remove(); },
  };
}
