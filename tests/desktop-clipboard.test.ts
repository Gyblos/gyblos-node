// Exercises user-triggered clipboard writes with synthetic text and no system clipboard.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COPY_RESULT, writeClipboardText } from '@gyblos/desktop/clipboard';

void test('desktop clipboard writes the exact selected address and waits for completion', async () => {
  const writes: string[] = [];
  let completeWrite = () => {};
  const completion = new Promise<void>((resolve) => {
    completeWrite = resolve;
  });
  let completed = false;
  const copying = writeClipboardText('synthetic-public-address', {
    writeText: async (text) => {
      writes.push(text);
      await completion;
    },
  }).then((result) => {
    completed = true;
    return result;
  });
  await Promise.resolve();
  assert.deepEqual(writes, ['synthetic-public-address']);
  assert.equal(completed, false);
  completeWrite();
  assert.equal(await copying, COPY_RESULT.COPIED);
});

void test('desktop clipboard reports rejection without exposing clipboard errors', async () => {
  const result = await writeClipboardText('synthetic-public-address', {
    writeText: async () => {
      throw new Error('Synthetic platform detail');
    },
  });
  assert.equal(result, COPY_RESULT.UNAVAILABLE);
});

void test('desktop clipboard reports unavailable access without claiming success', async () => {
  assert.equal(
    await writeClipboardText('synthetic-public-address', undefined),
    COPY_RESULT.UNAVAILABLE,
  );
});
