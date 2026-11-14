// Bundles the probe's own code while keeping the native binding external.
// Does not initialize Electron, endpoints, services or operational configuration.
import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';

await build({
  entryPoints: [
    'src/main.ts',
    'src/preload.ts',
    'src/worker.ts',
    'src/node-worker.ts',
  ],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@number0/iroh'],
});
// Stage the buyer-owned executable; desktop source never imports another app.
await build({
  entryPoints: ['../buyer/src/desktop-worker.ts'],
  outfile: 'dist/buyer-service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@number0/iroh'],
  footer: { js: 'void module.exports.startBuyerWorker();' },
});
await buildRenderer({
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist/renderer' },
});
