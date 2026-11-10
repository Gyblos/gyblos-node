// Owns the npm packages of the packaged seller: `gyblos` names one optional `@gyblos/seller-<target>` per
// platform at the same version, each platform package is the native archive without node_modules (npm
// installs the pinned iroh binding instead), and the wrapper starts this machine's seller, says so when
// its package is missing, and marks npm as the installer for update notices. The service refuses an npx
// cache. Built for this machine with its own Node; offline.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { RUN_MODES } from '@gyblos/config';

import {
  defaultServiceSystem,
  serviceCommand,
} from '../apps/node/src/cli-service';
import { updateNotice } from '../apps/node/src/cli-update';
import { buildNative, hostTarget, NATIVE } from '../tooling/native-build';
import {
  buildNpmPackages,
  NPM,
  platformPackage,
  wrapperScript,
} from '../tooling/npm-packages';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const run = promisify(execFile);
const VERSION = '0.0.0-npm.1';

void test(
  'npm packages: the wrapper runs this machine’s packaged seller from a global install',
  { skip: hostTarget() === undefined },
  async () => {
    const target = hostTarget()!;
    const root = await mkdtemp(join(tmpdir(), 'gyblos-npm-test-'));
    try {
      const archives = join(root, 'native');
      await buildNative({
        version: VERSION,
        target,
        out: archives,
        node: process.execPath,
      });
      // Relative paths, as the release passes them: npm pack runs inside each package.
      const cwd = process.cwd();
      process.chdir(root);
      let tarballs: string[];
      try {
        tarballs = await buildNpmPackages({
          version: VERSION,
          targets: [target],
          archives: 'native',
          out: 'npm',
        });
      } finally {
        process.chdir(cwd);
      }
      assert.equal(tarballs.length, 2);
      // Only the tarballs are left.
      assert.deepEqual(
        (await readdir(join(root, 'npm'))).filter(
          (name) => !name.endsWith('.tgz'),
        ),
        [],
      );
      // A global install's layout: each tarball unpacked under node_modules, the binding as npm would add it.
      const modules = join(root, 'prefix/lib/node_modules');
      const unpack = async (tarball: string, name: string) => {
        await mkdir(join(modules, name), { recursive: true });
        await run('tar', [
          '-xzf',
          tarball,
          '-C',
          join(modules, name),
          '--strip-components=1',
        ]);
      };
      await unpack(tarballs[0]!, platformPackage(target));
      await unpack(tarballs[1]!, NPM.main);
      const main = JSON.parse(
        await readFile(join(modules, NPM.main, 'package.json'), 'utf8'),
      ) as {
        optionalDependencies: Record<string, string>;
        bin: Record<string, string>;
      };
      assert.deepEqual(main.optionalDependencies, {
        [platformPackage(target)]: VERSION,
      });
      assert.deepEqual(main.bin, { gyblos: 'bin/gyblos.js' });
      const platform = JSON.parse(
        await readFile(
          join(modules, platformPackage(target), 'package.json'),
          'utf8',
        ),
      ) as { dependencies: Record<string, string>; files: string[] };
      assert.deepEqual(Object.keys(platform.dependencies), [
        NATIVE.irohPackage,
      ]);
      assert.deepEqual(platform.files, ['bin', 'lib', 'runtime', 'LICENSE']);
      await assert.rejects(
        readFile(
          join(
            modules,
            platformPackage(target),
            'lib/node_modules/@number0/iroh/package.json',
          ),
        ),
      );
      const require = createRequire(
        join(REPOSITORY_ROOT, 'packages/transport-iroh/package.json'),
      );
      const loader = dirname(
        require.resolve(`${NATIVE.irohPackage}/package.json`),
      );
      await cp(loader, join(modules, NATIVE.irohPackage), {
        recursive: true,
        dereference: true,
      });
      const binding = dirname(
        createRequire(join(loader, 'index.js')).resolve(
          `@number0/${NATIVE.targets[target].iroh}/package.json`,
        ),
      );
      await cp(
        binding,
        join(modules, '@number0', NATIVE.targets[target].iroh),
        {
          recursive: true,
          dereference: true,
        },
      );
      const account = join(root, 'account');
      const gyblos = (...args: string[]) =>
        run(
          process.execPath,
          [join(modules, NPM.main, 'bin/gyblos.js'), ...args],
          {
            cwd: root,
            env: {
              HOME: account,
              PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            },
          },
        ).then(
          (result) => ({
            code: 0,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
      assert.equal((await gyblos('--version')).stdout, `${VERSION}\n`);
      const setup = await gyblos(
        'setup',
        '--role',
        'seller',
        '--mint',
        '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      );
      assert.equal(setup.code, 0, setup.stderr);
      assert.match(setup.stdout, /"nodeId":"[0-9a-f]{64}"/);
      await rm(join(modules, '@gyblos'), { recursive: true, force: true });
      const missing = await gyblos('--version');
      assert.equal(missing.code, 1);
      assert.match(
        missing.stderr,
        /seller-.* is missing: reinstall with optional dependencies/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void test('npm installs are updated with npm, and a service never runs from the npx cache', async () => {
  const environment = {
    GYBLOS_VERSION: '0.1.0-beta.5',
    GYBLOS_INSTALLED_BY: 'npm',
  };
  const newer = async () =>
    new Response(JSON.stringify({ tag_name: 'v0.1.0-beta.7' }), {
      status: 200,
    });
  assert.match(
    (await updateNotice(environment, newer, RUN_MODES.PACKAGED)) ?? '',
    /run `npm install -g gyblos@latest`/,
  );
  assert.match(
    (await updateNotice(
      { GYBLOS_VERSION: '0.1.0-beta.5' },
      newer,
      RUN_MODES.PACKAGED,
    )) ?? '',
    /sh install\.sh update/,
  );
  const npx = defaultServiceSystem({
    GYBLOS_PACKAGED: '1',
    GYBLOS_LAUNCHER:
      '/home/ana/.npm/_npx/1a2b/node_modules/@gyblos/seller-linux-x64/bin/gyblos',
  });
  let stderr = '';
  const code = await serviceCommand(
    'install',
    { dryRun: true },
    {
      env: { GYBLOS_HOME: '/home/ana/.gyblos' },
      cwd: '/home/ana',
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    },
    { ...npx, platform: 'linux', uid: 1000, accountHome: '/home/ana' },
  );
  assert.notEqual(code, 0);
  assert.match(
    stderr,
    /SERVICE_EPHEMERAL_INSTALL: this gyblos runs from a temporary cache/,
  );
});

void test(
  'npm wrapper: a stop signal reaches the seller, and the seller’s signal is the wrapper’s',
  { skip: hostTarget() === undefined },
  async () => {
    const target = hostTarget()!;
    const root = await mkdtemp(join(tmpdir(), 'gyblos-npm-signal-'));
    try {
      const modules = join(root, 'node_modules');
      const seller = join(modules, platformPackage(target));
      await mkdir(join(seller, 'bin'), { recursive: true });
      await writeFile(
        join(seller, 'package.json'),
        JSON.stringify({ name: platformPackage(target), version: VERSION }),
      );
      // A seller that records the signal it got, then stops by it.
      await writeFile(
        join(seller, 'bin/gyblos'),
        `#!/bin/sh\ntrap 'echo got-$1 >"${join(root, 'signal')}"; trap - TERM INT; kill -TERM $$' TERM\ntrap 'echo got-INT >"${join(root, 'signal')}"; trap - INT; kill -INT $$' INT\necho ready\nwhile :; do sleep 0.1; done\n`,
      );
      await chmod(join(seller, 'bin/gyblos'), 0o755);
      const wrapper = join(modules, NPM.main, 'bin/gyblos.js');
      await mkdir(dirname(wrapper), { recursive: true });
      await writeFile(wrapper, wrapperScript(VERSION));
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        const child = spawn(process.execPath, [wrapper], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        await new Promise((ready) => child.stdout.once('data', ready));
        child.kill(signal);
        const [, ended] = (await once(child, 'exit')) as [
          number | null,
          string,
        ];
        assert.equal(ended, signal);
        assert.match(
          await readFile(join(root, 'signal'), 'utf8'),
          signal === 'SIGTERM' ? /got-/ : /got-INT/,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
