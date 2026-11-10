// Product buyer HTTP/chat uses the shared private catalog; financial services and engine are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'normal buyer chat restores the pool and closes with independently proved total amounts',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, '200000');
    t.after(host.close);
    let questions = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions <= 2 ? 'synthetic' : '/exit'),
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /Total deposit authority: 200000/);
    assert.match(output, /Approved this question/);
    await host.restartBuyer();
    questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/settle'),
      write: (text) => {
        output += text;
      },
    });
    assert.equal(host.engine.attempts(), 3);
    assert.deepEqual(host.finance.calls, ['deposit', 'refund']);
    assert.match(output, /Configured RPC reports finalized charge/);
  },
);
void test(
  'normal free quote with pool configuration constructs no financial backend',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.FREE, '200000');
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
