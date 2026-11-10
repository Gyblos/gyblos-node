// `pnpm buyer:free` startup failures name the missing piece and the next step instead of one generic
// code (in the first real run a missing selection.json only printed FREE_BUYER_CONFIGURATION_REQUIRED).
// Spawns the real entry against a disposable home; no network, relay or wallet funding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SELECTION = {
  request: {
    selection: { modelId: 'qwen3-0.6b', variant: null, quantization: 'Q4_K_M' },
    reasoning: 'off',
    lowestReasoning: null,
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    asset: MINT,
    maxTokens: 64,
    maxAtomic: '0',
    priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    minimumBadge: 'declared-usage',
    retention: ['none'],
  },
  sellers: [
    {
      owner: '4NxTufBox2MsDggn9yF2vEZ6TE55ZkcgoEY5Kuv1oRTP',
      nodeId:
        '5482bad2e0f534be4d92525ff99953bc146531e1696d43e92289f246ef0bd738',
      relayUrl: null,
      directAddresses: [],
    },
  ],
};

function run(script: string, home: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: REPOSITORY_ROOT,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      GYBLOS_HOME: home,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}
const start = (home: string) => run('apps/buyer/src/free-main.ts', home);

void test('buyer:free explains each startup failure without printing the home path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-free-start-'));
  try {
    const noRole = start(home);
    assert.equal(noRole.status, 1);
    assert.match(
      noRole.stderr,
      /FREE_BUYER_CONFIGURATION_REQUIRED BUYER_ROLE_MISSING/,
    );
    assert.match(noRole.stderr, /pnpm node:setup --role buyer/);

    const setup = run('apps/node/src/bin.ts', home, [
      'setup',
      '--role',
      'buyer',
      '--mint',
      MINT,
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    const noSelection = start(home);
    assert.match(noSelection.stderr, /SELECTION_CONFIG_MISSING/);
    assert.match(noSelection.stderr, /selection\.json/);

    const path = join(home, 'buyer', 'selection.json');
    await writeFile(path, '{"request":');
    assert.match(start(home).stderr, /SELECTION_CONFIG_INVALID/);

    await writeFile(
      path,
      JSON.stringify({
        ...SELECTION,
        request: { ...SELECTION.request, maxTokens: 500 },
      }),
    );
    assert.match(start(home).stderr, /SELECTION_MAX_TOKENS_TOO_HIGH/);

    await writeFile(path, JSON.stringify(SELECTION));
    const noToken = start(home);
    assert.match(noToken.stderr, /MISSING_RELAY_TOKEN/);

    for (const result of [noRole, noSelection, noToken])
      assert.equal(result.stderr.includes(home), false, result.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
