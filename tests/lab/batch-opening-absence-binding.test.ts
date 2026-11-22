import assert from 'node:assert/strict';
import test from 'node:test';

import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchAbsenceRig } from '../support/batch-absence';

interface OpenedJournal {
  channelId: string;
  terms: { payTo: string };
  voucher?: { channelId: string };
  opening: { voucher: { channelId: string }; channelConfig: { salt: string } };
}
void test('an opened journal bound to another channel cannot be loaded for recovery', async (t) => {
  const rig = await batchAbsenceRig(t);
  const record = await rig.read();
  record.channelId = record.terms.payTo;
  await rig.write(record);
  rig.financial.vm.expire();
  await assert.rejects(rig.recover(), { code: SESSION_CODES.UNAVAILABLE });
  await assert.rejects(rig.budget());
  assert.deepEqual(await rig.read(), record);
  assert.equal(rig.signs() + rig.financial.vm.sends(), 0);
});
for (const [name, change] of [
  [
    'channel',
    (record: OpenedJournal) => {
      record.channelId = record.terms.payTo;
      record.opening.voucher.channelId = record.terms.payTo;
      if (record.voucher) record.voucher.channelId = record.terms.payTo;
    },
  ],
  [
    'channel configuration',
    (record: OpenedJournal) => {
      const config = record.opening.channelConfig;
      config.salt = String(BigInt(config.salt) ^ 1n);
    },
  ],
] as const)
  void test(`an opened journal consistently bound to another ${name} never becomes absence evidence`, async (t) => {
    const rig = await batchAbsenceRig(t);
    const record = await rig.read();
    assert.ok(record.opening);
    change(record);
    await rig.write(record);
    rig.financial.vm.expire();
    const results = await rig.recover();
    assert.equal(results.length, 1);
    assert.equal(results[0]?.failure, SESSION_CODES.BINDING);
    assert.equal(results[0]?.confirmed, false);
    assert.notEqual(results[0]?.notCreated, true);
    assert.deepEqual(await rig.budget(), {
      committedAtomic: '1000',
      availableAtomic: '0',
    });
    assert.deepEqual(await rig.read(), record);
    assert.equal(rig.signs() + rig.financial.vm.sends(), 0);
  });
