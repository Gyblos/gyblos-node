// Stages only built assets and the pinned native binding into an unsigned arm64 app.
// No operational homes, logs, keys or repository source folders enter the package.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { packager } from '@electron/packager';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This probe packages macOS arm64 only.');
const require = createRequire(import.meta.url);
const stage = resolve('dist/stage');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'worker.cjs', 'renderer'])
  await cp(join('dist', file), join(stage, file), { recursive: true });
const manifest: { version: string; devDependencies: { electron: string } } =
  JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'gyblos-desktop-probe',
    version: manifest.version,
    main: 'main.cjs',
  }),
);
const sdk = dirname(require.resolve('@number0/iroh'));
const native = dirname(
  require.resolve('@number0/iroh-darwin-arm64', { paths: [sdk] }),
);
await mkdir(join(stage, 'node_modules/@number0'), { recursive: true });
await cp(sdk, join(stage, 'node_modules/@number0/iroh'), {
  recursive: true,
  dereference: true,
});
await cp(native, join(stage, 'node_modules/@number0/iroh-darwin-arm64'), {
  recursive: true,
  dereference: true,
});
await packager({
  dir: stage,
  out: 'dist/packages',
  name: 'Gyblos Desktop Probe',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: manifest.devDependencies.electron,
  appBundleId: 'com.gyblos.desktop-probe',
  asar: false,
  overwrite: true,
  prune: false,
});
