// Boot the built game headless and dump every console line + errors, no ready-wait.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = +(process.argv[2] ?? 4399);
const DIST = `.dist-cap-${PORT}`;
const WAIT = +(process.argv[3] ?? 90000);

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: 'inherit', shell: true, cwd: process.cwd() });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`))));
  });
}
await run('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir']);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', DIST], { stdio: 'ignore', shell: true, cwd: process.cwd() });
process.on('exit', () => { try { server.kill(); } catch {} });

for (let i = 0; i < 100; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 350));
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(`http://localhost:${PORT}/?headless&q=ultra`, { waitUntil: 'load' });
const t0 = Date.now();
while (Date.now() - t0 < WAIT) {
  const st = await page.evaluate(() => ({ has: !!window.__GAME__, ready: window.__GAME__?.ready, stage: window.__BOOT_STAGE__ }));
  if (st.ready) { console.log('READY after', Date.now() - t0, 'ms'); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('final', JSON.stringify(await page.evaluate(() => ({ has: !!window.__GAME__, ready: window.__GAME__?.ready, keys: window.__GAME__ ? Object.keys(window.__GAME__) : null, body: document.body.innerText.slice(0, 400) }))));
await browser.close();
process.exit(0);
