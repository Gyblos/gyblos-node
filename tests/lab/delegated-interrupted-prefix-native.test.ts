import assert from 'node:assert/strict';
import test from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';

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
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 60000 },
  async (t) => {
    const request = globalThis.fetch;
    const cut = new AbortController();
    const host = await sessionProductHost(undefined, undefined, {
      meter: { ...blockTestMeter, output: blockTestMeter.count },
      contextTokens: 64000,
      maxTokens: 160,
      observe: () => {},
      generate: (input) =>
        interruptedGeneration(
          input.onText,
          AbortSignal.any(
            input.signal ? [cut.signal, input.signal] : [cut.signal],
          ),
        ),
    });
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
    assert.equal(response.status, 200);
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
    await host.restartBuyer();
    assert.equal((await status()).blocked, true);
    const stored = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.SELLER),
    );
    assert.ok(stored?.snapshot.channelId);
    const { channelId, cumulativeAtomic } = stored.snapshot;
    assert.ok(BigInt(cumulativeAtomic) > 0n);
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
    assert.equal(after.keys[0]?.spentAtomic, cumulativeAtomic);
    assert.equal(after.keys[0]?.reservedAtomic, '0');
    assert.equal(host.finance.approvals(), 1);
    assert.deepEqual(host.finance.calls, ['deposit']);
  },
);
