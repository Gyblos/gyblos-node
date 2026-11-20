// A seller that refuses channel preparation cannot strand the desktop's request reservation.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { DEVNET } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import {
  BATCH_METHODS,
  BatchChannelError,
  batchFail,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { batchLoopback } from './support/batch-loopback';
import { multisellerSession } from './support/multiseller-session';

void test('desktop releases the reservation on an incompatible seller preparation refusal before opening', async (t) => {
  const fixture = await multisellerSession();
  t.after(() => fixture.close());
  const methods: string[] = [];
  const wire = await batchLoopback(
    {
      async exchange(request) {
        methods.push(request.method);
        return batchFail(PAID_EXECUTION_CODES.PEER);
      },
    },
    fixture.a.terms,
  );
  t.after(() => wire.close());
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    endpoint: wire.endpoint,
    destination: () => wire.destination,
  });
  const offer = fixture.offers[0]!;
  const quote = await offer.quote(1);
  const token = 'synthetic-loopback-bearer-token';
  const host = await startFreeBuyerHttp(
    async () => {
      await buyer.execute(quote, offer.input, AbortSignal.timeout(3000));
      return undefined;
    },
    {
      selection: quote.offer.selection,
      maxTokens: 10,
    },
    {
      port: 0,
      token,
      classify: classifyPaidError,
      desktopPolicy: {
        network: DEVNET,
        mint: fixture.a.terms.mint,
        payer: fixture.a.terms.buyer,
        maxAtomic: '200',
      },
    },
  );
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
  });
  const client = new X402Client(budget);
  try {
    await client.connect(host.url, token);
    await client.authorize('200');
    await assert.rejects(
      client.send('incompatible-channel', 'Synthetic question'),
      /Choose another seller/,
    );
    assert.deepEqual(methods, [BATCH_METHODS.PREPARE]);
    assert.deepEqual(fixture.a.calls, []);
    assert.equal((await budget.summary()).blocked, false);
    assert.equal((await budget.summary()).spentAtomic, '0');
    assert.equal(await buyer.unresolved(), false);
    assert.equal(
      classifyPaidError(new BatchChannelError(PAID_EXECUTION_CODES.PEER, true))
        ?.neverSent,
      false,
    );
  } finally {
    await client.close();
    await host.close();
    await buyer.close();
  }
});
