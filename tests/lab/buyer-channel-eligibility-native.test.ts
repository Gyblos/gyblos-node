import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { setBuyerRenewalBudget } from '@gyblos/buyer/auto-settings';
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

void test(
  'a pooled pre-dispatch status refusal releases only its own marker and allows a later request',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost(undefined, '2000000');
    t.after(host.close);
    const { ask } = await buyerClient(host, request);
    assert.equal((await ask(64)).status, 200);
    const original = host.finance.observeChannel;
    let reads = 0;
    host.finance.observeChannel = async (...args) => {
      if (++reads === 2) throw new Error('Synthetic transient observation');
      return original(...args);
    };
    await host.restartBuyer();
    const attempts = host.engine.attempts();
    const calls = [...host.finance.calls];
    const refused = await ask(64);
    assert.equal(
      (await refused.json()).error?.code,
      SESSION_CODES.STATUS_UNKNOWN,
    );
    assert.equal(host.engine.attempts(), attempts);
    assert.deepEqual(host.finance.calls, calls);
    const resumed = await ask(64);
    assert.equal(resumed.status, 200, await resumed.clone().text());
  },
);

void test(
  'a delegated key renews healthy exhausted escrow once under its operator budget across restart',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost(
      undefined,
      undefined,
      undefined,
      undefined,
      { depositAtomic: '10000', renewalBudgetAtomic: '10060' },
    );
    t.after(host.close);
    const { ask } = await buyerClient(host, request, '50000');
    const paths = batchSessionPathsIn(process.env, P2P_ROLES.BUYER);
    const first = await ask(64);
    assert.equal(first.status, 200, await first.clone().text());
    const initial = await inspectBatchSession(paths);
    assert.ok(initial?.snapshot.channelId);
    const configPath = rolePathIn(
      process.env,
      P2P_ROLES.BUYER,
      BUYER_SELECTION.configFile,
    );
    const config = await readFile(configPath, 'utf8');
    const changed: BuyerSelectionConfig = JSON.parse(config);
    assert.ok(changed.session);
    changed.session.withdrawDelaySeconds = 1800;
    await writeFile(configPath, JSON.stringify(changed));
    await host.restartBuyer();
    const mismatch = await ask(64);
    const error = (await mismatch.json()).error;
    assert.equal(error.code, SESSION_CODES.BINDING);
    assert.equal(error[BUYER_API.NEVER_SENT_FIELD], true);
    assert.deepEqual(host.finance.calls, ['deposit']);
    await writeFile(configPath, config);
    await host.restartBuyer();
    for (const balance of [null, '0']) {
      host.finance.walletBalance(balance);
      const unready = await ask(64);
      assert.equal(unready.ok, false);
      assert.equal(
        (await unready.json()).error.code,
        balance === null ? SESSION_CODES.STATUS_UNKNOWN : SESSION_CODES.LIMIT,
      );
      assert.deepEqual(host.finance.calls, ['deposit']);
    }
    host.finance.walletBalance('1000000');
    await host.restartBoth();
    const second = await ask(64);
    assert.equal(second.status, 200, await second.clone().text());
    const renewed = await inspectBatchSession(paths);
    assert.ok(renewed?.snapshot.channelId);
    assert.notEqual(initial.snapshot.channelId, renewed.snapshot.channelId);
    assert.equal(renewed.priorSpentAtomic, initial.snapshot.cumulativeAtomic);
    assert.equal(host.finance.calls.filter((x) => x === 'deposit').length, 2);
    const calls = [...host.finance.calls];
    const rejected = await ask(64);
    assert.equal(rejected.ok, false);
    assert.equal(host.engine.attempts(), 2);
    assert.deepEqual(host.finance.calls, calls);
    await host.stopBuyer();
    const smaller: BuyerSelectionConfig = JSON.parse(config);
    smaller.request.maxAtomic = '1000';
    await writeFile(configPath, JSON.stringify(smaller));
    await setBuyerRenewalBudget(process.env, null);
    await host.restartBoth();
    const remaining = await ask(64);
    assert.equal(remaining.status, 200, await remaining.clone().text());
    assert.equal(host.engine.attempts(), 3);
    assert.deepEqual(host.finance.calls, calls);
  },
);
