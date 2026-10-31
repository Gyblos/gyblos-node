// Exercises local collector acceptance with synthetic signatures; no runtime uploader or external services.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { collectReceiptAcceptance } from '@gyblos/lab-harness/acceptance/receipt-collector';
import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';
import { openReceiptFileStore } from '@gyblos/telemetry-file/receipt-store';

import { collectorPair } from '../support/receipt-collector';

void test('collector acceptance persists signed pairs and reopens in a separate process', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const second = await collectorPair((record) => ({
    ...record,
    requestId: '88'.repeat(16),
  }));
  assert.deepEqual(
    await collectReceiptAcceptance(
      workspace.root,
      [first.pair, second.pair],
      new AbortController().signal,
    ),
    {
      collectorStored: 2,
      collectorDuplicates: 2,
      collectorRestarts: 1,
      collectorRefusals: 3,
    },
  );
});
void test('collector acceptance refuses incomplete evidence before allocating storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const before = await readdir(workspace.root);
  await assert.rejects(
    collectReceiptAcceptance(workspace.root, [], new AbortController().signal),
    { code: 'ACCEPTANCE_FAILED' },
  );
  assert.deepEqual(await readdir(workspace.root), before);
});
void test('collector acceptance refuses pre-cancellation before allocating storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const before = await readdir(workspace.root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectReceiptAcceptance(
      workspace.root,
      [first.pair, first.pair],
      controller.signal,
    ),
    { code: 'ACCEPTANCE_CANCELLED' },
  );
  assert.deepEqual(await readdir(workspace.root), before);
});

void test('collector acceptance refuses duplicate evidence before allocating storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const before = await readdir(workspace.root);
  await assert.rejects(
    collectReceiptAcceptance(
      workspace.root,
      [first.pair, first.pair],
      new AbortController().signal,
    ),
    { code: 'ACCEPTANCE_FAILED' },
  );
  assert.deepEqual(await readdir(workspace.root), before);
});
void test('collector acceptance cancellation terminates its restart child and releases storage', async (context) => {
  const workspace = await createAcceptanceWorkspace();
  context.after(() => workspace.close());
  const first = await collectorPair();
  const second = await collectorPair();
  const controller = new AbortController();
  const original = childProcess.fork;
  let child: ReturnType<typeof childProcess.fork> | undefined;
  const mock = context.mock.method(
    childProcess,
    'fork',
    (...args: Parameters<typeof childProcess.fork>) => {
      child = original(...args);
      controller.abort();
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      collectReceiptAcceptance(
        workspace.root,
        [first.pair, second.pair],
        controller.signal,
      ),
      { code: 'ACCEPTANCE_CANCELLED' },
    );
    assert.ok(child);
    assert.equal(child.signalCode, 'SIGTERM');
    const reopened = await openReceiptFileStore({
      path: join(workspace.root, 'collector-acceptance', 'receipts.json'),
    });
    await reopened.close();
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
