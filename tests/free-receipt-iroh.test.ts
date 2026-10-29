// Proves native inference → private seller receipt → independent buyer countersignature, without payments.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { FILE_MODES, receiptPathsIn } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { verifyReceipt } from '@gyblos/protocol/receipt';

import { nativeFreeReceiptFixture } from './support/free-receipts';
import { NATIVE_CAPABILITY } from './support/native-runtime';

for (const streaming of [false, true])
  void test(
    `native free ${streaming ? 'stream' : 'response'} persists and confirms content-free signed receipts`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const f = await nativeFreeReceiptFixture();
      try {
        const result = await f.execute(streaming);
        assert.equal(result.text, 'é😀');
        assert.equal(f.calls(), 1);
        assert.equal(f.selections(), 1);
        assert.equal(f.buyerReceipts.health().saved, 1);
        assert.equal(f.sellerReceipts.health().saved, 1);
        const key = {
          executionRequestId: f.request.requestId,
          requestDigest: await freeExecutionDigest(f.request),
          sellerNodeId: f.seller.id().toString(),
          buyerNodeId: f.buyer.id().toString(),
        };
        const seller = await f.sellerStore.load(
          key,
          new AbortController().signal,
        );
        const buyer = await f.buyerStore.load(
          key,
          new AbortController().signal,
        );
        assert.ok(seller?.buyer);
        assert.ok(buyer?.buyer);
        assert.deepEqual(
          await verifyReceipt(seller),
          await verifyReceipt(buyer),
        );
        assert.equal(seller.seller.record.streaming, streaming);
        assert.equal(buyer.buyer.record.observed.inputTokens, null);
        assert.equal(buyer.buyer.record.observed.outputTokens, null);
        assert.equal(buyer.buyer.record.observed.outputBytes, 6);
        for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
          const paths = receiptPathsIn(f.environment, role);
          assert.equal(
            (await stat(paths.directory)).mode & 0o777,
            FILE_MODES.privateDirectory,
          );
          assert.equal(
            (await stat(paths.state)).mode & 0o777,
            FILE_MODES.privateFile,
          );
          const text = await readFile(paths.state, 'utf8');
          assert.equal(text.includes('hello'), false);
          assert.equal(text.includes('é😀'), false);
        }
      } finally {
        await f.close();
      }
    },
  );
void test(
  'native receipt channel unavailable preserves inference and never retries the prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const f = await nativeFreeReceiptFixture(false);
    try {
      assert.equal((await f.execute()).text, 'é😀');
      assert.equal(f.calls(), 1);
      assert.equal(f.selections(), 1);
      assert.equal(f.buyerReceipts.health().saved, 0);
      assert.equal(f.buyerReceipts.health().failed, 1);
    } finally {
      await f.close();
    }
  },
);
