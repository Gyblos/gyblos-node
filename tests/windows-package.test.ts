// Owns the packaged seller for Windows as the release builds it (on Linux, from pinned downloads) and a
// seller receives it, on real Windows: the archive unpacks with Windows' own tar, gyblos.cmd runs through
// an app\current junction and keeps everything in %USERPROFILE%\.gyblos, and `npm install -g` of the npm
// packages gives a working `gyblos`. CI's windows job sets GYBLOS_WINDOWS_PACKAGE to the folder holding
// the archive and the npm tarballs built by its windows-package job; skipped elsewhere.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { archiveName, nativeLayout, TAR } from '../tooling/native-build';
import { NPM, platformPackage } from '../tooling/npm-packages';

const run = promisify(execFile);
const PACKAGE = process.env.GYBLOS_WINDOWS_PACKAGE;
const VERSION = process.env.GYBLOS_WINDOWS_VERSION ?? '';
const TARGET = 'win32-x64';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CMD = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'cmd.exe',
);
// A container flag and Node options from the caller's shell change nothing in the packaged seller; the
// npm wrapper itself runs on the caller's Node, so only the container flag reaches it.
const HOSTILE = { GYBLOS_CONTAINER: '1', NODE_OPTIONS: '--no-such-option' };
const skip = process.platform !== 'win32' || !PACKAGE || !VERSION;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

// A .cmd runs only through cmd.exe; the temporary paths here have no spaces or cmd metacharacters.
function cmd(
  script: string,
  args: string[],
  account: string,
  cwd: string,
  extra: Record<string, string> = {},
): Promise<Result> {
  return run(CMD, ['/d', '/c', script, ...args], {
    cwd,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: account,
      ...extra,
    },
  }).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: Result) => error,
  );
}

async function sellerRuns(gyblos: (...args: string[]) => Promise<Result>) {
  assert.equal((await gyblos('--version')).stdout.trim(), VERSION);
  const init = await gyblos('seller', 'init');
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /`gyblos doctor`/);
  const setup = await gyblos('setup', '--role', 'seller', '--mint', MINT);
  assert.equal(setup.code, 0, setup.stderr);
  const role = JSON.parse(setup.stdout) as { nodeId: string };
  assert.match(role.nodeId, /^[0-9a-f]{64}$/);
  const doctor = await gyblos('doctor');
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /OK\s+role/);
  assert.match(doctor.stdout, /run `gyblos tokenizer`/);
}

void test(
  'windows: the release archive runs init, setup and doctor from %USERPROFILE%\\.gyblos through a junction',
  { skip, timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-winpkg-'));
    try {
      const account = join(root, 'account');
      const app = join(account, '.gyblos', 'app');
      await mkdir(app, { recursive: true });
      await run(TAR, [
        '-xzf',
        join(PACKAGE!, archiveName(VERSION, TARGET)),
        '-C',
        app,
      ]);
      const installed = join(app, `gyblos-${VERSION}-${TARGET}`);
      await symlink(installed, join(app, 'current'), 'junction');
      const launcher = join(app, 'current', nativeLayout(TARGET).launcher);
      const work = join(root, 'work');
      await mkdir(work);
      await sellerRuns((...args) =>
        cmd(launcher, args, account, work, HOSTILE),
      );
      // Everything stays in ~/.gyblos: nothing in the working directory.
      assert.deepEqual(await readdir(work), []);
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

void test(
  'windows: npm install -g of the npm packages gives a working gyblos',
  { skip, timeout: 300_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-winnpm-'));
    try {
      const prefix = join(root, 'prefix');
      const tarball = (name: string) =>
        join(
          PACKAGE!,
          `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`,
        );
      // The platform package first and explicitly: this version is not on the registry. Its iroh binding
      // comes from the registry, as for a seller.
      const install = await cmd(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          prefix,
          '--cache',
          join(root, 'npm-cache'),
          '--no-audit',
          '--no-fund',
          tarball(platformPackage(TARGET)),
          tarball(NPM.main),
        ],
        root,
        root,
      );
      assert.equal(install.code, 0, install.stderr);
      const account = join(root, 'account');
      await mkdir(account);
      await sellerRuns((...args) =>
        cmd(join(prefix, 'gyblos.cmd'), args, account, root, {
          GYBLOS_CONTAINER: '1',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
