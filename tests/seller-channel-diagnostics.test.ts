// A seller's failed channel operation leaves one content-free local diagnostic: the operation and a
// stable code, never the error text (which can hold transactions, addresses or RPC URLs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import type { DiagnosticRecord } from '@gyblos/runtime/diagnostics';

import { batchPrepareFixture } from './support/batch-prepare';

void test('a failed channel opening is recorded with its operation and stable code, without its message', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  const records: DiagnosticRecord[] = [];
  const service = createSellerBatchSession({
    session: f.session,
    terms: f.rig.terms,
    offers: () => [f.offers.live],
    now: f.rig.now,
    diagnostics: (record) => records.push(record),
  });
  const quote = await f.offers.quote(1);
  const open = () =>
    service.exchange(
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.OPEN,
        params: { quote, terms: f.rig.terms, payload: '{}' },
      }),
      f.rig.terms.buyerNodeId,
      new AbortController().signal,
    );
  // The SDK's own failure: a stable prefix, then text that must never reach the log.
  const sdk = new Error(
    'invalid_batch_settlement_svm_settlement_simulation: rpc https://rpc.example/?key=secret AgAAAA',
  );
  t.mock.method(f.session, 'open', async () => {
    throw sdk;
  });
  await assert.rejects(open(), (error) => error === sdk);
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      component: records[0]!.component,
      operation: records[0]!.operation,
      code: records[0]!.code,
      outcome: records[0]!.outcome,
    },
    {
      component: 'seller-channel',
      operation: BATCH_METHODS.OPEN,
      code: 'invalid_batch_settlement_svm_settlement_simulation',
      outcome: 'failure',
    },
  );
  assert.doesNotMatch(JSON.stringify(records), /secret|rpc\.example|AgAAAA/);
  // A session refusal keeps its own code; an unknown error is recorded without guessing.
  t.mock.method(f.session, 'open', async () => {
    const refused = new Error(SESSION_CODES.UNVERIFIED);
    Object.assign(refused, { code: SESSION_CODES.UNVERIFIED });
    throw refused;
  });
  await assert.rejects(open());
  assert.equal(records[1]!.code, SESSION_CODES.UNVERIFIED);
  t.mock.method(f.session, 'open', async () => {
    throw new Error('free text with no code');
  });
  await assert.rejects(open());
  assert.equal(records[2]!.code, 'SELLER_CHANNEL_FAILED');
});
