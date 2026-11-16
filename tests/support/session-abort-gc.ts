// Forces collection while the real buyer waits for its tokenizer; only temporary roles and fake finance are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

import { PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import type { ChatTokenizer } from '@gyblos/protocol/engine';

import { CONVERSATION } from './batch-conversation';
import { batchDeferred } from './batch-deferred';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { sessionProductHost } from './session-product-host';
import { within } from './test-deadline';

const collect = globalThis.gc;
assert.ok(collect, 'The isolated cancellation probe requires --expose-gc');
const meter: ChatTokenizer = {
  input: () => 3,
  chat: () => 12,
  count: (text) => text.length,
};
const entered = batchDeferred<void>();
const release = batchDeferred<ChatTokenizer>();
const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, '200000', {
  meter,
  observe: () => assert.fail('A cancelled request must not generate'),
  loadMeter: () => {
    entered.resolve();
    return release.promise;
  },
});
const controller = new AbortController();
try {
  const token = (
    await readFile(
      rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
      'utf8',
    )
  ).trim();
  const pending = fetch(host.buyer().url, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      authorization: `${PAID_BUYER.authScheme} ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_IDS.QWEN3_0_6B,
      messages: CONVERSATION,
      max_tokens: PAID_ACCEPTANCE.maxTokens,
      stream: false,
    }),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  // Attach before forcing collection so the expected failure is always observed.
  void rejected.catch(() => {});
  await within(entered.promise, 10000);
  for (let round = 0; round < 5; round++) {
    await setImmediate();
    collect();
  }
  await setImmediate();
  controller.abort();
  await within(rejected, 1000);
  assert.equal(host.finance.buyerCreates(), 0);
  assert.equal(host.finance.sellerCreates(), 0);
  assert.deepEqual(host.finance.calls, []);
} finally {
  controller.abort();
  release.resolve(meter);
  await host.close();
}
assert.equal(host.engine.attempts(), 0);
assert.equal(host.finance.buyerCreates(), 0);
assert.equal(host.finance.sellerCreates(), 0);
assert.deepEqual(host.finance.calls, []);
console.log('ok');
