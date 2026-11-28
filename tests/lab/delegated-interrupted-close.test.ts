import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
} from '@gyblos/protocol/constants';

import { blockTestMeter } from '../support/batch-block-product';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { interruptedFragment } from '../support/opencode-interruption';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'the same HTTP key sends a fresh question after a seller cuts an acknowledged response',
  {
    skip: NATIVE_CAPABILITY.transportSkip,
    timeout: 60000,
  },
  async (t) => {
    const request = globalThis.fetch;
    let dispatches = 0;
    const host = await sessionProductHost(
      undefined,
      undefined,
      {
        meter: { ...blockTestMeter, output: blockTestMeter.count },
        contextTokens: 64000,
        maxTokens: 160,
        observe: () => {},
        generate: async (input) => {
          dispatches++;
          if (dispatches === 1) {
            await input.onText?.(interruptedFragment);
            throw new Error(
              'Synthetic generation stopped after acknowledged prefix',
            );
          }
          await input.onText?.('done');
          return {
            text: 'done',
            finishReason: ENGINE_DONE_REASONS.STOP,
            usage: {
              inputTokens: 2,
              outputTokens: 4,
              inputDurationNs: 0,
              outputDurationNs: 0,
              totalDurationNs: 0,
              loadDurationNs: 0,
            },
          };
        },
      },
      undefined,
      { depositAtomic: '10000', renewalBudgetAtomic: '30000' },
    );
    t.after(host.close);
    const { delegated, owner } = await buyerClient(host, request, '10000');
    const url = host.buyer().url;
    const policy = parseBuyerApiPolicy(
      await (await owner(new URL(BUYER_API.STATUS_PATH, url))).json(),
    );
    const ask = (content: string) =>
      request(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + delegated,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: policy.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content }],
          max_completion_tokens: 128,
          stream: true,
        }),
      });
    const first = await ask('first synthetic question');
    assert.equal(first.status, 200);
    assert.match(await first.text(), new RegExp(interruptedFragment.trim()));
    let next = await ask('new synthetic question');
    if (next.status === 503) {
      assert.match(
        await next.text(),
        new RegExp(SELLER_SELECTION_CODES.NO_CANDIDATES),
      );
      assert.equal(dispatches, 1);
      await delay(BUYER_SELECTION.cooldownMs + 100);
      next = await ask('new synthetic question');
    }
    const body = await next.text();
    assert.equal(next.status, 200, body);
    assert.match(body, /done/);
    assert.match(body, /data: \[DONE\]/);
    assert.equal(dispatches, 2);
    assert.equal(
      host.finance.calls.filter((call) => call === 'deposit').length,
      2,
    );
    assert.equal(host.finance.settled.size, 1);
  },
);
