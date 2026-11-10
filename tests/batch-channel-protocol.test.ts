// Exercises the reusable wire through public entries; no engines, wallets or payment sends.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchChannelDigest,
  matchBatchChannelResponse,
  parseBatchChannelRequest,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

const request: BatchChannelRequest = {
  version: BATCH_CHANNEL.version,
  requestId: '12'.repeat(16),
  method: BATCH_METHODS.SNAPSHOT,
  params: { channelId: '11111111111111111111111111111111' },
};
void test('batch RPC accepts a canonical snapshot request without changing any fields', () => {
  assert.equal(
    canonicalJson(parseBatchChannelRequest(request)),
    canonicalJson(request),
  );
});
void test('batch RPC binds responses to the full validated request', async () => {
  const digest = await batchChannelDigest(request);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const result = {
    snapshot: {
      channelId: request.params.channelId,
      state: SESSION_STATES.OPEN,
      expiresAt: 1800000000000,
      cumulativeAtomic: '0',
      reservedAtomic: '0',
    },
  };
  const reply = await matchBatchChannelResponse(
    {
      version: BATCH_CHANNEL.version,
      requestId: request.requestId,
      requestDigest: digest,
      result,
    },
    request,
  );
  assert.deepEqual(reply.result, result);
  await assert.rejects(
    matchBatchChannelResponse(
      { ...reply, requestId: '34'.repeat(16) },
      request,
    ),
    { code: SESSION_CODES.BINDING },
  );
});
void test('batch RPC rejects unknown fields and unsupported methods with static codes', () => {
  assert.throws(
    () => parseBatchChannelRequest({ ...request, prompt: 'synthetic' }),
    { code: SESSION_CODES.INVALID },
  );
  assert.throws(
    () => parseBatchChannelRequest({ ...request, method: 'invalid' }),
    { code: SESSION_CODES.INVALID },
  );
});
