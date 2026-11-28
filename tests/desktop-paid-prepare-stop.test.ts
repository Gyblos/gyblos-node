// Exercise the real authenticated loopback client and compare Stop on either side of the payment boundary.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { sessionMeter } from '@gyblos/buyer/session-requirements';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { MODEL_IDS } from '@gyblos/protocol/constants';

import { batchDeferred } from './support/batch-deferred';

void test('Stop during tokenizer preparation leaves no reservation, but Stop after transmitting a paid request keeps it pending', async (t) => {
  const waiting = batchDeferred<void>();
  const download = batchDeferred<void>();
  const executing = batchDeferred<void>();
  const finish = batchDeferred<void>();
  let loads = 0;
  let posts = 0;
  const meter = sessionMeter('100', {
    preparePaidTokenizer: true,
    meter: async () => {
      loads++;
      await download.promise;
      return { chat: () => 1, count: () => 1, input: () => 1 };
    },
  });
  const token = 'synthetic-local-buyer-token';
  const selection = {
    modelId: MODEL_IDS.QWEN3_0_6B,
    variant: null,
    quantization: null,
  };
  const choice = {
    ...selection,
    nodeId: 'a'.repeat(64),
    owner: '11111111111111111111111111111111',
    expiresAt: Date.now() + 60000,
    contextTokens: 2048,
    inputAtomicPerMtok: '20',
    outputAtomicPerMtok: '80',
  };
  const host = await startFreeBuyerHttp(
    async () => {
      posts++;
      waiting.resolve();
      await meter();
      executing.resolve();
      await finish.promise;
      throw new Error('synthetic transport failure');
    },
    { selection, maxTokens: 10, sellerChoice: true },
    {
      port: 0,
      token,
      preparePaidChat: async () => {
        waiting.resolve();
        await meter();
      },
      desktopPolicy: {
        network: DEVNET,
        mint: DEVNET_USDC,
        payer: choice.owner,
        maxAtomic: '100',
        depositAtomic: '10000',
        lifetimeMs: 3600000,
      },
    },
  );
  let saved: string | undefined;
  const ledger = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
  const client = new X402Client(ledger);
  t.after(async () => {
    download.resolve();
    finish.resolve();
    await client.close();
    await host.close();
  });
  await client.connect(host.url, token);
  const first = client.send('prepare-stop', 'one', undefined, choice);
  await waiting.promise;
  assert.equal(client.stop('prepare-stop'), true);
  await assert.rejects(first);
  assert.equal((await ledger.summary()).blocked, false);
  assert.equal(posts, 0);
  assert.equal(saved, undefined);
  download.resolve();
  const second = client.send('execute-stop', 'two', undefined, choice);
  await executing.promise;
  assert.equal(posts, 1);
  assert.equal(loads, 1);
  assert.equal(client.stop('execute-stop'), true);
  await assert.rejects(second);
  assert.equal((await ledger.summary()).blocked, true);
});

void test('only the owner can prepare paid chat, with the current policy and an empty request', async (t) => {
  let preparations = 0;
  const scope = {
    network: DEVNET,
    mint: DEVNET_USDC,
    payer: '11111111111111111111111111111111',
  };
  const keys = await createBuyerApiKeys({
    scope,
    files: { read: async () => undefined, write: async () => {} },
  });
  t.after(() => keys.close());
  const key = await keys.create('synthetic key', '100');
  const token = 'synthetic-owner-token';
  const host = await startFreeBuyerHttp(
    async () => assert.fail('unexpected inference'),
    {
      maxTokens: 1,
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: null,
      },
    },
    {
      port: 0,
      apiKeys: keys,
      reconcilePool: async () => {},
      token,
      desktopPolicy: { ...scope, maxAtomic: '100' },
      preparePaidChat: async () => {
        preparations++;
        throw new Error('synthetic private details');
      },
    },
  );
  t.after(() => host.close());
  const metadata = await fetch(new URL(BUYER_API.STATUS_PATH, host.url), {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(
    metadata.headers.get(BUYER_API.PAID_PREPARATION_HEADER),
    BUYER_API.PAID_PREPARATION_PATH,
  );
  assert.equal(
    metadata.headers.get(BUYER_API.RECONCILE_POOL_HEADER),
    BUYER_API.RECONCILE_POOL_PATH,
  );
  const delegated = await fetch(new URL(BUYER_API.STATUS_PATH, host.url), {
    headers: { authorization: 'Bearer ' + key.secret },
  });
  assert.equal(delegated.status, 403);
  await delegated.body?.cancel();
  const { policyId } = await metadata.json();
  const url = new URL(BUYER_API.PAID_PREPARATION_PATH, host.url);
  const headers = {
    authorization: 'Bearer ' + token,
    'if-match': '"' + policyId + '"',
  };
  const post = (options: RequestInit) =>
    fetch(url, { method: 'POST', headers, ...options });
  assert.equal(
    (
      await post({
        headers: { ...headers, authorization: 'Bearer ' + key.secret },
      })
    ).status,
    403,
  );
  assert.equal(
    (await post({ headers: { ...headers, origin: 'https://example.com' } }))
      .status,
    403,
  );
  assert.equal(
    (await post({ headers: { ...headers, 'if-match': 'stale' } })).status,
    412,
  );
  assert.equal((await post({ body: 'must be empty' })).status, 400);
  assert.equal((await post({ method: 'GET' })).status, 400);
  assert.equal(preparations, 0);
  const failed = await post({});
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), '');
  assert.equal(preparations, 1);
});
