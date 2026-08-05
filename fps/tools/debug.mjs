// Boot diagnostic — dumps console + errors + WebGL caps. Not part of the critic loop.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4199;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', shell: true });
process.on('exit', () => { try { server.kill(); } catch {} });

const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 300)); } throw new Error('no server'); };
await up();

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', e => console.log('[PAGEERROR]', e.stack || e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 25000));

const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  return {
    ready: window.__GAME__?.ready ?? null,
    boot: document.getElementById('boot')?.textContent ?? '(removed)',
    webgl2: !!gl,
    renderer: gl?.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
    maxTex: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
    colorBufferFloat: !!gl?.getExtension('EXT_color_buffer_float'),
  };
});
console.log('INFO', JSON.stringify(info, null, 2));
await page.screenshot({ path: 'shots/debug.png' });
await browser.close();
process.exit(0);
