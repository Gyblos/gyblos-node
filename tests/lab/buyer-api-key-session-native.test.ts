// Real product startup, encrypted loopback and durable delegated authority; engine and finance are synthetic.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { BUYER_SELECTION, PAID_BUYER } from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { batchSessionPathsIn, rolePathIn } from '@gyblos/config';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { paidAcceptanceMeter } from '../support/paid-acceptance-engine';
import { sessionProductHost } from '../support/session-product-host';

async function buyerClient(
  host: Awaited<ReturnType<typeof sessionProductHost>>,
  request: typeof fetch,
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
      limitAtomic: '1000',
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const key = parseBuyerApiKeysReply(await created.json()).created;
  assert.ok(key);
  const ask = (maxTokens?: number) =>
    request(host.buyer().url, {
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
  return { ask, owner };
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
    const simultaneous = await Promise.all([ask(64), ask(64)]);
    for (const answer of simultaneous)
      assert.equal(answer.status, 200, await answer.clone().text());
    const final = parseBuyerApiKeysReply(
      await (
        await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
      ).json(),
    ).snapshot;
    assert.equal(final.keys[0]?.reservedAtomic, '0');
    assert.equal(final.blocked, false);
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
