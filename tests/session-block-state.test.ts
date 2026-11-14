// Synthetic on-disk damage must fail closed before a block journal can be used for new authority.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';
import { blockJson } from './support/block-json';
import { blockIntent } from './support/session-block-intent';

for (const corruption of [
  'base',
  'index',
  'voucher',
  'terminal-flag',
  'unknown-version',
  'orphan',
  'content',
]) {
  void test(`block recovery rejects ${corruption} in a private synthetic journal`, async (t) => {
    const f = await sessionRig();
    t.after(f.dispose);
    await f.open();
    const request = f.request(1);
    await f.buyer.beginBlocks(request);
    const intent = blockIntent(request, 0, '10');
    await f.buyer.approveBlock(intent, '10');
    await f.buyer.dispose();
    const raw = blockJson(
      JSON.parse(await readFile(f.buyerOptions.paths.state, 'utf8')),
    );
    const blocks = blockJson(raw.blocks);
    const original = blockJson(blockJson(raw.requests)[request.requestId]);
    const progress = blockJson(blocks[request.requestId]);
    const pending = blockJson(progress.pending);
    const stored = blockJson(pending.intent);
    if (corruption === 'base') progress.baseAtomic = '1';
    if (corruption === 'index') stored.index = 1;
    if (corruption === 'voucher')
      blockJson(pending.voucher).maxClaimableAmount = '11';
    if (corruption === 'terminal-flag') {
      original.accepted = true;
      original.bill = intent.bill;
    }
    if (corruption === 'unknown-version') raw.version = 3;
    if (corruption === 'orphan')
      blocks['33'.repeat(16)] = structuredClone(progress);
    if (corruption === 'content') stored.text = 'synthetic-forbidden-content';
    await writeFile(f.buyerOptions.paths.state, JSON.stringify(raw));
    await assert.rejects(
      inspectBatchSession(f.buyerOptions.paths),
      (error: unknown) =>
        error instanceof PaymentSessionError &&
        error.code === SESSION_CODES.UNAVAILABLE,
    );
    assert.deepEqual(f.calls, ['deposit']);
  });
}
