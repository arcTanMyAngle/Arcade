// Multi-hypothesis diagnostic — boots ONCE and screenshots several render
// variants, because a full boot on software GL costs minutes and testing one
// hypothesis per boot is unaffordable.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const PORT = 4333, OUT = 'shots/diag';
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', '.dist-cap-4322'],
  { stdio: 'ignore', shell: true });
process.on('exit', () => { try { server.kill(); } catch {} });
const up = async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 300)); } throw new Error('no server'); };
await up();
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });
page.on('pageerror', e => console.log('[PAGEERROR]', e.message));
await page.goto(`http://localhost:${PORT}/?headless`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME__?.ready === true, null, { timeout: 240000 });

const shot = async (name) => {
  await page.evaluate(() => window.__GAME__.settle(8));
  await page.waitForFunction(() => window.__GAME__.settled === true, null, { timeout: 120000 });
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
  console.log('shot', name);
};

// Report the actual runtime state of the suspect material + lighting.
const info = await page.evaluate(() => {
  const G = window.__GAME__;
  G.pose('hero');
  const out = { mats: {}, sun: {}, meshes: [] };
  for (const n of ['concreteFloor', 'concreteWall', 'asphalt', 'paintedMetal']) {
    const m = G.mats.get(n);
    out.mats[n] = {
      metalness: m.metalness, roughness: m.roughness,
      color: m.color.getHexString(),
      hasMap: !!m.map, hasAo: !!m.aoMap, hasNorm: !!m.normalMap,
      aoCh: m.aoMap?.channel, mapCh: m.map?.channel,
      envI: m.envMapIntensity, transparent: m.transparent, opacity: m.opacity,
    };
  }
  const s = G.lighting.sun;
  out.sun = {
    intensity: s.intensity, pos: s.position.toArray().map(v => +v.toFixed(2)),
    target: s.target.position.toArray().map(v => +v.toFixed(2)),
    castShadow: s.castShadow, bias: s.shadow.bias, normalBias: s.shadow.normalBias,
  };
  out.env = !!G.scene.environment;
  G.scene.traverse((o) => {
    if (o.isMesh && o.material?.name && out.meshes.length < 8) {
      out.meshes.push({ mat: o.material.name, pos: o.position.toArray().map(v => +v.toFixed(1)) });
    }
  });
  return out;
});
console.log(JSON.stringify(info, null, 2));

await shot('A_normal');

// B: shadows off entirely
await page.evaluate(() => {
  const G = window.__GAME__;
  G.rc.renderer.shadowMap.enabled = false;
  G.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
});
await shot('B_noshadow');

// C: plain white non-metal material everywhere (isolates lighting from materials)
await page.evaluate(() => {
  const G = window.__GAME__;
  G.rc.renderer.shadowMap.enabled = true;
  const T = G.THREE;
  const white = new T.MeshStandardMaterial({ color: 0x999999, roughness: 0.85, metalness: 0 });
  G.scene.traverse(o => { if (o.isMesh && o.name !== 'sky') { o.userData._m = o.material; o.material = white; } });
});
await shot('C_white');

// D: original materials, but aoMap removed (tests AO crushing)
await page.evaluate(() => {
  const G = window.__GAME__;
  G.scene.traverse(o => { if (o.isMesh && o.userData._m) o.material = o.userData._m; });
  for (const n of G.mats.list()) { const m = G.mats.get(n); m.aoMap = null; m.needsUpdate = true; }
});
await shot('D_noAO');

// E: also drop normalMap (tests tangent/normal-map breakage)
await page.evaluate(() => {
  const G = window.__GAME__;
  for (const n of G.mats.list()) { const m = G.mats.get(n); m.normalMap = null; m.needsUpdate = true; }
});
await shot('E_noNormal');

await browser.close();
process.exit(0);
