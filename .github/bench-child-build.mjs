import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: ['tests/support/batch-recovery-child.ts'],
  outfile: 'node_modules/.cache/batch-recovery-child.mjs',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  plugins: [{
    name: 'keep-third-party-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.path.startsWith('@gyblos/') || args.kind === 'entry-point') return;
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        const url = import.meta.resolve(args.path, pathToFileURL(args.importer).href);
        return {path: url.startsWith('file:') ? fileURLToPath(url) : url, external:true};
      });
    },
  }],
});
