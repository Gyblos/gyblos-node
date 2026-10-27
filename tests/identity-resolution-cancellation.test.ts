// Exercises absolute lookup deadlines and cancellation using an in-memory uncooperative RPC transport.
// No socket, real RPC endpoint, identity write or signing operation is available to this port.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSolanaRpcFromTransport,
  type Base58EncodedBytes,
} from '@solana/kit';

import { DEVNET_GENESIS } from '@gyblos/config';
import {
  IDENTITY_LOOKUP_FAILURES as F,
  IDENTITY_LOOKUP_KINDS as K,
} from '@gyblos/core/identity-policy';
import { readRegistryIdentity } from '@gyblos/identity/resolution';

const NODE = '11'.repeat(32);
function isBase58(value: string): value is Base58EncodedBytes {
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}
void test('read-only registry lookup honors pre-cancellation without starting RPC', async () => {
  let calls = 0;
  const rpc = createSolanaRpcFromTransport(async () => {
    calls++;
    return new Promise<never>(() => {});
  });
  const controller = new AbortController();
  controller.abort();
  const result = await readRegistryIdentity(rpc, NODE, {
    signal: controller.signal,
  });
  assert.equal(result.kind, K.UNAVAILABLE);
  if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.CANCELLED);
  assert.equal(calls, 0);
});
void test('read-only registry lookup times out even when the provider ignores abort', async () => {
  let calls = 0;
  const rpc = createSolanaRpcFromTransport(async () => {
    calls++;
    return new Promise<never>(() => {});
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await readRegistryIdentity(rpc, NODE, { timeoutMs: 10 });
    assert.equal(result.kind, K.UNAVAILABLE);
    if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.TIMEOUT);
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
void test('cancelled late genesis results cannot start later identity scans or return trust', async () => {
  let calls = 0;
  let finish = (_value: Base58EncodedBytes) => {};
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const base = createSolanaRpcFromTransport(async () => {
    calls++;
    return new Promise<never>(() => {});
  });
  const waiting = new Promise<Base58EncodedBytes>((resolve) => {
    finish = resolve;
  });
  const rpc = {
    getProgramAccounts: base.getProgramAccounts,
    getMultipleAccounts: base.getMultipleAccounts,
    getGenesisHash: () => ({
      send: async () => {
        calls++;
        entered();
        return await waiting;
      },
    }),
  };
  const controller = new AbortController();
  const pending = readRegistryIdentity(rpc, NODE, {
    signal: controller.signal,
  });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.kind, K.UNAVAILABLE);
  if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.CANCELLED);
  assert.ok(isBase58(DEVNET_GENESIS));
  finish(DEVNET_GENESIS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
void test('invalid registry deadlines fail before the RPC provider is called', async () => {
  let calls = 0;
  const rpc = createSolanaRpcFromTransport(async () => {
    calls++;
    return new Promise<never>(() => {});
  });
  for (const timeoutMs of [0, -1, NaN, Infinity, 30001]) {
    const result = await readRegistryIdentity(rpc, NODE, { timeoutMs });
    assert.equal(result.kind, K.UNAVAILABLE);
    if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.INVALID);
  }
  assert.equal(calls, 0);
});

void test('elapsed registry deadline rejects a synchronous late genesis before account scans', async () => {
  const genesis = DEVNET_GENESIS;
  assert.ok(isBase58(genesis));
  let scans = 0;
  const base = createSolanaRpcFromTransport(
    async () => new Promise<never>(() => {}),
  );
  const rpc = {
    getGenesisHash: () => ({
      send: async () => {
        const end = performance.now() + 40;
        while (performance.now() < end) {
          /* Synthetic provider blocks timer dispatch. */
        }
        return genesis;
      },
    }),
    getProgramAccounts: () => ({
      send: async () => {
        scans++;
        return [];
      },
    }),
    getMultipleAccounts: base.getMultipleAccounts,
  };
  const result = await readRegistryIdentity(rpc, NODE, { timeoutMs: 1 });
  assert.equal(result.kind, K.UNAVAILABLE);
  if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.TIMEOUT);
  assert.equal(scans, 0);
});
