import { defineConfig } from 'vite';

// Suite root = this dir. Keep it minimal; three is the only runtime dep.
export default defineConfig({
  root: '.',
  base: './',
  build: { target: 'es2020', outDir: 'dist' },
  server: { open: true }
});
