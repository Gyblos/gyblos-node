// Product buyer HTTP/chat uses the shared private catalog; financial services and engine are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startBuyer } from '@gyblos/buyer/buyer-main';
import { chatSession } from '@gyblos/buyer/chat-cli';
import { startFreeBuyer } from '@gyblos/buyer/free-startup';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { batchQueryClock } from '../support/batch-query-clock';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { pauseSessionControl } from '../support/session-control-pause';
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
      read: async () => {
        if (++questions > 2) return '/exit';
        await pauseSessionControl();
        return 'synthetic';
      },
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
      read: async () => {
        await pauseSessionControl();
        return ++questions === 1 ? 'synthetic' : '/settle';
      },
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
  'buyer chat settles the existing pool after a saturated session query burst without resending',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const clock = batchQueryClock(t);
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
    await host.restartBuyer();
    questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/settle'),
      write: (text) => {
        output += text;
      },
    });
    assert.ok(clock.refused() > 0, 'The real query bucket must be exhausted.');
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
  'product pool owner blocks both channel and free startup before either factory and permits restart after close',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, '200000');
    t.after(host.close);
    await assert.rejects(
      startBuyer({
        port: 0,
        meter: async () => assert.fail('must not load financial meter'),
        batch: async () => assert.fail('must not construct financial backend'),
      }),
      { code: NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE },
    );
    await assert.rejects(
      startFreeBuyer({
        port: 0,
        bind: async () => assert.fail('second owner must not bind'),
      }),
      { code: NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE },
    );
    await host.restartBuyer();
    assert.equal(host.engine.attempts(), 0);
    assert.deepEqual(host.finance.calls, []);
  },
);
