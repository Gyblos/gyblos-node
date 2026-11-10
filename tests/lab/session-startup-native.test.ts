// Full product startup and buyer chat over native encrypted loopback with synthetic financial services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY, waitFor } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'product startup and chat reuse one deposit, restore it, then seller settles while buyer is offline',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost();
    t.after(host.close);
    assert.ok(host.binding.protocols()[0]?.includes(BATCH_CHANNEL.alpn));
    assert.equal(host.engine.attempts(), 0);
    let output = '';
    let questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions <= 2 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /Approved this question/);
    assert.equal(host.engine.attempts(), 2);
    assert.deepEqual(host.finance.calls, ['deposit']);
    await host.restartBoth();
    questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.equal(host.engine.attempts(), 3);
    assert.equal(host.finance.buyerCreates(), 2);
    assert.equal(host.finance.sellerCreates(), 2);
    assert.deepEqual(host.finance.calls, ['deposit']);
    await host.stopBuyer();
    host.finance.advance(3600001);
    await waitFor(() => host.finance.settled.size === 1);
    assert.deepEqual(host.finance.calls, ['deposit', 'refund']);
    const final = [...host.finance.settled.values()][0]!;
    assert.ok(BigInt(final.chargedAtomic) > 0n);
    assert.equal(
      BigInt(final.chargedAtomic) + BigInt(final.refundedAtomic),
      100000n,
    );
  },
);
void test(
  'configured session with a zero-price quote performs no financial construction or transactions',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.FREE);
    t.after(host.close);
    let questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write() {},
    });
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.finance.buyerCreates(), 0);
    assert.equal(host.finance.sellerCreates(), 0);
    assert.deepEqual(host.finance.calls, []);
  },
);

void test(
  'startup restores a lost approval acknowledgment without retrying the original prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost();
    t.after(host.close);
    host.finance.loseAcknowledgment();
    let questions = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /No retry was made/);
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.finance.approvals(), 1);
    await host.restartBoth();
    questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () =>
        ++questions === 1 ? 'new synthetic question' : '/exit',
      write: (text) => {
        output += text;
      },
    });
    assert.equal(
      host.engine.attempts(),
      2,
      'recovery never repeats the first inference',
    );
    assert.equal(
      host.finance.approvals(),
      3,
      'recover original approval, then approve new usage',
    );
    assert.deepEqual(host.finance.calls, ['deposit']);
    assert.match(output, /Approved this question/);
  },
);
