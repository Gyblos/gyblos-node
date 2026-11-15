// Synthetic closed generations prove bounded renewal without losing charges, proofs or opening attempts.
import assert from 'node:assert/strict';
import filesystem, { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  createBatchBuyer,
  createBatchSeller,
  inspectBatchPool,
  inspectBatchSession,
  renewBatchSession,
} from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

async function closedGeneration() {
  const rig = await sessionRig();
  try {
    await rig.open();
    await rig.serve(1, '40');
    const settlement = await rig.seller().close();
    await rig.buyer.reconcile(rig.sellerOptions.observe);
    const previous = await readFile(rig.buyerOptions.paths.state, 'utf8');
    const next = {
      ...rig.terms,
      depositAtomic: '960',
      expiresAt: rig.terms.expiresAt + 1,
    };
    return {
      rig,
      previous,
      settlement,
      options: {
        paths: rig.buyerOptions.paths,
        expectedChannelId: settlement.channelId,
        terms: next,
        now: rig.now,
        observe: rig.sellerOptions.observe,
        totalBudgetAtomic: '1000',
      },
    };
  } finally {
    await rig.dispose();
  }
}

void test('renewal atomically preserves the closed proof and prepares one unsigned generation', async () => {
  const { rig, previous, options } = await closedGeneration();
  await renewBatchSession(options);
  const stored = await inspectBatchSession(options.paths);
  assert.ok(stored);
  assert.deepEqual(stored.terms, options.terms);
  assert.equal(stored.snapshot.state, SESSION_STATES.OPENING);
  assert.equal(stored.snapshot.channelId, '');
  const record = JSON.parse(await readFile(options.paths.state, 'utf8'));
  assert.equal(record.version, 3);
  assert.deepEqual(record.history, [JSON.parse(previous)]);
  assert.equal(record.opening, null);
  assert.deepEqual(record.pending, {});
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});

void test('renewal refuses a missing independent close proof without changing the journal', async () => {
  const { previous, options } = await closedGeneration();
  await assert.rejects(
    renewBatchSession({ ...options, observe: async () => undefined }),
    {
      code: SESSION_CODES.UNVERIFIED,
    },
  );
  assert.equal(await readFile(options.paths.state, 'utf8'), previous);
});

void test('renewal refuses a changed refund proof and a larger total authorization', async () => {
  const { previous, settlement, options } = await closedGeneration();
  await assert.rejects(
    renewBatchSession({
      ...options,
      observe: async () => ({ ...settlement, refundedAtomic: '959' }),
    }),
    {
      code: SESSION_CODES.UNVERIFIED,
    },
  );
  await assert.rejects(
    renewBatchSession({
      ...options,
      terms: { ...options.terms, depositAtomic: '961' },
    }),
    {
      code: SESSION_CODES.LIMIT,
    },
  );
  assert.equal(await readFile(options.paths.state, 'utf8'), previous);
});

void test('repeating a prepared renewal restores the same generation without another opening', async () => {
  const { rig, options } = await closedGeneration();
  await renewBatchSession(options);
  const prepared = await readFile(options.paths.state, 'utf8');
  await renewBatchSession(options);
  assert.equal(await readFile(options.paths.state, 'utf8'), prepared);
  const buyer = await createBatchBuyer({
    ...rig.buyerOptions,
    terms: options.terms,
  });
  try {
    assert.equal(buyer.usesBlocks(), false);
    const opening = await buyer.open();
    assert.notEqual(
      JSON.parse(opening).voucher.channelId,
      options.expectedChannelId,
    );
  } finally {
    await buyer.dispose();
  }
  const first = await readFile(options.paths.state, 'utf8');
  const restored = await createBatchBuyer({
    ...rig.buyerOptions,
    terms: options.terms,
  });
  try {
    await restored.open();
    assert.equal(await readFile(options.paths.state, 'utf8'), first);
  } finally {
    await restored.dispose();
  }
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});

void test('renewal cannot change the buyer binding or overwrite an owned journal', async () => {
  const { rig, previous, options } = await closedGeneration();
  await assert.rejects(
    renewBatchSession({
      ...options,
      terms: { ...options.terms, buyerNodeId: 'fe'.repeat(32) },
    }),
    {
      code: SESSION_CODES.BINDING,
    },
  );
  const owner = await createBatchBuyer(rig.buyerOptions);
  try {
    await assert.rejects(renewBatchSession(options));
    assert.equal(await readFile(options.paths.state, 'utf8'), previous);
  } finally {
    await owner.dispose();
  }
});

void test('new block checkpoints retain closed history and cannot be imported as a cheaper pool balance', async () => {
  const { rig, options, previous } = await closedGeneration();
  await renewBatchSession(options);
  await renewBatchSession({ ...options, paths: rig.sellerOptions.paths });
  const buyer = await createBatchBuyer({
    ...rig.buyerOptions,
    terms: options.terms,
  });
  const seller = await createBatchSeller({
    ...rig.sellerOptions,
    terms: options.terms,
  });
  try {
    await seller.open(await buyer.open());
    await buyer.beginBlocks(rig.request(2));
    assert.equal(buyer.usesBlocks(), true);
    const raw = JSON.parse(await readFile(options.paths.state, 'utf8'));
    assert.equal(raw.version, 3);
    assert.deepEqual(raw.history, [JSON.parse(previous)]);
    assert.equal(
      (await inspectBatchSession(options.paths))?.priorSpentAtomic,
      '40',
    );
    await assert.rejects(
      inspectBatchPool(batchPoolPathsIn({ GYBLOS_HOME: rig.root })),
      { code: SESSION_CODES.UNVERIFIED },
    );
  } finally {
    await buyer.dispose();
    await seller.dispose();
  }
});

