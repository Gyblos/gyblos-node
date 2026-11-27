// Real pooled-session busy proof, synthetic transport and private temporary financial state only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeApiKeySession,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { BUYER_KEY_CHARGE } from '@gyblos/protocol/buyer-api-keys';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { multisellerLoopback } from './support/multiseller-session';

void test('a delegated key releases a proven-unsent pooled busy reservation before rerouting', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: fixture.a.terms.network,
      mint: fixture.a.terms.mint,
      payer: fixture.a.terms.buyer,
    },
  });
  t.after(async () => {
    await buyer.close();
    await keys.close();
    await fixture.close();
  });
  const key = await keys.create('Synthetic tools', '1000');
  const operation = keys.operation(key.id);
  const quoteA = await fixture.offers[0]!.quote(1);
  await reserveApiKey(operation, quoteA);
  fixture.offers[0]!.busy(true);
  await assert.rejects(
    executeApiKeySession(operation, quoteA.offer.nodeId, () =>
      buyer.execute(
        quoteA,
        fixture.offers[0]!.input,
        AbortSignal.timeout(3000),
      ),
    ),
    { name: 'UnsentSellerBusyError' },
  );
  assert.equal(await buyer.unresolved(), false);
  assert.deepEqual(fixture.a.calls, []);
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
  const quoteB = await fixture.offers[1]!.quote(2);
  await reserveApiKey(operation, quoteB);
  const completed = await executeApiKeySession(
    operation,
    quoteB.offer.nodeId,
    () =>
      buyer.execute(
        quoteB,
        fixture.offers[1]!.input,
        AbortSignal.timeout(3000),
      ),
  );
  await operation.complete(
    completed.approval.approvedAtomic,
    BUYER_KEY_CHARGE.APPROVED,
  );
  assert.equal((await keys.snapshot()).blocked, false);
  assert.equal(
    (await keys.snapshot()).keys[0]?.spentAtomic,
    completed.approval.approvedAtomic,
  );
});
void test('a rejected new deposit releases only the unsent delegated request', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool({
    ...fixture.options,
    policy: { ...fixture.options.policy, depositAtomic: '9999' },
  });
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: fixture.a.terms.network,
      mint: fixture.a.terms.mint,
      payer: fixture.a.terms.buyer,
    },
  });
  t.after(async () => {
    await buyer.close();
    await keys.close();
    await fixture.close();
  });
  const key = await keys.create('Synthetic tools', '1000');
  const quote = await fixture.offers[0]!.quote(1);
  const operation = keys.operation(key.id);
  await reserveApiKey(operation, quote);
  await assert.rejects(
    executeApiKeySession(operation, quote.offer.nodeId, () =>
      buyer.execute(quote, fixture.offers[0]!.input, AbortSignal.timeout(3000)),
    ),
    (error) => {
      const response = classifyPaidError(error);
      return (
        response?.code === SESSION_CODES.LIMIT && response.neverSent === true
      );
    },
  );
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
  assert.equal(fixture.prepared(), 0);
  const next = keys.operation(key.id);
  await reserveApiKey(next, await fixture.offers[1]!.quote(2));
  await next.releaseUnsent();
});
void test('a full pool releases the rejected seller reservation and the funded seller stays usable', async (t) => {
  const fixture = await multisellerLoopback('10000');
  const buyer = createBuyerSessionPool(fixture.options);
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: fixture.a.terms.network,
      mint: fixture.a.terms.mint,
      payer: fixture.a.terms.buyer,
    },
  });
  t.after(async () => {
    await buyer.close();
    await keys.close();
    await fixture.close();
  });
  const key = await keys.create('Synthetic agent', '1000');
  const funded = fixture.offers[0]!;
  const rejected = fixture.offers[1]!;
  const signal = new AbortController().signal;
  await buyer.execute(await funded.quote(1), funded.input, signal);
  const quote = await rejected.quote(2);
  const operation = keys.operation(key.id);
  await reserveApiKey(operation, quote);
  await assert.rejects(
    executeApiKeySession(operation, quote.offer.nodeId, () =>
      buyer.execute(quote, rejected.input, signal),
    ),
    { code: SESSION_CODES.LIMIT },
  );
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
  assert.equal(fixture.prepared(), 1);
  assert.deepEqual(fixture.b.calls, []);
  const next = await funded.quote(3);
  await reserveApiKey(operation, next);
  const completed = await executeApiKeySession(
    operation,
    next.offer.nodeId,
    () => buyer.execute(next, funded.input, signal),
  );
  await operation.complete(
    completed.approval.approvedAtomic,
    BUYER_KEY_CHARGE.APPROVED,
  );
  assert.equal((await keys.snapshot()).blocked, false);
});
void test('a generic busy-shaped failure cannot release a delegated paid reservation', async () => {
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: 'synthetic',
      mint: '1'.repeat(32),
      payer: '2'.repeat(32),
    },
  });
  try {
    const key = await keys.create('Synthetic tools', '100');
    const operation = keys.operation(key.id);
    await operation.reserve({
      maxAtomic: '100',
      requestId: 'synthetic',
      requestDigest: 'a'.repeat(64),
      sellerNodeId: 'b'.repeat(64),
    });
    const failure = Object.assign(new Error('synthetic unknown busy'), {
      name: 'UnsentSellerBusyError',
      nodeId: 'b'.repeat(64),
    });
    await assert.rejects(
      executeApiKeySession(operation, 'b'.repeat(64), async () => {
        throw failure;
      }),
    );
    operation.abandon();
    assert.equal((await keys.snapshot()).blocked, true);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '100');
  } finally {
    await keys.close();
  }
});

