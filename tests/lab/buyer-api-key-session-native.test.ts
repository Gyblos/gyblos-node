// Real product startup, encrypted loopback and durable delegated authority; engine and finance are synthetic.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { BUYER_SELECTION, PAID_BUYER } from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { batchSessionPathsIn, rolePathIn } from '@gyblos/config';
import { buyerApiKeyPathsIn } from '@gyblos/config/home';
import type { BuyerApiKeyQuote } from '@gyblos/node/buyer-api-keys';
import {
  finalizedKeyCharge,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { paidAcceptanceMeter } from '../support/paid-acceptance-engine';
import { sessionProductHost } from '../support/session-product-host';

async function buyerClient(
  host: Awaited<ReturnType<typeof sessionProductHost>>,
  request: typeof fetch,
  limitAtomic = '1000',
) {
  const token = (
    await readFile(
      rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
      'utf8',
    )
  ).trim();
  const owner = (url: URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', 'Bearer ' + token);
    return request(url, { ...init, headers });
  };
  const metadata = await owner(
    new URL(BUYER_API.STATUS_PATH, host.buyer().url),
  );
  const policy = parseBuyerApiPolicy(await metadata.json());
  const created = await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'if-match': '"' + policy.policyId + '"',
    },
    body: JSON.stringify({
      action: 'create',
      name: 'Synthetic tools',
      limitAtomic,
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const key = parseBuyerApiKeysReply(await created.json()).created;
  assert.ok(key);
  const ask = (maxTokens?: number, signal?: AbortSignal) =>
    request(host.buyer().url, {
      signal,
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key.secret,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: policy.model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_completion_tokens: maxTokens,
      }),
    });
  return { ask, owner, delegated: key.secret };
}

void test(
  'native buyer keys constrain signed session quotes and retain approved usage across a product restart',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const limits: number[] = [];
    const host = await sessionProductHost(undefined, undefined, {
      meter: paidAcceptanceMeter,
      observe: (input) => limits.push(input.maxTokens),
    });
    t.after(host.close);
    const { ask, owner } = await buyerClient(host, request);
    const first = await ask(64);
    assert.equal(first.status, 200, await first.clone().text());
    const firstReply = await first.json();
    assert.equal(firstReply.gyblos_payment.maxAtomic, '1000');
    assert.equal(firstReply.gyblos_payment.chargedAtomic, null);
    const firstUsage = BigInt(firstReply.gyblos_payment.session.approvedAtomic);
    assert.ok(firstUsage > 0n);
    const path = rolePathIn(
      process.env,
      P2P_ROLES.BUYER,
      BUYER_SELECTION.configFile,
    );
    const config: BuyerSelectionConfig = JSON.parse(
      await readFile(path, 'utf8'),
    );
    config.request.maxTokens = 256;
    await writeFile(path, JSON.stringify(config));
    await host.restartBuyer();
    const second = await ask(1024);
    assert.equal(second.status, 200, await second.clone().text());
    const secondReply = await second.json();
    assert.equal(
      secondReply.gyblos_payment.maxAtomic,
      String(1000n - firstUsage),
    );
    const status = await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url));
    const snapshot = parseBuyerApiKeysReply(await status.json()).snapshot;
    const spent =
      firstUsage + BigInt(secondReply.gyblos_payment.session.approvedAtomic);
    assert.equal(snapshot.keys[0]?.spentAtomic, String(spent));
    assert.equal(snapshot.keys[0]?.approvedAtomic, String(spent));
    assert.equal(snapshot.keys[0]?.settledAtomic, '0');
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(snapshot.blocked, false);
    const withoutMaximum = await ask();
    assert.equal(
      withoutMaximum.status,
      200,
      await withoutMaximum.clone().text(),
    );
    assert.deepEqual(limits, [
      64,
      BATCH_CHANNEL.maxOutputTokens,
      BATCH_CHANNEL.maxOutputTokens,
    ]);
    const prior = (await withoutMaximum.json()).gyblos_payment.session
      .approvedAtomic;
    let total = spent + BigInt(prior);
    const simultaneous = await Promise.all([ask(64), ask(64), ask(64)]);
    for (const answer of simultaneous) {
      assert.equal(answer.status, 200, await answer.clone().text());
      const approval = (await answer.json()).gyblos_payment.session;
      assert.ok(BigInt(approval.approvedAtomic) > 0n);
      total += BigInt(approval.approvedAtomic);
    }
    const final = parseBuyerApiKeysReply(
      await (
        await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
      ).json(),
    ).snapshot;
    assert.equal(final.keys[0]?.reservedAtomic, '0');
    assert.equal(final.blocked, false);
    assert.equal(final.keys[0]?.spentAtomic, String(total));
    assert.equal(host.finance.approvals(), 6);
    assert.deepEqual(host.finance.calls, ['deposit']);
  },
);

