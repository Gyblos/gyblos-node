// Untrusted SDK openings cannot add content to or poison the seller's private financial journal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  SESSION_CODES,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

async function stateBytes(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
interface Opening {
  type: string;
  channelConfig: Record<string, unknown>;
  deposit: { amount: string; transaction: string };
  voucher: SessionVoucher;
}
void test('SDK opening rejects unknown fields at every level before journal writes, then accepts a valid retry', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const original = await rig.buyer.open();
  const opening: Opening = JSON.parse(original);
  const before = await stateBytes(rig.sellerOptions.paths.state);
  for (const level of [
    'root',
    'channelConfig',
    'deposit',
    'voucher',
  ] as const) {
    const bad = structuredClone(opening);
    Object.assign(level === 'root' ? bad : bad[level], {
      unexpectedPrivateContent: 'synthetic forbidden journal content',
    });
    await assert.rejects(rig.seller().open(JSON.stringify(bad)), {
      code: SESSION_CODES.INVALID,
    });
    assert.deepEqual(await stateBytes(rig.sellerOptions.paths.state), before);
  }
  await rig.seller().open(original);
  assert.deepEqual(rig.calls, ['deposit']);
  assert.ok(
    !(await readFile(rig.sellerOptions.paths.state, 'utf8')).includes(
      'unexpectedPrivateContent',
    ),
  );
});
void test('an oversized transaction cannot poison the journal or block a later valid opening', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const original = await rig.buyer.open();
  const opening: Opening = JSON.parse(original);
  const overhead =
    Buffer.byteLength(original) -
    Buffer.byteLength(opening.deposit.transaction);
  opening.deposit.transaction = 'A'.repeat(
    BATCH_SESSION_DEFAULTS.stateBytes - overhead - 1,
  );
  const poison = JSON.stringify(opening);
  assert.ok(Buffer.byteLength(poison) < BATCH_SESSION_DEFAULTS.stateBytes);
  const before = await stateBytes(rig.sellerOptions.paths.state);
  await assert.rejects(rig.seller().open(poison), {
    code: SESSION_CODES.LIMIT,
  });
  assert.deepEqual(await stateBytes(rig.sellerOptions.paths.state), before);
  await rig.seller().open(original);
  assert.deepEqual(rig.calls, ['deposit']);
});
void test('an invalid initial SDK voucher cannot pin the journal before signature verification', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const original = await rig.buyer.open();
  const opening: Opening = JSON.parse(original);
  opening.voucher.signature = '1'.repeat(88);
  const before = await stateBytes(rig.sellerOptions.paths.state);
  await assert.rejects(rig.seller().open(JSON.stringify(opening)), {
    code: SESSION_CODES.UNVERIFIED,
  });
  assert.deepEqual(await stateBytes(rig.sellerOptions.paths.state), before);
  await rig.seller().open(original);
  assert.deepEqual(rig.calls, ['deposit']);
});
