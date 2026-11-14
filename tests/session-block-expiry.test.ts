// Expiry cannot create spending authority; an already durable voucher remains readable as exact evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';
import { blockIntent } from './support/session-block-intent';

void test('financial block recovery cannot sign a durable but unsigned intent after expiry', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);await f.buyer.beginBlocks(request);
  const intent = blockIntent(request, 0, '10');let checks = 0;
  await assert.rejects(f.buyer.approveBlock(intent, '10', () => { if (++checks === 2) throw new Error('Synthetic stop before signing'); }));
  f.time(f.terms.expiresAt + 1);
  await assert.rejects(f.buyer.recoverBlockApproval(), { code: SESSION_CODES.CLOSED });
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '0');
});
void test('financial recovery can return exact existing voucher evidence after expiry without mutating its state', async (t) => {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const request = f.request(1);await f.buyer.beginBlocks(request);const intent = blockIntent(request, 0, '10');
  const voucher = await f.buyer.approveBlock(intent, '10');const before = await readFile(f.buyerOptions.paths.state, 'utf8');
  f.time(f.terms.expiresAt + 1);assert.deepEqual(await f.buyer.recoverBlockApproval(), { intent, voucher });
  assert.equal(await readFile(f.buyerOptions.paths.state, 'utf8'), before);
});