void test(
  'a restarted single-channel buyer releases only a finalized unsigned request from its delegated key',
  {
    skip: NATIVE_CAPABILITY.transportSkip,
  },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost();
    t.after(host.close);
    const { ask, owner } = await buyerClient(host, request);
    const status = async () =>
      parseBuyerApiKeysReply(
        await (
          await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
        ).json(),
      ).snapshot;
    const first = await ask(64);
    assert.equal(first.status, 200, await first.clone().text());
    const paid = (await first.json()).gyblos_payment.session;
    host.engine.fail(true);
    const broken = await ask(64);
    assert.notEqual(broken.status, 200);
    await host.restartBuyer();
    const before = await status();
    assert.equal(before.blocked, true);
    assert.equal(
      before.keys[0]?.reservedAtomic,
      String(1000n - BigInt(paid.approvedAtomic)),
    );
    const existing = await inspectBatchSession(
      batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
    );
    assert.ok(existing?.snapshot.channelId);
    const channelId = existing.snapshot.channelId;
    const ledger: { pending: BuyerApiKeyQuote[] } = JSON.parse(
      await readFile(buyerApiKeyPathsIn(process.env).state, 'utf8'),
    );
    const [binding] = ledger.pending;
    assert.ok(binding);
    let observations = 0;
    const identity = {
      payer: existing.terms.buyer,
      mint: existing.terms.mint,
      network: existing.terms.network,
    };
    const confirm = (candidate: BuyerApiKeyQuote) =>
      finalizedKeyCharge(
        batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
        candidate,
        identity,
        existing.terms.buyerNodeId,
        async () => {
          observations++;
          return undefined;
        },
      );
    assert.equal(
      await confirm({ ...binding, sellerNodeId: '0'.repeat(64) }),
      undefined,
    );
    assert.equal(
      await confirm({ ...binding, requestId: '0'.repeat(32) }),
      undefined,
    );
    assert.equal(await confirm({ ...binding, maxAtomic: '1' }), undefined);
    assert.equal(observations, 0);
    assert.equal(await confirm(binding), undefined);
    assert.equal(observations, 1);

    host.finance.settled.set(channelId, {
      channelId,
      chargedAtomic: paid.approvedAtomic,
      refundedAtomic: String(100000n - BigInt(paid.approvedAtomic)),
      transaction: 'syntheticConfirmedClose',
    });
    await host.restartBuyer();
    const after = await status();
    assert.equal(after.blocked, false);
    assert.equal(after.keys[0]?.reservedAtomic, '0');
    assert.equal(after.keys[0]?.spentAtomic, paid.approvedAtomic);
  },
);

void test(
  'an overflowing or cancelled single-channel waiter never runs or holds delegated funds',
  {
    skip: NATIVE_CAPABILITY.transportSkip,
  },
  async (t) => {
    const request = globalThis.fetch;
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const host = await sessionProductHost(undefined, undefined, {
      meter: paidAcceptanceMeter,
      observe: ready,
    });
    t.after(host.close);
    const { ask, owner } = await buyerClient(host, request);
    host.engine.hold();
    const active = ask(64);
    try {
      await started;
      const cancel = new AbortController();
      const competing = Array.from({ length: 4 }, () => ask(64, cancel.signal));
      const done = Promise.allSettled(competing);
      const overflow = await Promise.race(competing);
      assert.equal(overflow.status, 429);
      const running = parseBuyerApiKeysReply(
        await (
          await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
        ).json(),
      ).snapshot;
      assert.equal(running.keys[0]?.spentAtomic, '0');
      assert.equal(running.keys[0]?.reservedAtomic, '1000');
      assert.equal(host.engine.attempts(), 1);
      cancel.abort();
      const results = await done;
      assert.equal(
        results.filter((answer) => answer.status === 'rejected').length,
        3,
      );
    } finally {
      host.engine.release();
    }
    const served = await active;
    assert.equal(served.status, 200, await served.clone().text());
    const snapshot = parseBuyerApiKeysReply(
      await (
        await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
      ).json(),
    ).snapshot;
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.finance.approvals(), 1);
  },
);

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
