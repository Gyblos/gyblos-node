import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import {
  createPaypalSession,
  type PaypalReviewJournal,
} from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('review failures preserve the session and never repeat a capture', async () => {
  for (const failure of [
    'verify',
    'archive',
    'capturing',
    'capture',
    'outcome',
    'completed',
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'paypal-review-failure-'));
    try {
      const realJournal = await openPaypalJournal(root);
      const f = fixture();
      let captures = 0;
      let verifies = 0;
      let releases = 0;
      const payment = {
        ...f.payment,
        async beginReview() {
          verifies += 1;
          if (failure === 'verify') throw new Error('synthetic verify failure');
          return {
            async capture(cents: number) {
              assert.equal(cents, 20);
              captures += 1;
              if (failure === 'capture')
                throw new Error('synthetic lost capture result');
              return { captureId: 'CAPTURE1' };
            },
            release() {
              releases += 1;
            },
          };
        },
      };
      const wrappedJournal = {
        ...realJournal,
        claimSession() {
          const owned = realJournal.claimSession();
          return {
            ...owned,
            async review(
              action: (scope: PaypalReviewJournal) => Promise<void>,
            ) {
              await owned.review(async (scope) => {
                await action({
                  async archiveWaiver(value) {
                    if (failure === 'archive')
                      throw new Error('synthetic archive failure');
                    return scope.archiveWaiver(value);
                  },
                  async archiveOutcome(value) {
                    if (failure === 'outcome')
                      throw new Error('synthetic outcome failure');
                    await scope.archiveOutcome(value);
                  },
                  async write(value) {
                    if (failure === value.phase)
                      throw new Error('synthetic journal failure');
                    await scope.write(value);
                  },
                });
              });
            },
          };
        },
      };
      const session = await createPaypalSession({
        ...f,
        payment,
        journal: wrappedJournal,
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
      const ticket = session.reviewTicket();
      await assert.rejects(
        session.settleReviewedInference(
          order.orderId,
          21,
          ticket.fingerprint,
          Date.now(),
        ),
      );
      await assert.rejects(
        session.settleReviewedInference(
          order.orderId,
          20,
          'wrong-ticket',
          Date.now(),
        ),
      );
      assert.equal(verifies, 0);
      await assert.rejects(
        session.settleReviewedInference(
          order.orderId,
          20,
          ticket.fingerprint,
          Date.now(),
        ),
      );
      assert.equal(verifies, 1);
      assert.equal(
        captures,
        ['capture', 'outcome', 'completed'].includes(failure) ? 1 : 0,
      );
      assert.equal(releases, failure === 'verify' ? 0 : 1);
      await assert.rejects(session.finish(order.orderId));
      await realJournal.close();
      const reopened = await openPaypalJournal(root);
      const restarted = await createPaypalSession({
        ...f,
        payment,
        journal: reopened,
      });
      await assert.rejects(restarted.finish(order.orderId));
      await assert.rejects(restarted.create());
      if (['capturing', 'capture', 'outcome', 'completed'].includes(failure)) {
        assert.equal(restarted.status().phase, 'blocked');
        assert.throws(() => restarted.reviewTicket());
        if (restarted.status().phase === PAYPAL_SESSION_PHASE.EXECUTING) {
          const retryTicket = restarted.reviewTicket();
          await assert.rejects(
            restarted.settleReviewedInference(
              order.orderId,
              20,
              retryTicket.fingerprint,
              Date.now(),
            ),
          );
        }
        assert.equal(verifies, 1);
        assert.equal(
          captures,
          ['capture', 'outcome', 'completed'].includes(failure) ? 1 : 0,
        );
      }
      await reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
