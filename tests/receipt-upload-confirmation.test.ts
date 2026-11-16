// Checks upload capacity during buyer confirmation without evicting either saved signed body.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { openReceiptStore } from '@gyblos/node/receipts';

import { receiptUploadFixture } from './support/receipt-upload-fixture';

void test('buyer confirmation at a full pending budget reports FULL and preserves both saved bodies', async () => {
  const f = await receiptUploadFixture();
  try {
    const store = openReceiptStore({
      ...f.options,
      maxEntries: 2,
      maxPendingEntries: 1,
    });
    await store.put(f.envelope);
    const [original] = await store.listPending();
    assert.ok(original);
    await store.markUploaded(original, 1700000000100);
    await store.put(await f.next(2));
    await assert.rejects(
      store.confirm(f.confirm.params.receipt, new AbortController().signal),
      { code: NODE_ERROR_CODES.RECEIPT_STORAGE_FULL },
    );
    assert.deepEqual(
      await store.load(original.key, new AbortController().signal),
      f.envelope,
    );
    const [waiting] = await store.listPending();
    assert.ok(waiting);
    assert.equal(
      waiting.receipt.seller.record.requestId,
      '2'.padStart(32, '0'),
    );
    assert.equal((await store.uploadHealth()).rejectedWrites, 1);
    assert.equal((await store.uploadHealth()).full, true);
    await store.markUploaded(waiting, 1700000000100);
    assert.equal(
      await store.confirm(
        f.confirm.params.receipt,
        new AbortController().signal,
      ),
      true,
    );
    const [confirmed] = await store.listPending();
    assert.ok(confirmed?.receipt.buyer);
    assert.equal(confirmed.storedAt, original.storedAt);
    assert.equal(await store.markUploaded(original, 1700000000100), false);
  } finally {
    await f.close();
  }
});
