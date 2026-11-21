// A seller's failed channel operation leaves one content-free local diagnostic: the operation and a
// stable code, never the error text (which can hold transactions, addresses or RPC URLs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { SELLER_CHANNEL_DIAGNOSTICS } from '@gyblos/node/constants';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
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
  // The SDK's own failure, as the seller session's serial queue rethrows it: a generic session code with
  // the SDK error as its cause. The SDK error is a fixed name, then text that must never reach the log.
  const sdk = new Error(
    'invalid_batch_settlement_svm_settlement_simulation: rpc https://rpc.example/?key=secret AgAAAA',
  );
  t.mock.method(f.session, 'open', async () => {
    throw new PaymentSessionError(SESSION_CODES.UNAVAILABLE, { cause: sdk });
  });
  await assert.rejects(open(), { code: SESSION_CODES.UNAVAILABLE });
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      component: records[0]!.component,
      operation: records[0]!.operation,
      code: records[0]!.code,
      level: records[0]!.level,
      outcome: records[0]!.outcome,
    },
    {
      component: 'seller-channel',
      operation: BATCH_METHODS.OPEN,
      code: 'invalid_batch_settlement_svm_settlement_simulation',
      level: 'error',
      outcome: 'failure',
    },
  );
  assert.doesNotMatch(JSON.stringify(records), /secret|rpc\.example|AgAAAA/);
  // A refusal a buyer can cause keeps its catalog code at warn; a typed code outside the catalogs and an
  // untyped error are recorded as unknown, never from their text.
  t.mock.method(f.session, 'open', async () => {
    throw new PaymentSessionError(SESSION_CODES.BINDING);
  });
  await assert.rejects(open());
  assert.equal(records[1]!.code, SESSION_CODES.BINDING);
  assert.equal(records[1]!.level, 'warn');
  t.mock.method(f.session, 'open', async () => {
    throw Object.assign(new Error('PLANTED_BY_PEER'), {
      code: 'PLANTED_BY_PEER',
    });
  });
  await assert.rejects(open());
  assert.equal(records[2]!.code, SELLER_CHANNEL_DIAGNOSTICS.unknownCode);
  // A wrong peer is refused before the operation and leaves no record.
  await assert.rejects(
    service.exchange(
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.OPEN,
        params: { quote, terms: f.rig.terms, payload: '{}' },
      }),
      '56'.repeat(32),
      new AbortController().signal,
    ),
    { code: PAID_EXECUTION_CODES.PEER },
  );
  assert.equal(records.length, 3);
});
