// Seller startup no longer manages Ollama: it warms the engine at the offer's own URL and never starts a
// process. Offline; a synthetic Ollama on an ephemeral loopback port and synthetic memory snapshots.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROUTES } from '@gyblos/config';
import { MODEL } from '@gyblos/engine-ollama/constants';
import { READINESS_STATUSES } from '@gyblos/node/constants';
import type { ReadinessRecord } from '@gyblos/node/engine-readiness';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { prepareSellerOffers } from '@gyblos/node/seller-offers';
import { sellerSettings } from '@gyblos/node/seller-settings';
import type { MemorySnapshot } from '@gyblos/runtime/memory';

import { startFakeOllama } from './support/fake-ollama';
import { BASE, REPOSITORY_ROOT } from './support/node-config-fixtures';

const SNAPSHOT: MemorySnapshot = {
  source: 'linux-memavailable',
  vmAvailableBytes: 8 * 1024 ** 3,
  cgroup: null,
};

const freeOffer = (url: string) =>
  BASE +
  `[[offers]]\nmodel = "qwen3:0.6b"\nreasoning = ["off"]\nengine = { kind = "ollama", url = "${url}" }\n` +
  'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }\n';

void test('startup warms the engine at the offer URL, not at a managed port', async () => {
  const ollama = await startFakeOllama();
  try {
    const parsed = parseNodeConfig(freeOffer(`${ollama.url}/`));
    assert.ok(parsed.ok);
    const settings = sellerSettings(parsed.config, {});
    const records: ReadinessRecord[] = [];
    const { ready, pending } = await prepareSellerOffers(settings, {
      fetch: globalThis.fetch,
      environment: {},
      snapshot: async () => SNAPSHOT,
      record: async (_index, record) => {
        records.push(record);
      },
    });
    assert.equal(pending.length, 0);
    assert.equal(ready[0]!.model.digest, MODEL.digest);
    assert.ok(ready[0]!.offerExpiresAt > Date.now());
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, READINESS_STATUSES.PASSED);
    // The warmup really generated at the offer URL.
    assert.ok(
      ollama.paths.includes(ROUTES.ollamaGenerate),
      ollama.paths.join(),
    );
  } finally {
    await ollama.close();
  }
});

void test('a stopped engine at the offer URL fails startup before advertisement', async () => {
  const ollama = await startFakeOllama();
  const url = ollama.url;
  await ollama.close();
  const parsed = parseNodeConfig(freeOffer(url));
  assert.ok(parsed.ok);
  await assert.rejects(
    prepareSellerOffers(sellerSettings(parsed.config, {}), {
      fetch: globalThis.fetch,
      environment: {},
      snapshot: async () => SNAPSHOT,
      record: async () => undefined,
    }),
    /warmup failed/,
  );
});

void test('the seller daemon starts no process and binds no engine port', () => {
  const source = readFileSync(
    join(REPOSITORY_ROOT, 'packages/node/src/seller.ts'),
    'utf8',
  );
  for (const forbidden of [/spawnChild/, /ollama['"],\s*\[/, /assertPortFree/])
    assert.doesNotMatch(source, forbidden);
});
