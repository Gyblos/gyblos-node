// Runs the public packaging entry with synthetic assets and a fake Electron packager.
// Real archive commands exercise replacement; no app, network, wallet or operator home is opened.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function syntheticDesktopPackaging(root: string) {
  const sdk = join(root, 'sdk');
  const binding = join(root, 'binding');
  await mkdir(sdk);
  await mkdir(binding);
  await writeFile(join(sdk, 'index.cjs'), 'module.exports = {};');
  await writeFile(
    join(binding, 'package.json'),
    '{"name":"synthetic-binding"}',
  );
  await writeFile(
    join(binding, 'synthetic.node'),
    'synthetic-unloaded-binding',
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      version: '0.1.0',
      devDependencies: { electron: '45.0.0' },
    }),
  );
  const renderer = join(root, 'dist/renderer');
  await mkdir(renderer, { recursive: true });
  for (const name of [
    'main.cjs',
    'preload.cjs',
    'worker.cjs',
    'node-worker.cjs',
    'buyer-service.cjs',
  ])
    await writeFile(join(root, 'dist', name), 'module.exports = {};');
  const fake = join(root, 'packager.mjs');
  await writeFile(
    fake,
    `import {cp,mkdir,rm} from 'node:fs/promises';
    import {join} from 'node:path';
    export async function packager(options) {
      const out=join(options.out,options.name+'-'+options.platform+'-'+options.arch);
      await rm(out,{recursive:true,force:true});
      await mkdir(join(out,'resources'),{recursive:true});
      await cp(options.dir,join(out,'resources/app'),{recursive:true});
      return [out];
    }`,
  );
  const hook = join(root, 'hooks.mjs');
  await writeFile(
    hook,
    `import {registerHooks} from 'node:module';
    import {pathToFileURL} from 'node:url';
    const files=${JSON.stringify({
      '@electron/packager': fake,
      '@number0/iroh': join(sdk, 'index.cjs'),
      '@number0/iroh-win32-x64-msvc/package.json': join(
        binding,
        'package.json',
      ),
    })};
    registerHooks({resolve(name,context,next){
      if(files[name])return {url:pathToFileURL(files[name]).href,shortCircuit:true};
      return next(name,context);
    }});`,
  );
  const entry = new URL(
    '../../apps/desktop/scripts/package.ts',
    import.meta.url,
  );
  return {
    renderer,
    archive: join(root, 'dist/release/gyblos-desktop-0.1.0-win32-x64.zip'),
    async build() {
      await run(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--import',
          hook,
          entry.pathname,
          '--target',
          'win32-x64',
        ],
        {
          cwd: root,
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            GYBLOS_HOME: join(root, 'home'),
          },
        },
      );
    },
  };
}

export const listZip = async (path: string) =>
  (await run('unzip', ['-Z1', path])).stdout;