for (const condition of ['expired', 'closed', 'catalog capacity'] as const) {
  void test(`pooled channel rejection (${condition}) releases only the new API-key request`, async (t) => {
    const fixture = await multisellerLoopback('1000000');
    const host = createBuyerSessionPool(fixture.options);
    const keys = await createBuyerApiKeys({
      files: { read: async () => undefined, write: async () => {} },
      scope: {
        network: fixture.a.terms.network,
        mint: fixture.a.terms.mint,
        payer: fixture.a.terms.buyer,
      },
    });
    t.after(async () => {
      await host.close();
      await keys.close();
      await fixture.close();
    });
    const offers = fixture.offers[0]!;
    const signal = new AbortController().signal;
    if (condition === 'catalog capacity') {
      const pool = await fixture.options.pool();
      try {
        for (let i = 0; i < BATCH_SESSION_DEFAULTS.maxSessions; i++) {
          await pool.allocate({
            ...fixture.a.terms,
            sellerNodeId: i.toString(16).padStart(64, '0'),
          });
        }
        assert.ok(
          BigInt((await pool.budget()).availableAtomic) >=
            BigInt(fixture.a.terms.depositAtomic),
        );
      } finally {
        await pool.dispose();
      }
    } else {
      await host.execute(await offers.quote(1), offers.input, signal);
      if (condition === 'expired') fixture.a.time(fixture.a.terms.expiresAt);
      else {
        await fixture.a.seller().close();
        await host.reconcile(signal);
      }
    }
    const key = await keys.create('Synthetic caller', '1000');
    const operation = keys.operation(key.id);
    const quote = await offers.quote(2);
    await reserveApiKey(operation, quote);
    await assert.rejects(
      executeApiKeySession(operation, quote.offer.nodeId, () =>
        host.execute(quote, offers.input, signal),
      ),
      {
        code:
          condition === 'closed' ? SESSION_CODES.CLOSED : SESSION_CODES.LIMIT,
      },
    );
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
    assert.equal(
      offers.generations(),
      condition === 'catalog capacity' ? 0 : 1,
    );
  });
}

void test('cancellation during paid quote verification keeps the delegated allowance available', async (t) => {
  const fixture = await multisellerLoopback();
  t.after(() => fixture.close());
  const scope = {
    network: fixture.a.terms.network,
    mint: fixture.a.terms.mint,
    payer: fixture.a.terms.buyer,
  };
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope,
  });
  t.after(() => keys.close());
  const quote = await fixture.offers[0]!.quote(1);
  for (const pooled of [false, true]) {
    const key = await keys.create('Synthetic', '1000');
    const controller = new AbortController();
    const reason = new Error('synthetic verification cancellation');
    let cancelVerification = true;
    const verify = async () => {
      if (cancelVerification) {
        controller.abort(reason);
        throw reason;
      }
    };
    const op = keys.operation(key.id);
    const options = {
      ...fixture.options,
      verify,
      authorizeRequest: async (signed: typeof quote, signal: AbortSignal) => {
        await reserveApiKey(op, signed, signal);
        return op.releaseUnsent;
      },
    };
    const buyer = pooled
      ? createBuyerSessionPool(options)
      : createBuyerSessionManager({
          ...options,
          inspect: async () => undefined,
          backend: async () => assert.fail('unexpected financial preparation'),
        });
    t.after(() => buyer.close());
    try {
      await assert.rejects(
        executeApiKeySession(op, quote.offer.nodeId, () =>
          buyer.execute(quote, fixture.offers[0]!.input, controller.signal),
        ),
        (error) => error === reason,
      );
    } finally {
      op.abandon();
    }
    const snapshot = await keys.snapshot();
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(snapshot.blocked, false);
    assert.equal(fixture.prepared(), 0);
    assert.deepEqual(fixture.a.calls, []);
    cancelVerification = false;
    await keys.revoke(key.id);
    await assert.rejects(
      buyer.execute(
        quote,
        fixture.offers[0]!.input,
        new AbortController().signal,
      ),
      /BUYER_KEY_REVOKED/,
    );
    assert.equal(fixture.prepared(), 0);
  }
});
