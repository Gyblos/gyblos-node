import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openPaypalJournal } from '@gyblos/node/paypal-journal';

void test('sandbox payment state persists and excludes a second process owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-journal-test-'));
  try {
    const journal = await openPaypalJournal(root);
    assert.equal(await journal.read(), null);
    await journal.write({
      phase: 'capturing',
      requestId: 'REQUEST1',
      promptDigest: 'a'.repeat(64),
      maxTokens: 16,
      orderId: 'ORDER1',
      authorizationId: 'AUTH1',
    });
    await assert.rejects(openPaypalJournal(root));
    await journal.close();
    const reopened = await openPaypalJournal(root);
    assert.deepEqual(await reopened.read(), {
      phase: 'capturing',
      requestId: 'REQUEST1',
      promptDigest: 'a'.repeat(64),
      maxTokens: 16,
      orderId: 'ORDER1',
      authorizationId: 'AUTH1',
    });
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
