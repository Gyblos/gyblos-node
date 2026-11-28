import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { ENGINE_DONE_REASONS, P2P_ROLES } from '@gyblos/protocol/constants';

import { blockTestMeter } from '../support/batch-block-product';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import {
  interruptedFragment,
  interruptedGeneration,
} from '../support/opencode-interruption';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'restarting a delegated buyer charges exactly the finalized signed prefix after a visible cut',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 90000 },
  async (t) => {
    const request = globalThis.fetch;
    const cut = new AbortController();
    let sellerStopped: Promise<unknown> | undefined;
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
          if (dispatches > 1) {
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
          }
          assert.ok(input.signal);
          sellerStopped = once(input.signal, 'abort', {
            signal: AbortSignal.timeout(8000),
          });
          void sellerStopped.catch(() => undefined);
          return interruptedGeneration(input.onText, input.signal);
        },
      },
      undefined,
      { depositAtomic: '10000', renewalBudgetAtomic: '30000' },
    );
    t.after(async () => {
      cut.abort();
      await host.close();
    });
    const { delegated, owner } = await buyerClient(host, request, '10000');
    const url = host.buyer().url;
    const policy = parseBuyerApiPolicy(
      await (await owner(new URL(BUYER_API.STATUS_PATH, url))).json(),
    );
    const status = async () =>
      parseBuyerApiKeysReply(
        await (
          await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
        ).json(),
      ).snapshot;
    const response = await request(url, {
      method: 'POST',
      signal: AbortSignal.any([cut.signal, AbortSignal.timeout(30000)]),
      headers: {
        authorization: 'Bearer ' + delegated,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: policy.model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_completion_tokens: 128,
        stream: true,
      }),
    });
    if (!response.ok) assert.fail(await response.text());
    assert.ok(response.body);
    let bytes = '';
    const reader = response.body.getReader();
    while (!cut.signal.aborted) {
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      bytes += Buffer.from(chunk.value).toString();
      if (bytes.includes(interruptedFragment.trim())) {
        cut.abort();
        break;
      }
    }
    assert.ok(cut.signal.aborted);
    assert.ok(sellerStopped);
    await sellerStopped;
    await host.restartBuyer();
    assert.equal((await status()).blocked, true);
    const stored = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.SELLER),
    );
    assert.ok(stored?.snapshot.channelId);
    const { channelId, cumulativeAtomic } = stored.snapshot;
    assert.equal(cumulativeAtomic, '136');
    host.finance.settled.set(channelId, {
      channelId,
      chargedAtomic: cumulativeAtomic,
      refundedAtomic: String(
        BigInt(stored.terms.depositAtomic) - BigInt(cumulativeAtomic),
      ),
      transaction: 'syntheticConfirmedClose',
    });
    await host.restartBuyer();
    const after = await status();
    assert.equal(after.blocked, false);
    assert.equal(after.keys[0]?.spentAtomic, '136');
    assert.equal(after.keys[0]?.reservedAtomic, '0');
    assert.equal(host.finance.approvals(), 1);
    assert.deepEqual(host.finance.calls, ['deposit']);
    const follow = (content: string) =>
      request(host.buyer().url, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: 'Bearer ' + delegated,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: policy.model,
          messages: [{ role: 'user', content }],
          max_completion_tokens: 128,
          stream: true,
        }),
      });
    const replay = await follow('synthetic');
    assert.notEqual(replay.status, 200);
    await replay.text();
    assert.equal(dispatches, 1);
    await host.restartBuyer();
    const first = await follow('new question');
    let next = first;
    if (first.status === 503) {
      const error = await first.clone().json();
      if (error.error.code === 'NO_SELLER_CANDIDATES') {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, error.error.cooldownUntil - Date.now()) + 100,
          ),
        );
        next = await follow('new question');
      }
    }
    const nextText = await next.text();
    assert.equal(next.status, 200, nextText);
    assert.match(nextText, /done/);
    assert.equal(dispatches, 2);
    assert.equal(
      host.finance.calls.filter((call) => call === 'deposit').length,
      2,
    );
  },
);
