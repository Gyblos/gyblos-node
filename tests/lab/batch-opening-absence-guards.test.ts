// Proves independent expiry/absence guards through public recovery, with no simulated refund or new signing.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ABSENCE_PREPARATIONS,
  batchAbsenceRig,
} from '../support/batch-absence';

for (const preparation of [
  ABSENCE_PREPARATIONS.UNSIGNED,
  ABSENCE_PREPARATIONS.VOUCHER,
]) {
  void test(`never-created recovery uses retained ${preparation} SDK bytes without another wallet call`, async (t) => {
    const rig = await batchAbsenceRig(t, preparation);
    const before = await rig.read();
    rig.financial.vm.expire();
    const result = await rig.recover();
    assert.equal(result[0]?.notCreated, true);
    assert.equal(result[0]?.settlement, null);
    const after = await rig.read();
    assert.deepEqual(after.hints, before.hints);
    assert.equal(after.salt, before.salt);
    for (const [key, value] of Object.entries(before.pending))
      assert.equal(after.pending[key], value);
    assert.equal(rig.signs(), 0);
    assert.equal(rig.financial.vm.sends(), 0);
    assert.deepEqual(await rig.budget(), {
      committedAtomic: '0',
      availableAtomic: '1000',
    });
  });
}
const cases: [
  string,
  (rig: Awaited<ReturnType<typeof batchAbsenceRig>>) => Promise<void>,
][] = [
  [
    'the finalized height equals the original lifetime',
    async (rig) => {
      const record = await rig.read();
      rig.patch({
        getEpochInfo: () => ({
          send: async () => ({
            absoluteSlot: rig.financial.vm.slot(),
            blockHeight: BigInt(record.hints.lastValidBlockHeight),
          }),
        }),
      });
    },
  ],
  [
    'the original blockhash is still valid',
    async (rig) => {
      rig.patch({
        isBlockhashValid: () => ({
          send: async () => ({
            context: { slot: rig.financial.vm.slot() },
            value: true,
          }),
        }),
      });
    },
  ],
  [
    'blockhash freshness context is malformed',
    async (rig) => {
      rig.patch({
        isBlockhashValid: () => ({
          send: async () => ({ context: {}, value: false }),
        }),
      });
    },
  ],
  [
    'account freshness context is missing',
    async (rig) => {
      rig.patch({
        getAccountInfo: () => ({ send: async () => ({ value: null }) }),
      });
    },
  ],
  [
    'account freshness context is older than the finalized bank',
    async (rig) => {
      rig.patch({
        getAccountInfo: () => ({
          send: async () => ({
            context: { slot: rig.financial.vm.slot() - 1n },
            value: null,
          }),
        }),
      });
    },
  ],
  [
    'a channel account exists',
    async (rig) => {
      rig.patch({
        getAccountInfo: () => ({
          send: async () => ({
            context: { slot: rig.financial.vm.slot() },
            value: {},
          }),
        }),
      });
    },
  ],
  [
    'the retained ledger starts after the opening slot',
    async (rig) => {
      rig.patch({
        minimumLedgerSlot: () => ({
          send: async () => rig.financial.vm.slot(),
        }),
      });
    },
  ],
  [
    'history pagination never completes',
    async (rig) => {
      const signature = rig.financial.vm.history.signatures(
        rig.financial.terms.mint,
      )[0]!.signature;
      rig.patch({
        getSignaturesForAddress: (_id: unknown, config: { limit: number }) => ({
          send: async () =>
            Array.from({ length: config.limit }, () => ({
              signature,
              err: null,
            })),
        }),
      });
    },
  ],
  [
    'a successful unknown transaction has no readable receipt',
    async (rig) => {
      const row = rig.financial.vm.history.signatures(
        rig.financial.terms.mint,
      )[0]!;
      rig.patch({
        getSignaturesForAddress: () => ({ send: async () => [row] }),
        getTransaction: () => ({ send: async () => null }),
      });
    },
  ],
  [
    'the genesis belongs to another network',
    async (rig) => {
      rig.local.wrongGenesis(true);
    },
  ],
  [
    'the read-only RPC is unavailable',
    async (rig) => {
      rig.patch({
        isBlockhashValid: () => ({
          send: async () => {
            throw new Error('Synthetic unavailable');
          },
        }),
      });
    },
  ],
];
for (const [name, patch] of cases) {
  void test(`never-created recovery stays blocked when ${name}`, async (t) => {
    const rig = await batchAbsenceRig(t);
    rig.financial.vm.expire();
    await patch(rig);
    const before = await rig.read();
    const results = await rig.recover();
    assert.notEqual(results[0]?.notCreated, true);
    assert.equal(results[0]?.confirmed, false);
    assert.deepEqual(await rig.read(), before);
    assert.deepEqual(await rig.budget(), {
      committedAtomic: '1000',
      availableAtomic: '0',
    });
    assert.equal(rig.signs(), 0);
    assert.equal(rig.financial.vm.sends(), 0);
  });
}
void test('shortened unsigned lifetime metadata cannot release a still-valid original opening', async (t) => {
  const rig = await batchAbsenceRig(t);
  const record = await rig.read();
  record.hints.lastValidBlockHeight = '1';
  await rig.write(record);
  const results = await rig.recover();
  assert.notEqual(results[0]?.notCreated, true);
  assert.equal(results[0]?.confirmed, false);
  assert.deepEqual(await rig.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
  assert.equal(rig.signs(), 0);
});
void test('changed original opening bytes never become absence evidence', async (t) => {
  const rig = await batchAbsenceRig(t);
  const record = await rig.read();
  record.salt = String(BigInt(record.salt) + 1n);
  await rig.write(record);
  rig.financial.vm.expire();
  const results = await rig.recover();
  assert.notEqual(results[0]?.notCreated, true);
  assert.equal(results[0]?.confirmed, false);
  assert.equal(rig.signs(), 0);
  assert.equal(rig.financial.vm.sends(), 0);
});
void test('an actually created channel follows close and refund instead of no-deposit release', async (t) => {
  const { batchRecoveryRig } = await import('../support/batch-recovery');
  const rig = await batchRecoveryRig(t);
  rig.financial.vm.expire();
  const close = await rig.recover();
  assert.notEqual(close?.notCreated, true);
  assert.equal(close?.settlement, null);
  assert.equal(
    rig.financial.vm.sends(),
    2,
    'one real VM deposit and one buyer close',
  );
  await rig.recover();
  rig.grace();
  const settled = await rig.recover();
  assert.equal(settled?.settlement?.refundedAtomic, '1000');
  assert.notEqual(settled?.notCreated, true);
});
void test('an account older than the blockhash-expiry observation cannot release the reservation', async (t) => {
  const rig = await batchAbsenceRig(t);
  rig.financial.vm.expire();
  rig.patch({
    isBlockhashValid: () => ({
      send: async () => ({
        context: { slot: rig.financial.vm.slot() + 1n },
        value: false,
      }),
    }),
  });
  const results = await rig.recover();
  assert.notEqual(results[0]?.notCreated, true);
  assert.deepEqual(await rig.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
});
void test('a history row without an explicit error verdict is not failed-history evidence', async (t) => {
  const rig = await batchAbsenceRig(t);
  rig.financial.vm.expire();
  const row = rig.financial.vm.history.signatures(rig.financial.terms.mint)[0]!;
  rig.patch({
    getSignaturesForAddress: () => ({
      send: async () => [{ signature: row.signature }],
    }),
  });
  const results = await rig.recover();
  assert.notEqual(results[0]?.notCreated, true);
  assert.deepEqual(await rig.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
});
