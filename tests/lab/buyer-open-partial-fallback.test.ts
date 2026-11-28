import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import {
  FREE_CHAT_ROLES,
  MODEL_IDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { acceptanceWait } from '../support/acceptance-wait';
import { HTTP_MULTI_METHODS } from '../support/http-multiseller-constants';
import { httpMultisellerHost } from '../support/http-multiseller-host';
import { httpMultiText } from '../support/http-multiseller-http';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { interruptedFragment } from '../support/opencode-interruption';
import { buyerClient } from '../support/session-product-client';

void test(
  'open paid Auto uses an independently published free seller after a settled interruption and rejects replay',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await httpMultisellerHost(undefined, null, true);
    t.after(host.close);
    const a = host.sellers[0]!;
    const b = host.sellers[1]!;
    const priceA = host.catalogPrices.get(a.role.nodeId);
    const priceB = host.catalogPrices.get(b.role.nodeId);
    assert.ok(priceA && BigInt(priceA.outputAtomicPerMtok) > 0n);
    assert.equal(priceB?.inputAtomicPerMtok, '0');
    assert.equal(priceB?.outputAtomicPerMtok, '0');
    let available = a.role.nodeId;
    const list = host.index.storage.list.bind(host.index.storage);
    host.index.storage.list = async (query) =>
      (await list(query)).filter((row) => row.nodeId === available);
    const { delegated } = await buyerClient(host, request, '100000');
    const ask = (content: string, signal: AbortSignal = host.signal) =>
      request(host.buyer().url, {
        method: 'POST',
        signal,
        headers: {
          authorization: 'Bearer ' + delegated,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_IDS.QWEN3_0_6B,
          messages: [{ role: FREE_CHAT_ROLES.USER, content }],
          max_completion_tokens: 128,
          stream: true,
        }),
      });
    await a.call(HTTP_MULTI_METHODS.HOLD);
    const cut = new AbortController();
    t.after(() => cut.abort());
    const response = await ask(
      'interrupted question',
      AbortSignal.any([host.signal, cut.signal]),
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes(interruptedFragment.trim())) {
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      text += Buffer.from(chunk.value).toString();
    }
    cut.abort();
    await acceptanceWait(
      async () => (await a.health()).cancellations === 1,
      host.signal,
    );
    const record = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
    );
    assert.ok(record?.snapshot.channelId);
    const { channelId, cumulativeAtomic } = record.snapshot;
    assert.ok(BigInt(cumulativeAtomic) > 0n);
    host.ledger.settled.set(channelId, {
      channelId,
      chargedAtomic: cumulativeAtomic,
      refundedAtomic: String(
        BigInt(record.terms.depositAtomic) - BigInt(cumulativeAtomic),
      ),
      transaction: 'syntheticConfirmedClose',
    });
    available = b.role.nodeId;
    const reads = host.index.counts().reads;
    const fresh = await ask('fresh question');
    const answer = await fresh.text();
    assert.equal(fresh.status, 200, answer);
    assert.ok(answer.includes(httpMultiText(1)), answer);
    assert.ok(host.index.counts().reads > reads);
    const replay = await ask('interrupted question');
    assert.ok(!replay.ok);
    assert.match(await replay.text(), new RegExp(SESSION_CODES.STATUS_UNKNOWN));
    assert.equal((await a.health()).generations, 1);
    assert.equal((await b.health()).generations, 1);
    assert.deepEqual(
      host.ledger.calls.map((call) => [call.seller, call.type]),
      [[a.role.nodeId, 'deposit']],
    );
  },
);