void test('an interrupted renewal publication preserves the old proof and can be retried exactly once', async (t) => {
  const { previous, options } = await closedGeneration();
  const rename = filesystem.rename;
  t.mock.method(
    filesystem,
    'rename',
    (...args: Parameters<typeof filesystem.rename>) => {
      if (args[1] === options.paths.state)
        throw new Error('Synthetic publication failure');
      return rename(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(renewBatchSession(options), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  assert.equal(await readFile(options.paths.state, 'utf8'), previous);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  await renewBatchSession(options);
  assert.equal(
    (await inspectBatchSession(options.paths))?.priorSpentAtomic,
    '40',
  );
});

void test('renewal refuses a full byte budget before replacing any proof', async () => {
  const { previous, options } = await closedGeneration();
  const record = JSON.parse(previous);
  record.pending.padding = 'x'.repeat(
    BATCH_SESSION_DEFAULTS.stateBytes - Buffer.byteLength(previous) - 256,
  );
  const full = JSON.stringify(record);
  await writeFile(options.paths.state, full);
  assert.ok(await inspectBatchSession(options.paths));
  await assert.rejects(renewBatchSession(options), {
    code: SESSION_CODES.LIMIT,
  });
  assert.equal(await readFile(options.paths.state, 'utf8'), full);
});

void test('an expired replacement that never began signing refreshes terms without archiving a fake channel', async () => {
  const { rig, options } = await closedGeneration();
  await renewBatchSession(options);
  rig.time(options.terms.expiresAt + 1);
  const terms = { ...options.terms, expiresAt: rig.now() + 3_600_000 };
  await renewBatchSession({
    ...options,
    expectedChannelId: '',
    terms,
    observe: async () =>
      assert.fail('No replacement was ever signed or opened'),
  });
  const stored = await inspectBatchSession(options.paths);
  assert.ok(stored);
  assert.deepEqual(stored.terms, terms);
  assert.equal(stored.priorSpentAtomic, '40');
  const raw = JSON.parse(await readFile(options.paths.state, 'utf8'));
  assert.equal(raw.history.length, 1);
  assert.equal(raw.opening, null);
  const refreshed = await readFile(options.paths.state, 'utf8');
  await renewBatchSession({ ...options, expectedChannelId: '', terms });
  assert.equal(await readFile(options.paths.state, 'utf8'), refreshed);
  const buyer = await createBatchBuyer({ ...rig.buyerOptions, terms });
  let checks = 0;
  try {
    await assert.rejects(
      buyer.open(() => {
        checks++;
        if (checks > 1)
          throw new Error('Synthetic interruption before signing');
      }),
    );
  } finally {
    await buyer.dispose();
  }
  const attempted = await readFile(options.paths.state, 'utf8');
  assert.notEqual(JSON.parse(attempted).hints, null);
  await assert.rejects(
    renewBatchSession({
      ...options,
      expectedChannelId: '',
      terms: { ...terms, expiresAt: terms.expiresAt + 1 },
    }),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(await readFile(options.paths.state, 'utf8'), attempted);
});

void test('closed history is bounded without evicting generations or manufacturing more spending authority', async () => {
  const rig = await sessionRig();
  let buyer = rig.buyer;
  let seller = rig.seller();
  let terms = rig.terms;
  const observe = async (channelId: string) => {
    const found = await rig.sellerOptions.observe(channelId);
    return found?.channelId === channelId ? found : undefined;
  };
  try {
    for (let index = 0; index <= 16; index++) {
      await seller.open(await buyer.open());
      const settlement = await seller.close();
      await buyer.reconcile(rig.sellerOptions.observe);
      await buyer.dispose();
      await seller.dispose();
      const next = { ...terms, expiresAt: terms.expiresAt + 1 };
      const options = {
        paths: rig.buyerOptions.paths,
        expectedChannelId: settlement.channelId,
        terms: next,
        now: rig.now,
        observe,
        totalBudgetAtomic: '1000',
      };
      if (index === 16) {
        const full = await readFile(options.paths.state, 'utf8');
        await assert.rejects(renewBatchSession(options), {
          code: SESSION_CODES.LIMIT,
        });
        assert.equal(await readFile(options.paths.state, 'utf8'), full);
        assert.equal(JSON.parse(full).history.length, 16);
        break;
      }
      await renewBatchSession(options);
      await renewBatchSession({ ...options, paths: rig.sellerOptions.paths });
      terms = next;
      buyer = await createBatchBuyer({ ...rig.buyerOptions, terms });
      seller = await createBatchSeller({
        ...rig.sellerOptions,
        terms,
        observe,
      });
    }
  } finally {
    await buyer.dispose();
    await seller.dispose();
  }
});
