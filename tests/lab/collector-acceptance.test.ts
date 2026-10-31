// Exercises local collector acceptance with synthetic signatures; no runtime uploader or external services.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';

import { collectReceiptAcceptance } from '@gyblos/lab-harness/acceptance/receipt-collector';
import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';

import { collectorPair } from '../support/receipt-collector';

void test('collector acceptance persists signed pairs and reopens in a separate process', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const second = await collectorPair((record) => ({ ...record, requestId: '88'.repeat(16) }));
  assert.deepEqual(await collectReceiptAcceptance(workspace.root, [first.pair, second.pair], new AbortController().signal), {
    collectorStored: 2,
    collectorDuplicates: 2,
    collectorRestarts: 1,
    collectorRefusals: 3,
  });
});
void test('collector acceptance refuses incomplete evidence before allocating storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const before = await readdir(workspace.root);
  await assert.rejects(collectReceiptAcceptance(workspace.root, [], new AbortController().signal), { code: 'ACCEPTANCE_FAILED' });
  assert.deepEqual(await readdir(workspace.root), before);
});
void test('collector acceptance refuses pre-cancellation before allocating storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const before = await readdir(workspace.root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectReceiptAcceptance(workspace.root, [first.pair, first.pair], controller.signal), { code: 'ACCEPTANCE_CANCELLED' });
  assert.deepEqual(await readdir(workspace.root), before);
});
