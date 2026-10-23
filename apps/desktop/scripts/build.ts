// Bundles the probe's own code while keeping the native binding external.
// Does not initialize Electron, endpoints, services or operational configuration.
import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';

await build({
  entryPoints: ['src/main.ts', 'src/preload.ts', 'src/worker.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@number0/iroh'],
});
await buildRenderer({
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist/renderer' },
});
