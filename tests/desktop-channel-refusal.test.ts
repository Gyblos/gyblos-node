// A seller that refuses channel preparation cannot strand the desktop's request reservation.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { DEVNET } from '@gyblos/config';
import { batchSessionPathsIn } from '@gyblos/config/home';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import {
  createBatchBuyer,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import {
  BATCH_METHODS,
  BatchChannelError,
  batchFail,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { batchLoopback } from './support/batch-loopback';
import { multisellerLoopback } from './support/multiseller-session';

void test('desktop releases the reservation on an incompatible seller preparation refusal before opening', async (t) => {
  const fixture = await multisellerLoopback('1000');
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
  let buyer = createBuyerSessionPool({
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
      assert.fail('incompatible seller executed a chat');
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
    assert.deepEqual(await fixture.options.inspect(), []);
    await buyer.close();
    buyer = createBuyerSessionPool(fixture.options);
    const compatible = fixture.offers[1]!;
    const next = await buyer.execute(
      await compatible.quote(2),
      compatible.input,
      AbortSignal.timeout(3000),
    );
    assert.ok(BigInt(next.approval.approvedAtomic) > 0n);
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

void test('a single-channel buyer can select a compatible seller after a preparation refusal', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(() => fixture.close());
  const refused = await batchLoopback(
    {
      async exchange() {
        return batchFail(PAID_EXECUTION_CODES.PEER);
      },
    },
    fixture.a.terms,
  );
  t.after(() => refused.close());
  const paths = batchSessionPathsIn(
    { GYBLOS_HOME: join(fixture.a.root, 'single') },
    'buyer',
  );
  const inspect = () => inspectBatchSession(paths);
  const buyer = createBuyerSessionManager({
    ...fixture.options,
    inspect,
    endpoint: {
      ...fixture.options.endpoint,
      connect: (destination, alpn) =>
        destination.id().toString() === fixture.a.terms.sellerNodeId
          ? refused.endpoint.connect(destination, alpn)
          : fixture.options.endpoint.connect(destination, alpn),
    },
    backend: async () => ({
      inspect,
      create: (terms) =>
        createBatchBuyer({ ...fixture.a.buyerOptions, terms, paths }),
      observe: fixture.b.sellerOptions.observe,
    }),
  });
  try {
    const [a, b] = fixture.offers;
    await assert.rejects(
      buyer.execute(await a!.quote(1), a!.input, AbortSignal.timeout(3000)),
      (error: unknown) => classifyPaidError(error)?.neverSent === true,
    );
    assert.equal(await inspect(), undefined);
    const result = await buyer.execute(
      await b!.quote(2),
      b!.input,
      AbortSignal.timeout(3000),
    );
    assert.ok(BigInt(result.approval.approvedAtomic) > 0n);
  } finally {
    await buyer.close();
  }
});
