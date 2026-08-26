// Headless screenshot harness — the eyes of the visual-critic loop.
//
// Boots the built game in Chromium with a real GPU-ish stack (ANGLE/SwiftShader),
// drives it via the deterministic scripted-input path, and writes PNGs.
//
//   node tools/capture.mjs --out shots/pass1 --shots hero,corridor,ads,muzzle
//
// Exits non-zero on any WebGL error or unhandled page exception so a failed
// render can never be silently graded as "looks fine".

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const OUT = path.resolve(args.out ?? 'shots/latest');
const SHOTS = (args.shots ?? 'hero').split(',').map((s) => s.trim()).filter(Boolean);
const W = +(args.w ?? 1920), H = +(args.h ?? 1080);
const SETTLE = +(args.settle ?? 12);   // frames to run before grabbing; raise once TAA lands
const PORT = +(args.port ?? 4173);

async function waitForServer(url, ms = 45000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error(`server ${url} did not come up`);
    await new Promise((r) => setTimeout(r, 350));
  }
}

// Each run builds into its OWN outDir and previews that dir, so parallel agents
// verifying at the same time cannot corrupt each other's dist/ or fight over a port.
const DIST = args.dist ?? `.dist-cap-${PORT}`;

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: 'inherit', shell: true, cwd: process.cwd() });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${argv.join(' ')} -> exit ${c}`))));
  });
}
if (args.build !== 'skip') await run('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir']);

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', DIST], {
  stdio: 'ignore', shell: true, cwd: process.cwd(),
});
const shutdown = () => { try { server.kill(); } catch {} };
process.on('exit', shutdown); process.on('SIGINT', () => { shutdown(); process.exit(130); });

let failed = false;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    args: [
      '--use-angle=swiftshader', '--use-gl=angle',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const logs = [];
  page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); failed = true; });

  // ?headless => scripted-input path + loop halted; capture drives frames itself.
  await page.goto(`http://localhost:${PORT}/?headless&q=${args.q ?? 'ultra'}`, { waitUntil: 'load' });

  // Game signals readiness once shaders are compiled + first frame presented.
  // NB: waitForFunction is (fn, arg, options) — options MUST be the 3rd param.
  // SwiftShader needs generous headroom; procedural texture gen is CPU-bound.
  // A boot failure surfaces here as a bare ready-timeout. Dump what the page said
  // first — otherwise "Timeout 180000ms exceeded" hides the actual exception.
  try {
    await page.waitForFunction(() => window.__GAME__?.ready === true, null, { timeout: 180000 });
  } catch (e) {
    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    console.error('[capture] game never became ready. page said:\n' + body + '\n--- console ---\n' + logs.join('\n'));
    throw e;
  }

  for (const name of SHOTS) {
    const ok = await page.evaluate((n) => window.__GAME__.pose(n), name);
    if (!ok) { logs.push(`[capture] unknown pose "${name}"`); failed = true; continue; }
    // Let TAA converge — a 1-frame grab of a temporally-accumulated image is noise.
    await page.evaluate((n) => window.__GAME__.settle(n), SETTLE);
    await page.waitForFunction(() => window.__GAME__.settled === true, null, { timeout: 120000 });
    await page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png', timeout: 180000, animations: 'disabled' });
    console.log(`captured ${name} -> ${path.join(OUT, `${name}.png`)}`);
  }

  const perf = await page.evaluate(() => window.__GAME__.perf());
  await writeFile(path.join(OUT, 'perf.json'), JSON.stringify(perf, null, 2));
  await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
  console.log('perf', JSON.stringify(perf));

  await browser.close();
} catch (e) {
  console.error('[capture] FAILED:', e.message);
  failed = true;
} finally {
  shutdown();
}
process.exit(failed ? 1 : 0);
