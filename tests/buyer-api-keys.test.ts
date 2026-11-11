// Synthetic key authorities use an in-memory private store, never wallets or network services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';

const scope = {
  network: 'synthetic-network',
  mint: '1'.repeat(32),
  payer: '2'.repeat(32),
};
function storage() {
  let saved: string | undefined;
  return {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
    value: () => saved,
    replace: (text: string) => {
      saved = text;
    },
  };
}
const quote = (amount: string) => ({
  maxAtomic: amount,
  requestId: 'synthetic-request',
  requestDigest: 'a'.repeat(64),
  sellerNodeId: 'b'.repeat(64),
});
void test('a USDC API key reserves before spending and retains its lifetime cap across restart', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const created = await keys.create('Coding tools', '100');
  assert.equal(keys.authenticate(created.secret), created.id);
  assert.doesNotMatch(files.value() ?? '', new RegExp(created.secret));
  const first = keys.operation(created.id);
  await first.reserve(quote('60'));
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '60');
  await first.complete('30', 'settled');
  await keys.close();
  const restored = await createBuyerApiKeys({ files, scope });
  assert.equal(restored.authenticate(created.secret), created.id);
  const next = restored.operation(created.id);
  await assert.rejects(next.reserve(quote('80')), /BUYER_KEY_LIMIT_REACHED/);
  await next.reserve(quote('70'));
  await next.complete('70', 'approved');
  assert.deepEqual(
    (await restored.snapshot()).keys.map((key) => [
      key.spentAtomic,
      key.settledAtomic,
      key.approvedAtomic,
      key.reservedAtomic,
    ]),
    [['100', '30', '70', '0']],
  );
  await assert.rejects(
    restored.operation(created.id).reserve(quote('1')),
    /BUYER_KEY_LIMIT_REACHED/,
  );
  const free = restored.operation(created.id);
  await free.reserve(quote('0'));
  await free.complete('0', 'settled');
  await restored.close();
});
void test('unknown paid reservations survive a restart and cannot be bypassed by creating another key', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const first = await keys.create('Synthetic', '100');
  await keys.operation(first.id).reserve(quote('100'));
  await keys.close();
  const restored = await createBuyerApiKeys({ files, scope });
  assert.equal((await restored.snapshot()).blocked, true);
  await assert.rejects(
    restored.create('Replacement', '100'),
    /BUYER_KEY_NEEDS_REVIEW/,
  );
  assert.throws(() => restored.operation(first.id), /BUYER_KEY_NEEDS_REVIEW/);
  await restored.revoke(first.id);
  assert.equal(restored.authenticate(first.secret), undefined);
  assert.equal((await restored.snapshot()).keys[0]?.reservedAtomic, '100');
  await restored.close();
});
void test('a key cannot change asset binding, reset its cap, or erase a running obligation by revocation', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const key = await keys.create('Synthetic', '50');
  const running = keys.operation(key.id);
  await running.reserve(quote('50'));
  await keys.revoke(key.id);
  assert.equal(running.signal.aborted, true);
  await running.complete('40', 'approved');
  assert.equal((await keys.snapshot()).keys[0]?.spentAtomic, '40');
  await keys.close();
  await assert.rejects(
    createBuyerApiKeys({ files, scope: { ...scope, payer: '3'.repeat(32) } }),
    /BUYER_KEY_NEEDS_REVIEW/,
  );
});
