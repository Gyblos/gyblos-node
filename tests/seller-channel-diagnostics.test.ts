// A seller's failed channel operation leaves one content-free local diagnostic: the operation and a
// stable code, never the error text (which can hold transactions, addresses or RPC URLs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SELLER_CHANNEL_DIAGNOSTICS } from '@gyblos/node/constants';
import { startSellerSessions } from '@gyblos/node/seller-sessions';
import { OPENING_RELEASE_FAILED } from '@gyblos/payments-upto/batch-session';
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

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

void test('a failed channel opening is recorded with its operation and stable code, without its message', async (t) => {
  const rig = await sessionRig({ depositAtomic: '10000' });
  t.after(rig.dispose);
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const session = rig.seller();
  // The fake backend hands out this one session; a real one creates a new session on every rebinding, so
  // the host's dispose of a released (preparing) binding is a no-op here.
  t.mock.method(session, 'dispose', async () => {});
  const records: DiagnosticRecord[] = [];
  let allowed = false;
  let created = false;
  const { service, close } = await startSellerSessions({
    buyerNodeId: rig.terms.buyerNodeId,
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    description: rig.terms,
    backend: {
      inspect: async () => undefined,
      create: async () => {
        if (!created) throw new PaymentSessionError(SESSION_CODES.UNAVAILABLE);
        return session;
      },
      renew: async () => {
        throw new PaymentSessionError(SESSION_CODES.UNVERIFIED);
      },
    },
    admit: async () => {
      if (!allowed) throw new PaymentSessionError(SESSION_CODES.LIMIT);
    },
    offers: () => [offers.live],
    now: rig.now,
    diagnostics: (record) => records.push(record),
  });
  t.after(close);
  const quote = await offers.quote(1);
  const call = (
    method: typeof BATCH_METHODS.OPEN | typeof BATCH_METHODS.PREPARE,
    terms = rig.terms,
    peer = rig.terms.buyerNodeId,
  ) =>
    service.exchange(
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '12'.repeat(16),
        method,
        params:
          method === BATCH_METHODS.OPEN
            ? { quote, terms, payload: '{}' }
            : { quote, terms },
      }),
      peer,
      new AbortController().signal,
    );
  const open = () => call(BATCH_METHODS.OPEN);
  await assert.rejects(call(BATCH_METHODS.PREPARE), {
    code: SESSION_CODES.LIMIT,
  });
  allowed = true;
  await assert.rejects(open(), { code: SESSION_CODES.UNAVAILABLE });
  assert.deepEqual(
    records.map((record) => [record.operation, record.code]),
    [
      [BATCH_METHODS.PREPARE, SESSION_CODES.LIMIT],
      [BATCH_METHODS.OPEN, SESSION_CODES.UNAVAILABLE],
    ],
  );
  records.length = 0;
  created = true;
  // The SDK's own failure, as the seller session's serial queue rethrows it: a generic session code with
  // the SDK error as its cause. The SDK error is a fixed name, then text that must never reach the log.
  const sdk = new Error(
    'invalid_batch_settlement_svm_settlement_simulation: rpc https://rpc.example/?key=secret AgAAAA',
  );
  t.mock.method(session, 'open', async () => {
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
  t.mock.method(session, 'open', async () => {
    throw new PaymentSessionError(SESSION_CODES.BINDING);
  });
  await assert.rejects(open());
  assert.equal(records[1]!.code, SESSION_CODES.BINDING);
  assert.equal(records[1]!.level, 'warn');
  t.mock.method(session, 'open', async () => {
    throw Object.assign(new Error('PLANTED_BY_PEER'), {
      code: 'PLANTED_BY_PEER',
    });
  });
  await assert.rejects(open());
  assert.equal(records[2]!.code, SELLER_CHANNEL_DIAGNOSTICS.unknownCode);
  // A wrong peer is refused before the operation and leaves no record.
  await assert.rejects(call(BATCH_METHODS.OPEN, rig.terms, '56'.repeat(32)), {
    code: PAID_EXECUTION_CODES.PEER,
  });
  await Promise.all([
    call(BATCH_METHODS.PREPARE),
    assert.rejects(open(), { code: SESSION_CODES.BUSY }),
  ]);
  assert.equal(records.length, 3);
  await assert.rejects(
    call(BATCH_METHODS.OPEN, {
      ...rig.terms,
      expiresAt: rig.terms.expiresAt + 1,
    }),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(records.length, 4);
  assert.equal(records[3]!.code, SESSION_CODES.UNVERIFIED);
  // An opening failure whose release could not be written is recorded twice: the failure, then the
  // release, so the operator learns why the channel stayed blocked.
  t.mock.method(session, 'open', async () => {
    const failure = new PaymentSessionError(SESSION_CODES.UNAVAILABLE);
    Object.defineProperty(failure, OPENING_RELEASE_FAILED, { value: true });
    throw failure;
  });
  await assert.rejects(open(), { code: SESSION_CODES.UNAVAILABLE });
  assert.deepEqual(
    records.slice(4).map((record) => [record.operation, record.code]),
    [
      [BATCH_METHODS.OPEN, SESSION_CODES.UNAVAILABLE],
      [BATCH_METHODS.OPEN, SELLER_CHANNEL_DIAGNOSTICS.releaseFailedCode],
    ],
  );
});
