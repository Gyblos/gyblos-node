// The reusable paid buyer port must execute the same policy as the compatibility entry.
// All dependencies are synthetic; no wallet, chain, or network is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PAID_BUYER_CODES, PAID_VERDICTS } from '@gyblos/buyer/constants';
import { classifyPaidError } from '@gyblos/buyer/paid-http';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { executeBuyerPaid } from '@gyblos/node/buyer-paid-execution';

import { INPUT, settles, setup } from './support/buyer-paid';

void test('the node paid buyer entry shares the existing implementation and executes it', async () => {
  const entry = '@gyblos/node/buyer-paid-execution';
  assert.doesNotThrow(() => import.meta.resolve(entry));
  const shared = await import(entry);
  const compatibility = await import('@gyblos/buyer/paid-execution');
  assert.equal(shared.executeBuyerPaid, compatibility.executeBuyerPaid);
  assert.equal(shared.executeBuyerPaid, executeBuyerPaid);
  assert.equal(
    classifyPaidError(new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED))?.code,
    PAID_BUYER_CODES.UNSUPPORTED,
  );
  const buyer = await setup();
  buyer.scripts.push(settles('Hi.', '1'));
  const result = await shared.executeBuyerPaid(INPUT, buyer.dependencies);
  assert.equal(result.verdict, PAID_VERDICTS.SETTLED);
  assert.equal(buyer.calls.authorize.length, 1);
  assert.equal(buyer.state.held, 0);
});
