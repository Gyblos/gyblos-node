// A multi-seller pool cannot rotate a child behind its durable catalog's shared spending authority.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
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
        backend: async (id) => ({
          ...(await pool.backend(id)),
          renew: async () => {
            renewals++;
            return sessionFail(SESSION_CODES.UNAVAILABLE);
          },
        }),
      };
    },
  });
  t.after(host.close);
  const offers = fixture.offers[0]!;
  const signal = new AbortController().signal;
  await host.execute(await offers.quote(1), offers.input, signal);
  await assert.rejects(
    host.execute(
      await offers.quote(2, { maxAtomic: '980' }),
      offers.input,
      signal,
    ),
    { code: SESSION_CODES.LIMIT },
  );
  assert.equal(renewals, 0);
  assert.equal(offers.generations(), 1);
  assert.deepEqual(fixture.a.calls, ['deposit']);
});
