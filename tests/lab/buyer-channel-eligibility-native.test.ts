import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { batchSessionPathsIn, rolePathIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

for (const expired of [false, true])
  void test(
    `a ${expired ? 'clock-expired' : 'finalized'} channel blocks delegated inference before any further deposit or dispatch across restart`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async (t) => {
      const request = globalThis.fetch;
      const host = await sessionProductHost();
      t.after(host.close);
      const { ask, owner } = await buyerClient(host, request);
      const first = await ask(64);
      assert.equal(first.status, 200, await first.clone().text());
      const existing = await inspectBatchSession(
        batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
      );
      assert.ok(existing?.snapshot.channelId);
      const { channelId, cumulativeAtomic } = existing.snapshot;
      if (expired)
        host.advanceChannelClock(existing.terms.expiresAt - Date.now() + 1);
      else
        host.finance.settled.set(channelId, {
          channelId,
          chargedAtomic: cumulativeAtomic,
          refundedAtomic: String(
            BigInt(existing.terms.depositAtomic) - BigInt(cumulativeAtomic),
          ),
          transaction: 'syntheticConfirmedClose',
        });
      const calls = [...host.finance.calls];
      const generations = host.engine.attempts();
      for (const restart of [false, true]) {
        if (restart) await host.restartBuyer();
        const policy = parseBuyerApiPolicy(
          await (
            await owner(new URL(BUYER_API.STATUS_PATH, host.buyer().url))
          ).json(),
        );
        const choice = {
          nodeId: existing.terms.sellerNodeId,
          owner: existing.terms.owner,
          modelId: policy.model,
          variant: null,
          quantization: null,
          contextTokens: 2048,
          expiresAt: Date.now() + 60000,
          inputAtomicPerMtok: '1',
          outputAtomicPerMtok: '1',
        };
        const checked = await owner(
          new URL(BUYER_API.CHANNEL_ELIGIBILITY_PATH, host.buyer().url),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'if-match': '"' + policy.policyId + '"',
            },
            body: JSON.stringify(choice),
          },
        );
        assert.equal(checked.status, 200, await checked.clone().text());
        const eligibility = await checked.json();
        assert.equal(
          eligibility.blocker,
          expired ? SESSION_CODES.EXPIRED : SESSION_CODES.CLOSED,
        );
        const denied = await ask(64);
        assert.equal(denied.status, 400, await denied.clone().text());
        assert.equal(denied.headers.get('x-should-retry'), 'false');
        const reply = await denied.json();
        assert.equal(
          reply.error.code,
          expired ? SESSION_CODES.EXPIRED : SESSION_CODES.CLOSED,
        );
        assert.equal(reply.error[BUYER_API.NEVER_SENT_FIELD], true);
        assert.deepEqual(host.finance.calls, calls);
        assert.equal(host.engine.attempts(), generations);
      }
    },
  );

void test(
  'finality changing after preflight blocks the selected request before renewal and releases only its reservation',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost();
    t.after(host.close);
    const { ask, owner } = await buyerClient(host, request);
    const first = await ask(64);
    assert.equal(first.status, 200, await first.clone().text());
    const existing = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
    );
    assert.ok(existing?.snapshot.channelId);
    const original = host.finance.observeChannel;
    host.finance.observeChannel = async (...args) => {
      const result = await original(...args);
      host.finance.settled.set(args[2], {
        channelId: args[2],
        chargedAtomic: existing.snapshot.cumulativeAtomic,
        refundedAtomic: String(
          BigInt(existing.terms.depositAtomic) -
            BigInt(existing.snapshot.cumulativeAtomic),
        ),
        transaction: 'syntheticConfirmedClose',
      });
      return result;
    };
    await host.restartBuyer();
    const calls = [...host.finance.calls];
    const attempts = host.engine.attempts();
    const denied = await ask(64);
    const reply = await denied.json();
    assert.equal(reply.error?.code, SESSION_CODES.CLOSED);
    assert.equal(denied.status, 400);
    assert.equal(reply.error[BUYER_API.NEVER_SENT_FIELD], true);
    assert.deepEqual(host.finance.calls, calls);
    assert.equal(host.engine.attempts(), attempts);
    const status = parseBuyerApiKeysReply(
      await (
        await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
      ).json(),
    ).snapshot;
    assert.equal(status.blocked, false);
    assert.equal(status.keys[0]?.reservedAtomic, '0');
  },
);

void test(
  'an increased deposit policy cannot silently renew exhausted per-response escrow for the picker or a delegated call',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost();
    t.after(host.close);
    const first = await buyerClient(host, request);
    const accepted = await first.ask(64);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const stored = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
    );
    assert.ok(stored && BigInt(stored.snapshot.cumulativeAtomic) > 0n);
    const path = rolePathIn(
      process.env,
      P2P_ROLES.BUYER,
      BUYER_SELECTION.configFile,
    );
    const config: BuyerSelectionConfig = JSON.parse(
      await readFile(path, 'utf8'),
    );
    assert.ok(config.session);
    config.session.depositAtomic = String(
      2n * BigInt(stored.terms.depositAtomic),
    );
    config.request.maxAtomic = stored.terms.depositAtomic;
    await writeFile(path, JSON.stringify(config));
    await host.restartBuyer();
    const { ask, owner, delegated } = await buyerClient(
      host,
      request,
      stored.terms.depositAtomic,
    );
    const policy = parseBuyerApiPolicy(
      await (
        await owner(new URL(BUYER_API.STATUS_PATH, host.buyer().url))
      ).json(),
    );
    const endpoint = new URL(
      BUYER_API.CHANNEL_ELIGIBILITY_PATH,
      host.buyer().url,
    );
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': '"' + policy.policyId + '"',
      },
      body: JSON.stringify({
        ...config.request.selection,
        nodeId: stored.terms.sellerNodeId,
        owner: stored.terms.owner,
        contextTokens: 2048,
        inputAtomicPerMtok: '1',
        outputAtomicPerMtok: '1',
        expiresAt: Date.now() + 60000,
      }),
    };
    const calls = [...host.finance.calls];
    const attempts = host.engine.attempts();
    const selected = await owner(endpoint, init);
    assert.equal(
      (await selected.json()).blocker,
      SESSION_CODES.REPLACEMENT_REQUIRED,
    );
    const forbidden = await request(endpoint, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + delegated },
    });
    assert.equal(forbidden.status, 403);
    const denied = await ask(64);
    const reply = await denied.json();
    assert.equal(reply.error?.code, SESSION_CODES.REPLACEMENT_REQUIRED);
    assert.equal(reply.error[BUYER_API.NEVER_SENT_FIELD], true);
    assert.deepEqual(host.finance.calls, calls);
    assert.equal(host.engine.attempts(), attempts);
  },
);
