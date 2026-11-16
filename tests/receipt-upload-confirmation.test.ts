// Checks upload capacity during buyer confirmation without evicting either saved signed body.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

void test('a cancelled cold replay cannot repeatedly prevent the next receipt from being saved', async (context) => {
  const f = await receiptUploadFixture();
  const replayStarted = Promise.withResolvers<void>();
  const resumeReplay = Promise.withResolvers<void>();
  try {
    await openReceiptStore(f.options).put(f.envelope);
    const next = await f.next(2);
    const before = await readFile(f.paths.state, 'utf8');
    const cold = openReceiptStore(f.options);
    const first = new AbortController();
    const second = new AbortController();
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    let initialReplay = true;
    context.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<typeof crypto.subtle.verify>) => {
        const signature = args[2];
        const bytes = ArrayBuffer.isView(signature)
          ? new Uint8Array(
              signature.buffer,
              signature.byteOffset,
              signature.byteLength,
            )
          : new Uint8Array(signature);
        if (
          Buffer.from(bytes).toString('hex') === f.envelope.seller.signature
        ) {
          if (initialReplay) {
            initialReplay = false;
            replayStarted.resolve();
            await resumeReplay.promise;
          } else {
            // A repeated full replay consumes the next caller's deadline too.
            second.abort();
          }
        }
        return verify(...args);
      },
    );
    const loading = cold.listPending(1, first.signal);
    await replayStarted.promise;
    first.abort();
    resumeReplay.resolve();
    await assert.rejects(loading, {
      code: NODE_ERROR_CODES.RECEIPT_STORAGE_UNAVAILABLE,
    });
    assert.equal(await readFile(f.paths.state, 'utf8'), before);
    await assert.doesNotReject(cold.put(next, second.signal));
    assert.equal((await cold.listPending()).length, 2);
  } finally {
    resumeReplay.resolve();
    await f.close();
  }
});
