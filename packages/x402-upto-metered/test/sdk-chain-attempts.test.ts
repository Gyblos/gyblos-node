// Claim attempts the facilitator sent but could not confirm: remembered, bounded, and recognized by the
// next attempt when one landed. Scripted facilitator and memory store; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { UPTO_CHANNEL_ACCOUNT } from '../src/index';
import { rig } from './chain-rig';

void test('a claim sent but not confirmed is remembered and its transaction found by the next attempt', async () => {
  const seen: (readonly string[])[] = [];
  let landed = false;
  const { chain, calls, record, store } = await rig(
    async () => ({
      success: false,
      transaction: 'P'.repeat(64),
      errorReason: 'settlement_pending',
    }),
    {
      sealedBy: (claim) => {
        seen.push(claim.attempts);
        return landed
          ? {
              transaction: claim.attempts[0]!,
              chargedAtomic: claim.chargedAtomic,
            }
          : undefined;
      },
    },
  );
  await assert.rejects(chain.claim(record, '5'));
  assert.deepEqual((await store.getClaim(record.channelId))?.attempts, [
    'P'.repeat(64),
  ]);
  // The pending transaction landed meanwhile: the retry finds it without sending again.
  landed = true;
  assert.deepEqual(await chain.claim(record, '5'), {
    transaction: 'P'.repeat(64),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(seen.at(-1), ['P'.repeat(64)]);
  assert.equal(
    (await store.getClaim(record.channelId))?.transaction,
    'P'.repeat(64),
  );
});

void test('only the most recent claim attempts are remembered', async () => {
  let sent = 0;
  const { chain, record, store } = await rig(async () => ({
    success: false,
    transaction: String(++sent).padStart(64, 'T'),
    errorReason: 'settlement_pending',
  }));
  const limit = UPTO_CHANNEL_ACCOUNT.maxClaimAttempts;
  for (let attempt = 0; attempt <= limit; attempt++)
    await assert.rejects(chain.claim(record, '5'));
  const attempts = (await store.getClaim(record.channelId))?.attempts ?? [];
  assert.equal(attempts.length, limit);
  assert.equal(attempts.at(-1), String(limit + 1).padStart(64, 'T'));
  assert.equal(attempts[0], String(2).padStart(64, 'T'));
});
