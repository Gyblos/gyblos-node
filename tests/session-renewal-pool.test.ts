// A multi-seller pool cannot rotate a child behind its durable catalog's shared spending authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import {
  inspectBatchSession,
  type BatchBuyerBackend,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { multisellerLoopback } from './support/multiseller-session';

void test('pooled insufficient reserve does not close, renew or execute an unaccounted replacement', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(fixture.close);
  let renewals = 0;
  const host = createBuyerSessionPool({
    ...fixture.options,
    pool: async () => {
      const pool = await fixture.options.pool();
      return {
        ...pool,
        backend: async (id) => {
          const backend = await pool.backend(id);
          const original: BatchBuyerBackend = {
            ...backend,
            create(terms) {
              assert.equal(
                this,
                original,
                'the financial port keeps its receiver',
              );
              return backend.create(terms);
            },
            renew: async () => {
              renewals++;
              return sessionFail(SESSION_CODES.UNAVAILABLE);
            },
          };
          return original;
        },
      };
    },
  });
  t.after(host.close);
  const offers = fixture.offers[0]!;
  const signal = new AbortController().signal;
  await host.execute(await offers.quote(1), offers.input, signal);
  await assert.rejects(
    host.execute(
      await offers.quote(2, { maxAtomic: '9980' }),
      offers.input,
      signal,
    ),
    { code: SESSION_CODES.LIMIT },
  );
  assert.equal(renewals, 0);
  assert.equal(offers.generations(), 1);
  assert.deepEqual(fixture.a.calls, ['deposit']);
});

void test('a full renewal history leaves usable escrow open before replacement', async (t) => {
  const f = await multisellerLoopback();
  t.after(f.close);
  const inspect = async (): ReturnType<typeof inspectBatchSession> => {
    const stored = await inspectBatchSession(f.a.buyerOptions.paths);
    return stored && { ...stored, renewalLimitReached: true };
  };
  const host = createBuyerSessionManager({
    ...f.options,
    policy: {
      depositAtomic: '10000',
      renewalBudgetAtomic: '20000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    inspect,
    backend: async () => ({
      inspect,
      create: async () => f.a.buyer,
      observe: f.a.sellerOptions.observe,
      availableBalance: async () => '10000',
      renew: async () => assert.fail('should keep the original channel open'),
    }),
  });
  t.after(host.close);
  const offer = f.offers[0]!;
  const signal = new AbortController().signal;
  await host.execute(await offer.quote(1), offer.input, signal);
  await assert.rejects(
    host.execute(
      await offer.quote(2, { maxAtomic: '10000' }),
      offer.input,
      signal,
    ),
    { code: SESSION_CODES.LIMIT },
  );
  assert.deepEqual(f.a.calls, ['deposit']);
});
