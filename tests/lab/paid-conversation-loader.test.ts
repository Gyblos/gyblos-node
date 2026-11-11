// A deferred buyer-only tokenizer proves HTTP cancellation releases routing before initialization ends.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

import { PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { CONVERSATION } from '../support/batch-conversation';
import { batchDeferred } from '../support/batch-deferred';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { sessionProductHost } from '../support/session-product-host';
import { within } from '../support/test-deadline';

void test(
  'cancelled HTTP history releases routing before a deferred tokenizer and prevents late finance',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const meter: ChatTokenizer = {
      input: () => 3,
      chat: () => 12,
      count: (text) => text.length,
    };
    const entered = batchDeferred<void>();
    const release = batchDeferred<ChatTokenizer>();
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, '200000', {
      meter,
      observe: () => assert.fail('No generation may start'),
      loadMeter: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const abort = new AbortController();
    t.after(async () => {
      abort.abort();
      release.resolve(meter);
      await host.close();
    });
    const token = (
      await readFile(
        rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
        'utf8',
      )
    ).trim();
    const request = fetch(host.buyer().url, {
      method: 'POST',
      signal: abort.signal,
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
    const rejected = assert.rejects(request);
    try {
      await within(
        Promise.race([
          entered.promise,
          request.then(() => assert.fail('Tokenizer phase missing')),
        ]),
        10000,
      );
      abort.abort();
      await rejected;
      const until = Date.now() + 5000;
      let idle = false;
      while (Date.now() < until) {
        try {
          assert.equal(await host.buyer().chat.session!.settle!(), undefined);
          idle = true;
          break;
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error ? error.code : undefined;
          if (code !== SESSION_CODES.BUSY && code !== BUYER_ROUTING_CODES.BUSY)
            throw error;
        }
        await delay(10);
      }
      assert.equal(
        idle,
        true,
        'Cancellation must free routing before the tokenizer resolves',
      );
      assert.equal(host.finance.buyerCreates(), 0);
      assert.equal(host.finance.sellerCreates(), 0);
      assert.deepEqual(host.finance.calls, []);
    } finally {
      abort.abort();
      release.resolve(meter);
      await rejected.catch(() => {});
    }
    await setImmediate();
    assert.equal(host.engine.attempts(), 0);
    assert.equal(host.finance.buyerCreates(), 0);
    assert.equal(host.finance.sellerCreates(), 0);
    assert.deepEqual(host.finance.calls, []);
  },
);
