import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('a reviewed uncertain attempt is archived and only prior confirmed usage is settled', async () => {
  const f = fixture();
  const operations: string[] = [];
  let archived: unknown;
  const session = await createPaypalSession({
    ...f,
    payment: {
      ...f.payment,
      async beginReview(orderId, requestId, authorizationId) {
        operations.push('verify');
        assert.equal(orderId, 'ORDER1');
        assert.ok(requestId);
        assert.equal(authorizationId, 'AUTH1');
        return {
          async capture(cents) {
            operations.push('capture');
            return f.payment.capture(authorizationId, cents);
          },
          release() {},
        };
      },
    },
    journal: {
      ...f.journal,
      claimSession() {
        return {
          ...f.journal,
          async review(action) {
            await action({
              async archiveWaiver(value) {
                operations.push('archive');
                archived = structuredClone(value);
                return 'a'.repeat(64);
              },
              async archiveOutcome() {
                operations.push('archive-outcome');
              },
              async write(value) {
                if (value.phase === PAYPAL_SESSION_PHASE.CAPTURING)
                  operations.push('save-capturing');
                await f.journal.write(value);
              },
            });
          },
        };
      },
    },
    agentEngine: {
      model: 'synthetic-model',
      async generate() {
        throw new Error('synthetic uncertain inference');
      },
    },
  });
  const order = await session.create();
  await session.approve(order.orderId);
  for (const id of ['MESSAGE1', 'MESSAGE2']) {
    await session.message(order.orderId, 'synthetic', 16, id);
    await session.acknowledge(order.orderId, id);
  }
  await assert.rejects(
    session.agentMessage(
      order.orderId,
      {
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 16,
      },
      'AGENT1',
    ),
  );
  assert.equal(session.status().phase, PAYPAL_SESSION_PHASE.EXECUTING);
  assert.equal(session.status().spentCents, 20);
  const decidedAt = Date.now() - 1000;
  await session.settleReviewedInference(
    order.orderId,
    20,
    session.reviewTicket().fingerprint,
    decidedAt,
  );
  assert.deepEqual(operations, [
    'verify',
    'archive',
    'save-capturing',
    'capture',
    'archive-outcome',
  ]);
  assert.equal(session.status().phase, PAYPAL_SESSION_PHASE.COMPLETED);
  assert.equal(session.status().spentCents, 20);
  assert.equal(f.calls.at(-1), 'capture:20');
  assert.ok(archived && typeof archived === 'object' && 'session' in archived);
  assert.ok('decidedAt' in archived);
  assert.equal(archived.decidedAt, decidedAt);
  assert.ok(
    'verifiedAt' in archived && typeof archived.verifiedAt === 'number',
  );
  assert.ok(archived.verifiedAt >= decidedAt);
  assert.ok(archived.session && typeof archived.session === 'object');
  assert.ok('phase' in archived.session);
  assert.equal(archived.session.phase, PAYPAL_SESSION_PHASE.EXECUTING);
  assert.ok('messageId' in archived.session);
  assert.equal(archived.session.messageId, 'AGENT1');
  assert.ok('promptDigest' in archived.session);
});
