// Explicit session authority is separate from quote budgets; all data is public synthetic fixture data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { PROTOCOL_FEE } from '@gyblos/config';
import {
  parseBuyerSessionPolicy,
  sessionTerms,
} from '@gyblos/node/session-policy';
import {
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

async function quote() {
  const vector: { execution: { quote: SignedOfferV2 } } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-channel-v1.json'),
      ),
      'utf8',
    ),
  );
  return vector.execution.quote;
}
void test('session policy explicitly authorizes one capped deposit and a finite lifetime', () => {
  assert.deepEqual(
    parseBuyerSessionPolicy({ depositAtomic: '1000', lifetimeMs: 3600000 }),
    { depositAtomic: '1000', lifetimeMs: 3600000, withdrawDelaySeconds: 900 },
  );
});
void test('session policy rejects ambiguous amounts, excessive authority and unknown fields', () => {
  const valid = { depositAtomic: '1000', lifetimeMs: 3600000 };
  for (const value of [
    { ...valid, depositAtomic: '01000' },
    { ...valid, depositAtomic: '0' },
    { ...valid, depositAtomic: '1000001' },
    { ...valid, lifetimeMs: 0 },
    { ...valid, lifetimeMs: 86400001 },
    { ...valid, lifetimeMs: 0.5 },
    { ...valid, withdrawDelaySeconds: 899 },
    { ...valid, withdrawDelaySeconds: 3601 },
    { ...valid, unknown: true },
  ])
    assert.throws(() => parseBuyerSessionPolicy(value), {
      code: SESSION_CODES.INVALID,
    });
});
void test('session terms use explicit deposit/lifetime and canonical network fee, never quote expiry', async () => {
  const signed = await quote();
  const terms = sessionTerms(
    signed,
    { depositAtomic: '1000', lifetimeMs: 3600000, withdrawDelaySeconds: 900 },
    signed.offer.issuedAt,
  );
  assert.ok(terms);
  assert.equal(terms.depositAtomic, '1000');
  assert.equal(terms.expiresAt, signed.offer.issuedAt + 3600000);
  assert.equal(terms.protocolFeeBps, PROTOCOL_FEE.bps);
  assert.equal(terms.treasury, PROTOCOL_FEE.treasury);
  assert.equal(terms.buyerNodeId, signed.offer.buyerNodeId);
  assert.equal(terms.sellerNodeId, signed.offer.nodeId);
});
void test('prepare and open carry proposed full terms without changing existing message forms', async () => {
  const signed = await quote();
  const vector: { response: { result: { terms: unknown } } } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-prepare-v1.json'),
      ),
      'utf8',
    ),
  );
  const terms = vector.response.result.terms;
  for (const method of [BATCH_METHODS.PREPARE, BATCH_METHODS.OPEN]) {
    const original = {
      version: 1,
      requestId: '12'.repeat(16),
      method,
      params: {
        quote: signed,
        ...(method === BATCH_METHODS.OPEN ? { payload: 'synthetic' } : {}),
      },
    };
    assert.deepEqual(parseBatchChannelRequest(original), original);
    const proposed = { ...original, params: { ...original.params, terms } };
    assert.deepEqual(parseBatchChannelRequest(proposed), proposed);
  }
});

void test('session policy authorizes a separate total deposit ceiling without changing per-channel authority', () => {
  const policy = parseBuyerSessionPolicy({
    depositAtomic: '1000',
    totalDepositAtomic: '2000',
    lifetimeMs: 3600000,
  });
  assert.equal(policy.totalDepositAtomic, '2000');
  assert.equal(policy.depositAtomic, '1000');
  for (const totalDepositAtomic of ['0', '02000', '-1'])
    assert.throws(
      () => parseBuyerSessionPolicy({ ...policy, totalDepositAtomic }),
      { code: SESSION_CODES.INVALID },
    );
});
