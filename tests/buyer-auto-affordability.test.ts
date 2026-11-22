import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAffordableAutoQuote } from '@gyblos/buyer/quote-selection';
import { createSessionPreflight } from '@gyblos/buyer/session-requirements';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

void test('paid Auto excludes an unaffordable signed quote before sending and a free seller serves the original request once', async (t) => {
  const rig = await sessionRig();
  t.after(() => rig.dispose());
  const fixture = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const first = await fixture.quote(1, { maxAtomic: '50' });
  t.mock.method(Date, 'now', () => first.offer.issuedAt);
  const second = await fixture.quote(2, {
    nodeId: 'b'.repeat(64),
    maxAtomic: '0',
    prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  });
  const preflight = createSessionPreflight(
    async () => fixture.meter,
    {
      depositAtomic: '1000000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    () => first.offer.buyerNodeId,
  );
  const sent: string[] = [];
  const signal = new AbortController().signal;
  const attempts: string[][] = [];
  const ports = {
    enter: () => () => {},
    unresolved: async () => false,
    select: (excluded: ReadonlySet<string>) =>
      selectAffordableAutoQuote(
        excluded,
        signal,
        async (skip) => {
          attempts.push([...skip]);
          const quote = skip.has(first.offer.nodeId) ? second : first;
          return { nodeId: quote.offer.nodeId, quote };
        },
        async (quote) => {
          await preflight(quote, fixture.input, signal);
        },
      ),
    paid: async () => {
      throw new Error('a payment was attempted');
    },
    free: async () => {
      sent.push(second.offer.nodeId);
      return 'answer';
    },
  };
  assert.equal((await executeBuyerQuote(ports, signal)).result, 'answer');
  assert.deepEqual(attempts, [[], [first.offer.nodeId]]);
  assert.deepEqual(sent, [second.offer.nodeId]);
});

void test('Auto keeps an affordable paid alternative and never selects again after an ambiguous execution failure', async (t) => {
  const rig = await sessionRig();
  t.after(() => rig.dispose());
  const fixture = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const expensive = await fixture.quote(1, { maxAtomic: '50' });
  const cheap = await fixture.quote(2, {
    nodeId: 'c'.repeat(64),
    maxAtomic: '50',
    prices: { inputAtomicPerMtok: '1000000', outputAtomicPerMtok: '1000000' },
  });
  t.mock.method(Date, 'now', () => cheap.offer.issuedAt);
  const signal = new AbortController().signal;
  const preflight = createSessionPreflight(
    async () => fixture.meter,
    {
      depositAtomic: '1000000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    () => cheap.offer.buyerNodeId,
  );
  const quoted: string[] = [];
  const sent: string[] = [];
  const unknown = new Error('uncertain submission');
  await assert.rejects(
    executeBuyerQuote(
      {
        enter: () => () => {},
        unresolved: async () => false,
        select: (excluded) =>
          selectAffordableAutoQuote(
            excluded,
            signal,
            async (skip) => {
              const quote = skip.has(expensive.offer.nodeId)
                ? cheap
                : expensive;
              quoted.push(quote.offer.nodeId);
              return { nodeId: quote.offer.nodeId, quote };
            },
            async (quote) => {
              await preflight(quote, fixture.input, signal);
            },
          ),
        free: async () => {
          throw new Error('unexpected free selection');
        },
        paid: async (winner) => {
          sent.push(winner.nodeId);
          throw unknown;
        },
      },
      signal,
    ),
    (error) => error === unknown,
  );
  assert.deepEqual(quoted, [expensive.offer.nodeId, cheap.offer.nodeId]);
  assert.deepEqual(sent, [cheap.offer.nodeId]);
});
