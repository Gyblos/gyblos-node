// A slow public artifact download cannot turn a stale quote into an uncertain payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPaidError } from '@gyblos/buyer/session-errors';
import {
  createSessionPreflight,
  prepareChosenMeter,
} from '@gyblos/buyer/session-requirements';
import { sessionTerms } from '@gyblos/node/session-policy';
import { verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

void test('a quote that expires before channel preflight finishes is certainly unsent', async (t) => {
  const rig = await sessionRig();
  t.after(() => rig.dispose());
  const fixture = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const quote = await fixture.quote(1);
  const now = quote.offer.expiresAt;
  const policy = {
    depositAtomic: quote.offer.maxAtomic,
    lifetimeMs: 3600000,
    withdrawDelaySeconds: 900,
  };
  const terms = sessionTerms(quote, policy, now);
  const verify = () =>
    verifyBatchQuote(quote, terms, quote.offer.buyerNodeId, now);
  await assert.rejects(
    verify(),
    (error: unknown) => classifyPaidError(error)?.neverSent === false,
  );
  let clock = quote.offer.issuedAt;
  t.mock.method(Date, 'now', () => clock);
  const wait = batchDeferred<void>();
  const preflight = createSessionPreflight(
    async () => {
      await wait.promise;
      return fixture.meter;
    },
    policy,
    () => quote.offer.buyerNodeId,
  );
  const pending = preflight(quote, fixture.input, new AbortController().signal);
  clock = quote.offer.expiresAt;
  wait.resolve();
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(classifyPaidError(error)?.code, PAID_EXECUTION_CODES.EXPIRED);
    assert.equal(classifyPaidError(error)?.neverSent, true);
    return true;
  });
});

void test('a slow desktop download precedes quoting and an expired listing is refused before selection', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const meter = { count: () => 1, chat: () => 1, input: () => 1 };
  for (const expiresAt of [now + 1000, now + 100000]) {
    now = 1000;
    const barrier = batchDeferred<void>();
    const quotes: number[] = [];
    const selected = prepareChosenMeter(
      expiresAt,
      async () => {
        await barrier.promise;
        return meter;
      },
      new AbortController().signal,
    ).then(() => quotes.push(Date.now()));
    now += 35000;
    assert.deepEqual(quotes, []);
    barrier.resolve();
    if (expiresAt <= now) {
      await assert.rejects(
        selected,
        (error: unknown) =>
          classifyPaidError(error)?.code === SESSION_CODES.BINDING &&
          classifyPaidError(error)?.neverSent === true,
      );
      assert.deepEqual(quotes, []);
    } else {
      await selected;
      assert.deepEqual(quotes, [now]);
    }
  }
});
