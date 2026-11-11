// Product buyer HTTP/chat uses the shared private catalog; financial services and engine are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { startFreeBuyer } from '@gyblos/buyer/free-startup';
import { startPaidBuyer } from '@gyblos/buyer/paid-startup';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

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

void test(
  'product pool owner blocks both dedicated paid and free startup before either factory and permits restart after close',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, '200000');
    t.after(host.close);
    await assert.rejects(
      startPaidBuyer({
        port: 0,
        meter: async () => assert.fail('must not load financial meter'),
        chain: async () => assert.fail('must not construct financial backend'),
      }),
      { code: SESSION_CODES.UNAVAILABLE },
    );
    await assert.rejects(
      startFreeBuyer({
        port: 0,
        bind: async () => assert.fail('second owner must not bind'),
      }),
      { code: SESSION_CODES.UNAVAILABLE },
    );
    await host.restartBuyer();
    assert.equal(host.engine.attempts(), 0);
    assert.deepEqual(host.finance.calls, []);
  },
);
