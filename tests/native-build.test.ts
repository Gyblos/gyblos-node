// Owns the packaged release as a seller receives it, built for this machine with its own Node: the archive
// unpacks to a launcher that works through a ~/.local/bin link, keeps everything in ~/.gyblos, and runs
// init, setup and doctor without a checkout, pnpm or the network. Other targets download pinned inputs and
// are built by the release workflow.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  archiveName,
  buildNative,
  hostTarget,
  lockedPackage,
  NATIVE,
} from '../tooling/native-build';

const run = promisify(execFile);
const VERSION = '0.0.0-test.1';
// A devnet mint address; setup only records it.
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

void test('every native target pins its iroh binding in the lockfile', async () => {
  for (const target of Object.values(NATIVE.targets)) {
    const locked = await lockedPackage(target.iroh);
    assert.match(locked.version, /^\d+\.\d+\.\d+$/);
    assert.match(locked.sha512, /^[A-Za-z0-9+/]+=*$/);
    assert.match(target.nodeSha256, /^[0-9a-f]{64}$/);
  }
});

void test(
  'the packaged seller runs init, setup and doctor from ~/.gyblos through a linked launcher',
  { skip: hostTarget() === undefined },
  async () => {
    const target = hostTarget()!;
    const root = await mkdtemp(join(tmpdir(), 'gyblos-native-test-'));
    try {
      const built = await buildNative({
        version: VERSION,
        target,
        out: join(root, 'out'),
        node: process.execPath,
      });
      assert.equal(
        built.archive,
        join(root, 'out', archiveName(VERSION, target)),
      );
      assert.match(
        await readFile(`${built.archive}.sha256`, 'utf8'),
        new RegExp(`^${built.sha256}  ${archiveName(VERSION, target)}\\n$`),
      );
      const account = join(root, 'account');
      const app = join(account, '.gyblos/app');
      await mkdir(join(account, '.local/bin'), { recursive: true });
      await mkdir(app, { recursive: true });
      await run('tar', ['-xzf', built.archive, '-C', app]);
      const installed = join(app, `gyblos-${VERSION}-${target}`);
      await symlink(installed, join(app, 'current'));
      const link = join(account, '.local/bin/gyblos');
      await symlink(join(app, 'current', NATIVE.launcher), link);
      const gyblos = (...args: string[]) =>
        run(link, args, {
          cwd: root,
          // A container flag, CDPATH and Node variables from the caller's shell change nothing.
          env: {
            HOME: account,
            PATH: '/usr/bin:/bin',
            GYBLOS_CONTAINER: '1',
            CDPATH: root,
            NODE_OPTIONS: '--no-such-option',
          },
        }).then(
          (result) => ({ code: 0, stdout: result.stdout }),
          (error: { code: number; stdout: string }) => error,
        );

      assert.equal((await gyblos('--version')).stdout, `${VERSION}\n`);
      // Only what runs is shipped: no binding sources, and the bundle's license notices.
      const irohFiles = await readdir(
        join(installed, 'lib/node_modules/@number0/iroh'),
      );
      assert.ok(!irohFiles.includes('src') && irohFiles.includes('index.js'));
      await readFile(join(installed, 'lib/gyblos.mjs.LEGAL.txt'), 'utf8');
      const init = await gyblos('seller', 'init');
      assert.match(init.stdout, /`gyblos doctor`/);
      const setup = await gyblos('setup', '--role', 'seller', '--mint', MINT);
      const role = JSON.parse(setup.stdout) as { nodeId: string };
      assert.match(role.nodeId, /^[0-9a-f]{64}$/);
      const doctor = await gyblos('doctor');
      assert.equal(doctor.code, 1);
      assert.match(doctor.stdout, /OK\s+role/);
      assert.match(doctor.stdout, /run `gyblos tokenizer`/);
      assert.ok(doctor.stdout.includes(role.nodeId));
      // Everything stays in ~/.gyblos: nothing in the working directory.
      assert.deepEqual((await readdir(root)).sort(), ['account', 'out']);
      assert.deepEqual((await readdir(join(account, '.gyblos'))).sort(), [
        'app',
        'gyblos.toml',
        'seller',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
