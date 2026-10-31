// The finalized history of a channel address: successful transactions only, oldest first, read at
// finalized commitment within a bound, and an unreachable RPC reported without its URL. RPC double.
import assert from 'node:assert/strict';
import test from 'node:test';

import { signature as asSignature, getBase58Decoder } from '@solana/kit';
import {
  createUptoChannelHistory,
  UPTO_ERROR_CODES,
  UPTO_HISTORY_LIMIT,
  UptoError,
} from 'x402-upto-metered';

const CHANNEL = 'Chan111111111111111111111111111111111111111';
const signature = (fill: number) =>
  getBase58Decoder().decode(new Uint8Array(64).fill(fill));

void test('history lists the successful transactions oldest first, read finalized and bounded', async () => {
  const configs: unknown[] = [];
  const history = createUptoChannelHistory({
    getSignaturesForAddress: (_account, config) => ({
      send: async () => {
        configs.push(config);
        // Newest first, as the RPC lists them.
        return [
          { signature: asSignature(signature(3)), err: null },
          { signature: asSignature(signature(2)), err: { failed: true } },
          { signature: asSignature(signature(1)), err: null },
        ];
      },
    }),
  });
  assert.deepEqual(await history.signatures(CHANNEL), [
    signature(1),
    signature(3),
  ]);
  assert.deepEqual(configs, [
    { commitment: 'finalized', limit: UPTO_HISTORY_LIMIT },
  ]);
});

void test('an unreachable RPC is unavailable', async () => {
  const history = createUptoChannelHistory({
    getSignaturesForAddress: () => ({
      send: async () => {
        throw new Error('down at https://rpc.example/?api-key=secret');
      },
    }),
  });
  await assert.rejects(
    history.signatures(CHANNEL),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
      !error.message.includes('api-key'),
  );
});
