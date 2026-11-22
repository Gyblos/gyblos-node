// The operator scripts start Wrangler the same way on Windows, macOS and Linux: npm's npx script run by
// this Node binary (no shell, so SQL never meets a command interpreter, and no npx.cmd, which Node will
// not spawn without one). The paths are computed, not looked up on PATH. Offline; nothing is run.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  wranglerD1,
  wranglerLaunch,
} from '@gyblos/discovery-index/wrangler-d1';

const ARGS = [
  'd1',
  'execute',
  'gyblos-discovery',
  '--local',
  '--command',
  'SELECT 1',
];

void test('on Windows, npx-cli.js beside node.exe runs under node.exe', () => {
  const seen: string[] = [];
  const launch = wranglerLaunch(
    'win32',
    'C:\\Program Files\\nodejs\\node.exe',
    ARGS,
    (path) => {
      seen.push(path);
      return true;
    },
  );
  assert.deepEqual(launch, {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: [
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
      'wrangler@4.151.1',
      ...ARGS,
    ],
  });
  assert.deepEqual(seen, [
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
  ]);
});

void test('on macOS and Linux, npx-cli.js under lib/node_modules runs under the same node', () => {
  for (const platform of ['darwin', 'linux'] as const)
    assert.deepEqual(
      wranglerLaunch(
        platform,
        '/home/me/.nvm/versions/node/v24.22.1/bin/node',
        ARGS,
        () => true,
      ),
      {
        file: '/home/me/.nvm/versions/node/v24.22.1/bin/node',
        args: [
          '/home/me/.nvm/versions/node/v24.22.1/lib/node_modules/npm/bin/npx-cli.js',
          'wrangler@4.151.1',
          ...ARGS,
        ],
      },
    );
});

void test('on macOS and Linux without npm beside node, npx on PATH runs without a shell', () => {
  const seen: string[] = [];
  for (const platform of ['darwin', 'linux'] as const)
    assert.deepEqual(
      wranglerLaunch(platform, '/opt/node/bin/node', ARGS, (path) => {
        seen.push(path);
        return false;
      }),
      { file: 'npx', args: ['wrangler@4.151.1', ...ARGS] },
    );
  // The beside-node path is always tried first.
  assert.deepEqual(seen, [
    '/opt/node/lib/node_modules/npm/bin/npx-cli.js',
    '/opt/node/lib/node_modules/npm/bin/npx-cli.js',
  ]);
});

void test('on Windows without npm beside node.exe the launch is refused with a static message, never a shell', () => {
  assert.throws(
    () => wranglerLaunch('win32', 'C:\\node\\node.exe', ARGS, () => false),
    /npm's npx was not found next to this Node\.js/,
  );
});

void test('Homebrew-style Node with npm in another prefix falls back to npx on PATH', () => {
  assert.deepEqual(
    wranglerLaunch(
      'darwin',
      '/opt/homebrew/Cellar/node/24.22.1/bin/node',
      ARGS,
      (path) => path === '/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js',
    ),
    { file: 'npx', args: ['wrangler@4.151.1', ...ARGS] },
  );
});

void test('a failed Wrangler launch throws a static error without the SQL or its values', () => {
  const sql =
    "INSERT INTO discovery_invites VALUES ('hash', 'seller@example.com')";
  assert.throws(
    () =>
      wranglerD1(sql, { target: '--remote', json: false }, () => {
        throw new Error(
          `Command failed: npx wrangler@4.151.1 d1 execute --command ${sql}\nspawn npx ENOENT`,
        );
      }),
    (error: unknown) =>
      // Either static message (a Windows runner without npm beside node.exe stops at the launcher).
      error instanceof Error &&
      !error.message.includes('INSERT') &&
      !error.message.includes('seller@example.com') &&
      error.cause === undefined,
  );
});
