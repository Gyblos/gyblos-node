// Starts product HTTP and native Iroh with a deliberately held metadata response; no external services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { CHAT_COMMANDS } from '@gyblos/buyer/constants';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { holdFirstReceipt } from '../support/held-receipt';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'the next free HTTP turn waits for pending native receipts without retrying either prompt',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: PAID_ACCEPTANCE.runMs },
  async (t) => {
    const receipt = holdFirstReceipt(t);
    const host = await sessionProductHost(OFFER_PRICING_KINDS.FREE);
    const lines = ['first question', 'next question', CHAT_COMMANDS.EXIT];
    let reads = 0;
    let output = '';
    try {
      await chatSession({
        ...host.buyer().chat,
        read: async () => {
          if (reads === 1) {
            // The first answer is already complete while optional receipt transport is still held.
            await receipt.started;
            assert.equal(host.engine.attempts(), 1);
            assert.equal(host.buyer().receipts().active, true);
          }
          return lines[reads++];
        },
        write: (text) => {
          output += text;
        },
      });
      assert.equal(reads, lines.length, output);
      assert.doesNotMatch(output, /Error:|No retry was made/);
      assert.equal(host.engine.attempts(), 2);
      assert.deepEqual(host.finance.calls, []);
      assert.ok(host.buyer().receipts().failed >= 1);
    } finally {
      receipt.release();
      await host.close();
    }
  },
);
