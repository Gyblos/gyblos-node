// Payment reference metadata stays read-only and separate from identifier-free usage history.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityHistory } from '@gyblos/desktop/activity-history';

import { fixture, start } from './support/paypal-session-fixture';

void test('payment references expose authorization IDs without provider calls or public activity leakage', async () => {
  const dependencies = fixture();
  const session = await start(dependencies);
  const calls = [...dependencies.calls];
  const reference = session.paymentReference();
  assert.deepEqual(reference, {
    sessionId: session.activity()!.id,
    kind: 'authorization',
    id: 'AUTH1',
  });
  assert.deepEqual(dependencies.calls, calls);
  assert.doesNotMatch(JSON.stringify(session.activity()), /AUTH1|ORDER1/);
});

void test('a confirmed capture replaces the authorization reference with its actual capture ID', async () => {
  const dependencies = fixture();
  const session = await start(dependencies);
  const response = await session.message('ORDER1', 'Synthetic', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', response.messageId);
  await session.finish('ORDER1');
  const calls = [...dependencies.calls];
  assert.equal(session.paymentReference()?.kind, 'capture');
  assert.equal(session.paymentReference()?.id, 'CAPTURE1');
  assert.deepEqual(dependencies.calls, calls);
});

void test('uncertain captures never expose a confirmed payment reference', async () => {
  const dependencies = fixture();
  const session = await start(dependencies);
  const response = await session.message('ORDER1', 'Synthetic', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', response.messageId);
  dependencies.payment.capture = async () => {
    throw new Error('unavailable');
  };
  await assert.rejects(session.finish('ORDER1'));
  assert.equal(session.paymentReference(), null);
});

void test('local reference metadata survives reload without changing the public activity summary', async () => {
  const session = await start(fixture());
  let stored: string | undefined;
  const files = {
    read: async () => stored,
    write: async (text: string) => {
      stored = text;
    },
  };
  const history = new ActivityHistory(files, () => 123);
  await history.observe(session.activity(), session.paymentReference());
  const restored = new ActivityHistory(files, () => 456);
  assert.deepEqual((await restored.references()).references, [
    session.paymentReference(),
  ]);
  assert.doesNotMatch(
    JSON.stringify(await restored.summary(null)),
    /AUTH1|authorizationId/,
  );
});

void test('legacy history remains readable and never invents missing references', async () => {
  const session = await start(fixture());
  const history = new ActivityHistory(
    { read: async () => undefined, write: async () => {} },
    () => 123,
  );
  await history.observe(session.activity());
  const summary = await history.summary(null);
  const stored = JSON.stringify({ version: 1, sessions: summary.sessions });
  const restored = new ActivityHistory({
    read: async () => stored,
    write: async () => {},
  });
  assert.equal((await restored.summary(null)).available, true);
  assert.deepEqual((await restored.references()).references, []);
});

void test('reference bridge rejects other windows, subframes and arguments before reading', async () => {
  const { createActivityHandlers } =
    await import('@gyblos/desktop/activity-handlers');
  const contents = {};
  const frame = {};
  let reads = 0;
  const handlers = createActivityHandlers(
    async () => ({ available: true, currentSessionId: null, sessions: [] }),
    { contents, mainFrame: () => frame, destroyed: () => false },
    async () => {
      reads++;
      return { available: true, references: [] };
    },
  );
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: {} },
  ])
    assert.equal((await handlers.references(event, [])).available, false);
  assert.equal(
    (
      await handlers.references({ sender: contents, senderFrame: frame }, [
        'extra',
      ])
    ).available,
    false,
  );
  assert.equal(reads, 0);
  assert.equal(
    (await handlers.references({ sender: contents, senderFrame: frame }, []))
      .available,
    true,
  );
  assert.equal(reads, 1);
});

void test('references reject duplicate, forged and URL-shaped provider identifiers', async () => {
  const { parsePaymentReferences } =
    await import('@gyblos/desktop/payment-reference-model');
  const session = await start(fixture());
  const reference = session.paymentReference()!;
  assert.equal(
    parsePaymentReferences({ available: true, references: [reference] })
      .available,
    true,
  );
  for (const references of [
    [reference, reference],
    [{ ...reference, id: 'https://example.com' }],
    [{ ...reference, url: 'https://example.com' }],
    [{ ...reference, kind: 'order' }],
  ])
    assert.equal(
      parsePaymentReferences({ available: true, references }).available,
      false,
    );
});

void test('reference-only observations persist and uncertainty removes stale provider claims', async () => {
  const session = await start(fixture());
  let stored: string | undefined;
  const files = {
    read: async () => stored,
    write: async (text: string) => {
      stored = text;
    },
  };
  const history = new ActivityHistory(files, () => 123);
  await history.observe(session.activity());
  await history.observe(session.activity(), session.paymentReference());
  assert.equal(
    (await new ActivityHistory(files).references()).references.length,
    1,
  );
  await history.observe(session.activity(), null);
  assert.deepEqual(
    (await new ActivityHistory(files).references()).references,
    [],
  );
});

void test('corrupt reference metadata is never overwritten', async () => {
  const session = await start(fixture());
  const history = new ActivityHistory(
    { read: async () => undefined, write: async () => {} },
    () => 123,
  );
  await history.observe(session.activity());
  let writes = 0;
  const corrupt = JSON.stringify({
    version: 2,
    sessions: (await history.summary(null)).sessions,
    references: [{ ...session.paymentReference(), sessionId: 'b'.repeat(64) }],
  });
  const restored = new ActivityHistory(
    {
      read: async () => corrupt,
      write: async () => {
        writes++;
      },
    },
    () => 123,
  );
  await restored.observe(session.activity(), session.paymentReference());
  assert.equal((await restored.references()).available, false);
  assert.equal(writes, 0);
});

void test('read-only reference loading never initializes a payment runtime or owns its lock', async () => {
  const { createDesktopActivityStorage } =
    await import('@gyblos/desktop/activity-storage');
  const storage = createDesktopActivityStorage(
    undefined,
    () => null,
    () => {
      throw new Error('No active payment service');
    },
  );
  assert.deepEqual(await storage.references(), {
    available: true,
    references: [],
  });
  await storage.close(async () => {});
});
