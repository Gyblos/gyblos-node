import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  executeApiKey,
  executeApiKeySession,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import { FREE_BUYER } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import {
  createBuyerApiKeys,
  type BuyerApiKeyOperation,
} from '@gyblos/node/buyer-api-keys';
import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { BUYER_KEY_CHARGE } from '@gyblos/protocol/buyer-api-keys';
import {
  OPENING_STATUS,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';
import { SELECTION } from './support/buyer-responses';

for (const expires of [false, true]) {
  void test(`pre-inference opening evidence releases only the delegated request when quote expires: ${expires}`, async (t) => {
    let first = true;
    let permission: BuyerApiKeyOperation | undefined;
    const f = await batchPrepareFixture(
      async () => {
        if (first && expires) f.rig.time(f.rig.now() + 30001);
        const absent = first && !expires;
        first = false;
        return absent ? OPENING_STATUS.ABSENT : OPENING_STATUS.PRESENT;
      },
      undefined,
      () => permission?.releaseUnsent,
    );
    t.after(f.close);
    const keys = await createBuyerApiKeys({
      files: { read: async () => undefined, write: async () => {} },
      scope: {
        payer: f.rig.terms.buyer,
        network: f.rig.terms.network,
        mint: f.rig.terms.mint,
      },
    });
    t.after(() => keys.close());
    const key = await keys.create('Synthetic agent', '1000');
    let index = 0;
    const http = await startFreeBuyerHttp(
      async (_input, signal, _delta, _model, current) => {
        assert.ok(current);
        permission = current;
        const quote = await f.offers.quote(++index);
        await reserveApiKey(current, quote);
        const value = await executeApiKeySession(
          current,
          quote.offer.nodeId,
          () => f.buyer.execute(quote, f.offers.input, signal),
        );
        await current.complete(
          f.rig.buyer.snapshot().cumulativeAtomic,
          BUYER_KEY_CHARGE.APPROVED,
        );
        return value;
      },
      { selection: SELECTION, maxTokens: 128 },
      {
        port: 0,
        token: 'synthetic-owner-key',
        apiKeys: keys,
        classify: classifyPaidError,
      },
    );
    t.after(http.close);
    const post = (content: string) =>
      fetch(http.url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key.secret,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: SELECTION.modelId,
          messages: [{ role: 'user', content }],
        }),
      });
    const failed = await post('first synthetic question');
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get(FREE_BUYER.noRetryHeader), null);
    const body = await failed.json();
    if (expires) assert.match(body.error.code, /EXPIRED/);
    else assert.equal(body.error.code, SESSION_CODES.OPENING_ABSENT);
    assert.equal(body.error[BUYER_API.NEVER_SENT_FIELD], true);
    assert.equal(f.offers.generations(), 0);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
    if (expires) {
      const next = await post('new synthetic question');
      assert.equal(next.status, 200);
      assert.equal((await next.json()).choices[0].message.content, 'ok!');
      assert.equal(f.offers.generations(), 1);
      assert.deepEqual(f.rig.calls, ['deposit']);
    }
  });
}

for (const aborted of [false, true]) {
  void test(`the delegated reservation is released when opening observation is interrupted: ${aborted}`, async (t) => {
    const controller = new AbortController();
    let operation: BuyerApiKeyOperation | undefined;
    const f = await batchPrepareFixture(
      async () => {
        if (controller.signal.aborted) return OPENING_STATUS.PRESENT;
        if (aborted) controller.abort();
        return OPENING_STATUS.ABSENT;
      },
      undefined,
      () => operation?.releaseUnsent,
    );
    t.after(f.close);
    let opens = 0;
    if (!aborted)
      f.intercept(async (...args) => {
        if (args[0].method === BATCH_METHODS.OPEN) {
          opens++;
          throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
        }
        return f.service.exchange(...args);
      });
    const keys = await createBuyerApiKeys({
      files: { read: async () => undefined, write: async () => {} },
      scope: {
        payer: f.rig.terms.buyer,
        network: f.rig.terms.network,
        mint: f.rig.terms.mint,
      },
    });
    t.after(() => keys.close());
    const key = await keys.create('Synthetic cancellation', '1000');
    const send = (index: number, signal: AbortSignal) =>
      executeApiKey(keys, key.id, signal, async (active, current) => {
        assert.ok(current);
        operation = current;
        const quote = await f.offers.quote(index);
        await reserveApiKey(current, quote);
        const result = await executeApiKeySession(
          current,
          quote.offer.nodeId,
          () => f.buyer.execute(quote, f.offers.input, active),
        );
        await current.complete(
          f.rig.buyer.snapshot().cumulativeAtomic,
          BUYER_KEY_CHARGE.APPROVED,
        );
        return result;
      });
    if (aborted) await assert.rejects(send(1, controller.signal));
    else {
      await assert.rejects(send(1, controller.signal), {
        code: SESSION_CODES.OPENING_ABSENT,
      });
      assert.equal(opens, 1);
    }
    for (let attempt = 0; attempt < 20 && operation?.reserved(); attempt++)
      await delay(10);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
    assert.equal(f.offers.generations(), 0);
    assert.deepEqual(f.rig.calls, aborted ? ['deposit'] : []);
    if (aborted) {
      assert.equal((await send(2, AbortSignal.timeout(5000))).text, 'ok!');
      assert.equal(f.offers.generations(), 1);
      assert.deepEqual(f.rig.calls, ['deposit']);
    }
  });
}
