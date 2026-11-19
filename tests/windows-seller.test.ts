// Owns the seller on real Windows (skipped elsewhere): setup restricts the home and seller folders to this
// account, doctor then accepts the keys, init writes config.toml, and keys in a folder others can open are
// refused. Offline.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  ensurePrivatePaymentPaths,
  writePrivateFile,
} from '@gyblos/runtime/private-file';
import {
  ACL_VERDICTS,
  pathsArePrivate,
  readAcls,
  restrictDirectory,
  userSid,
} from '@gyblos/runtime/windows-acl';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const run = promisify(execFile);
// The ACL cache lives per process: each check here is a fresh process or a fresh path.
const WINDOWS = process.platform === 'win32';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const ICACLS = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'icacls.exe',
);

void test(
  'windows: interrupted payment folder setup can be retried',
  { skip: !WINDOWS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-payment-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'payments');
    const paths = { directory, lock: join(directory, 'lock') };
    const source =
      "import { ensurePrivatePaymentPaths } from '@gyblos/runtime/private-file'; await ensurePrivatePaymentPaths(JSON.parse(process.argv[1]));";
    const failed = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        source,
        JSON.stringify(paths),
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, SystemRoot: root },
        encoding: 'utf8',
      },
    );
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /PRIVATE_FILE_UNAVAILABLE/);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    await ensurePrivatePaymentPaths(paths);
    assert.equal(await pathsArePrivate([directory]), ACL_VERDICTS.PRIVATE);
  },
);

void test(
  'windows: a restricted folder is private until someone else is granted access',
  { skip: !WINDOWS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-acl-'));
    try {
      const restricted = join(root, 'restricted');
      await mkdir(restricted);
      await restrictDirectory(restricted);
      assert.equal(
        await pathsArePrivate([restricted]),
        ACL_VERDICTS.PRIVATE,
        JSON.stringify({
          sid: await userSid(),
          acl: await readAcls([restricted]),
        }),
      );
      const shared = join(root, 'shared');
      await mkdir(shared);
      await restrictDirectory(shared);
      // Everyone may read it now.
      await run(ICACLS, [shared, '/grant', '*S-1-1-0:(OI)(CI)R']);
      assert.equal(await pathsArePrivate([shared]), ACL_VERDICTS.EXPOSED);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void test(
  'windows: buyer and seller payment stores reject exposed folders and restored journals',
  { skip: !WINDOWS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-payment-acl-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const role of ['buyer', 'seller']) {
      const directory = join(root, role, 'payments');
      const paths = {
        directory,
        state: join(directory, 'journal'),
        lock: join(directory, 'lock'),
      };
      await ensurePrivatePaymentPaths(paths);
      const container = join(directory, 'channels');
      const slot = join(container, 'peer');
      const child = {
        paymentRoot: directory,
        directory: slot,
        lock: join(slot, 'lock'),
      };
      await ensurePrivatePaymentPaths(child);
      await run(ICACLS, [container, '/grant', '*S-1-1-0:R']);
      await assert.rejects(ensurePrivatePaymentPaths(child));
      await writePrivateFile(paths.state, 'fixture', 100);
      await ensurePrivatePaymentPaths(paths);
      await run(ICACLS, [paths.state, '/grant', '*S-1-1-0:R']);
      await assert.rejects(ensurePrivatePaymentPaths(paths));
      await run(ICACLS, [paths.state, '/reset']);
      await run(ICACLS, [directory, '/grant', '*S-1-1-0:(OI)(CI)R']);
      await assert.rejects(ensurePrivatePaymentPaths(paths));
    }
  },
);

void test(
  'windows: setup, init and doctor work in a private seller home',
  { skip: !WINDOWS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-win-seller-'));
    try {
      const home = join(root, 'home');
      const gyblos = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ['--import', 'tsx', 'apps/node/src/bin.ts', ...args],
          {
            cwd: REPOSITORY_ROOT,
            encoding: 'utf8',
            env: {
              ...process.env,
              GYBLOS_HOME: home,
              GYBLOS_CONFIG: join(home, 'config.toml'),
            },
          },
        );
      const setup = gyblos('setup', '--role', 'seller', '--mint', MINT);
      assert.equal(setup.status, 0, setup.stderr);
      assert.match(setup.stdout, /"nodeId":"[0-9a-f]{64}"/);
      assert.equal(
        await pathsArePrivate([
          join(home, 'seller'),
          join(home, 'seller', 'node.key'),
        ]),
        ACL_VERDICTS.PRIVATE,
      );
      const init = gyblos('seller', 'init');
      assert.equal(init.status, 0, init.stderr);
      const doctor = gyblos('doctor');
      assert.match(doctor.stdout, /OK\s+role/, doctor.stdout + doctor.stderr);
      assert.match(doctor.stdout, /OK\s+keys/);
      assert.match(doctor.stdout, /OK\s+sequence/);
      // Someone else may now read the keys: the next process refuses them.
      await run(ICACLS, [
        join(home, 'seller'),
        '/grant',
        '*S-1-5-32-545:(OI)(CI)R',
      ]);
      const exposed = gyblos('doctor');
      assert.doesNotMatch(exposed.stdout, /OK\s+keys/);
      // Rerunning setup restores the folder and the keys, and doctor accepts them again.
      assert.equal(
        gyblos('setup', '--role', 'seller', '--mint', MINT).status,
        0,
      );
      assert.match(gyblos('doctor').stdout, /OK\s+keys/);
      // A key given its own permissions is refused, and setup resets it too.
      await run(ICACLS, [
        join(home, 'seller', 'node.key'),
        '/grant',
        '*S-1-5-32-545:R',
      ]);
      assert.doesNotMatch(gyblos('doctor').stdout, /OK\s+keys/);
      assert.equal(
        gyblos('setup', '--role', 'seller', '--mint', MINT).status,
        0,
      );
      assert.match(gyblos('doctor').stdout, /OK\s+keys/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
