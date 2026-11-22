// The operator scripts start Wrangler the same way on Windows, macOS and Linux: npm's npx script run by
// this Node binary (no shell, so SQL never meets a command interpreter, and no npx.cmd, which Node will
// not spawn without one). The paths are computed, not looked up on PATH. Offline; nothing is run.
import assert from 'node:assert/strict';
import test from 'node:test';

import { wranglerLaunch } from '@gyblos/discovery-index/wrangler-d1';

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

void test('without npm beside node the launch is refused with a static message, never a shell', () => {
  for (const platform of ['win32', 'linux'] as const)
    assert.throws(
      () => wranglerLaunch(platform, '/opt/node/bin/node', ARGS, () => false),
      /npm's npx was not found next to this Node\.js/,
    );
});
