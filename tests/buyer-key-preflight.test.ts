// Local paid refusals must precede durable delegated-budget reservations, including cached runtimes.
// Each public composition runs in its own empty home with no operational RPC or inference services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';

import { controlFixture } from './support/control-fixture';
import { keyPreflightProgram } from './support/key-preflight';

const cases = [
  'model',
  'reasoning',
  'downgrade',
  'network',
  'mint',
  'quote-model',
  'quote-reasoning',
  'quote-mint',
  'tokens',
  'quote-tokens',
  'bytes',
  'escaped-bytes',
  'context',
  'history',
  'meter-input',
  'meter-load',
  'warm',
  'unrelated-model',
  'session-model',
  'session-model-pool',
  'session-context',
  'session-context-pool',
  'session-budget',
  'session-budget-pool',
  'session-expired',
  'session-expired-pool',
  'session-deposit',
  'session-deposit-pool',
  'aborted',
  'uncertain',
];
// tsx stores transforms under TMPDIR/tsx-<effective uid> on Linux.
let transformCache: { name: string; directory: string } | undefined;
before(async () => {
  if (process.platform === 'linux' && process.geteuid) {
    transformCache = {
      name: `tsx-${process.geteuid()}`,
      directory: await mkdtemp(join(tmpdir(), 'gyb-key-transforms-')),
    };
  }
});
after(async () => {
  if (transformCache)
    await rm(transformCache.directory, { recursive: true, force: true });
});

for (const scenario of cases)
  void test(`API-key preflight preserves delegated budget: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gyb-key-preflight-'));
    try {
      if (transformCache)
        await symlink(
          transformCache.directory,
          join(directory, transformCache.name),
        );
      const source = await controlFixture();
      source.request.params.maxAtomic = '100';
      const quote = await createControlQuote(
        source.request,
        source.context,
        source.ownerSigner,
      );
      const config: BuyerSelectionConfig = {
        request: {
          ...source.request.params,
          lowestReasoning: null,
          minimumBadge: SELLER_BADGES.DECLARED_USAGE,
          retention: [source.catalog.dataPolicy.retention],
        },
        sellers: [
          {
            owner: quote.offer.owner,
            nodeId: quote.offer.nodeId,
            relayUrl: null,
            directAddresses: [],
          },
        ],
      };
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          keyPreflightProgram({
            config,
            quote,
            input: {
              messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
              maxTokens: 10,
            },
            scenario,
            target: import.meta.resolve('@gyblos/buyer/quote-startup'),
          }),
        ],
        {
          cwd: new URL('..', import.meta.url),
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            TMPDIR: directory,
            GYBLOS_HOME: join(directory, 'home'),
            GYBLOS_LAB_HOME: join(directory, 'lab'),
          },
        },
      );
      assert.equal(child.status, 0, child.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
