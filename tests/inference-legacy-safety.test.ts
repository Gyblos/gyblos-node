// Individual settlement has no ACK for held calls; tool requests fail before payment on both peers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeBuyerPaid } from '@gyblos/node/buyer-paid-execution';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';
import { recountedMeter } from '@gyblos/node/free-meter';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { INPUT, setup } from './support/buyer-paid';
import { paidSellerFixture } from './support/paid-seller';

const TOOLS = [{ name: 'get_time', parameters: '{"type":"object"}' }];
void test('legacy seller refuses held tool calls before admitting or settling payment', async () => {
  const seller = await paidSellerFixture({
    meter: recountedMeter({
      input: () => 4,
      chat: () => 4,
      count: () => 3,
      output: () => 3,
    }),
  });
  seller.options.engine.supportsTools = () => true;
  const request = await seller.request();
  request.input.tools = TOOLS;
  const { terminal } = await seller.execute(request);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(seller.payment.calls.admit.length, 0);
  assert.equal(seller.payment.calls.settle.length, 0);
  assert.equal(seller.engineCalls.length, 0);
});
void test('legacy buyer refuses tools before any authorization or prompt transmission', async () => {
  const buyer = await setup();
  const meter: ChatTokenizer = {
    input: () => 4,
    chat: () => 4,
    count: () => 3,
    output: () => 3,
  };
  buyer.dependencies.meter = meter;
  await assert.rejects(
    executeBuyerPaid({ ...INPUT, tools: TOOLS }, buyer.dependencies),
    { code: PAID_BUYER_CODES.UNSUPPORTED },
  );
  assert.equal(buyer.calls.authorize.length, 0);
});
