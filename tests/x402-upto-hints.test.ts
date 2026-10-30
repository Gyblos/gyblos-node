// The buyer's chain hints for signing a channel open: blockhash, its last valid height and the slot, read
// only after the RPC proved it serves the terms' network. RPC double; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUptoHintReader,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoHintRpc,
} from 'x402-upto-metered';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function rpc(genesis: string, fail = false) {
  const calls: string[] = [];
  const answer = <T>(name: string, value: T) => ({
    send: async () => {
      calls.push(name);
      if (fail)
        throw new Error('rpc down at https://rpc.example/?api-key=secret');
      return value;
    },
  });
  const double: UptoHintRpc = {
    getGenesisHash: () => answer('genesis', genesis),
    getLatestBlockhash: () =>
      answer('blockhash', {
        value: { blockhash: 'Blockhash1111', lastValidBlockHeight: 42n },
      }),
    getSlot: () => answer('slot', 7n),
  };
  return { double, calls };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof UptoError && error.code === expected;

void test('hints come from the RPC once its genesis matches the network', async () => {
  const { double, calls } = rpc(GENESIS);
  const reader = createUptoHintReader(double, NETWORK);
  const expected = {
    recentBlockhash: 'Blockhash1111',
    lastValidBlockHeight: '42',
    recentSlot: '7',
  };
  assert.deepEqual(await reader.hints(), expected);
  assert.deepEqual(await reader.hints(), expected);
  // The network is proven once; blockhash and slot are fresh on every call.
  assert.deepEqual(calls, [
    'genesis',
    'blockhash',
    'slot',
    'blockhash',
    'slot',
  ]);
});

void test('another network is refused before any hint is read', async () => {
  const { double, calls } = rpc('MainnetGenesis1111111111111111111111111111');
  await assert.rejects(
    createUptoHintReader(double, NETWORK).hints(),
    code(UPTO_ERROR_CODES.INVALID_TERMS),
  );
  assert.deepEqual(calls, ['genesis']);
});

void test('an unreachable RPC is unavailable and never echoes its URL', async () => {
  const { double } = rpc(GENESIS, true);
  await assert.rejects(
    createUptoHintReader(double, NETWORK).hints(),
    (error) =>
      code(UPTO_ERROR_CODES.UNAVAILABLE)(error) &&
      error instanceof Error &&
      !error.message.includes('api-key'),
  );
});

void test('only a solana network with a full 32-character reference can match', async () => {
  const networks: `${string}:${string}`[] = [
    'eip155:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    'solana:E',
    'solana:',
  ];
  for (const network of networks) {
    const { double, calls } = rpc(GENESIS);
    await assert.rejects(
      createUptoHintReader(double, network).hints(),
      code(UPTO_ERROR_CODES.INVALID_TERMS),
      network,
    );
    assert.deepEqual(calls, ['genesis']);
  }
});

void test('a failed proof is retried on the next call', async () => {
  let down = true;
  const { double, calls } = rpc(GENESIS);
  const reader = createUptoHintReader(
    {
      ...double,
      getGenesisHash: () => ({
        send: async () => {
          calls.push('genesis');
          if (down) throw new Error('rpc down');
          return GENESIS;
        },
      }),
    },
    NETWORK,
  );
  await assert.rejects(reader.hints(), code(UPTO_ERROR_CODES.UNAVAILABLE));
  down = false;
  await reader.hints();
  assert.deepEqual(calls, ['genesis', 'genesis', 'blockhash', 'slot']);
});
